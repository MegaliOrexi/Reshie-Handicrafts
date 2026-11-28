// Supabase Edge Function: egoal-gateway — our own API in front of eGoal.
//
//   POST /functions/v1/egoal-gateway/token
//        { "email": "...", "password": "..." }
//     →  200 { "access_token": "<jwt>", "token_type": "Bearer", "expires_in": 3600 }
//
//   POST /functions/v1/egoal-gateway/sales
//        Authorization: Bearer <access_token>
//        body = eGoal invoice-wise sales body (one shop, one business day),
//               or an ARRAY of such bodies (e.g. a whole month) — forwarded to eGoal as one call
//     →  200 { ok: true, correlation_id, egoal_status, egoal_response }   (eGoal accepted / stub)
//        422 { ok: false, errors: [...] }                                   (failed our pre-checks)
//        4xx/502 { ok: false, error, egoal_status, egoal_response }         (eGoal rejected / unreachable)
//
// Every request + response (ours and eGoal's) is written to api_logs (secrets redacted).
// Every failed upload emails ALERT_EMAIL_TO with the request and response.
//
// Deploy:  supabase functions deploy egoal-gateway --no-verify-jwt
//          (--no-verify-jwt: Supabase must not check the bearer token — we verify our own)
// Secrets: GATEWAY_JWT_SECRET, EGOAL_ENV (uat|live), EGOAL_API_KEY, RESEND_API_KEY, EMAIL_FROM, ALERT_EMAIL_TO
// Clients: select create_api_client('<email>', '<password>');   (SQL editor)

import { adminClient, asJson, headersToObject, logApi, logEvent } from "../_shared/log.ts";
import { signToken, TOKEN_TTL_SECONDS, verifyToken } from "../_shared/jwt.ts";
import { type EgoalBody, egoalEnv, postToEgoal, validateEgoalBody } from "../_shared/egoal.ts";
import { b64, escapeHtml, sendEmail } from "../_shared/email.ts";
import type {
  GatewayError, SalesAccepted, SalesRequest, SalesUpstreamError, SalesValidationError, TokenRequest, TokenResponse,
} from "../_shared/models.ts";

const sb = adminClient();

Deno.serve(async (req) => {
  const correlationId = crypto.randomUUID();
  const t0 = Date.now();
  const url = new URL(req.url);
  const route = url.pathname.replace(/\/+$/, "").split("/").pop();
  const rawBody = await req.text();
  const body = asJson(rawBody);
  let clientId: string | null = null;
  let ref: string | null = null;

  // Every response goes through here so the inbound request/response pair is logged.
  // T = the response model (models.ts); correlation_id is added here.
  const respond = async <T extends { correlation_id: string } = GatewayError>(
    status: number, payload: Omit<T, "correlation_id">, error: string | null = null,
  ) => {
    await logApi(sb, {
      correlation_id: correlationId, direction: "inbound", service: `gateway.${route}`,
      method: req.method, url: url.pathname, request_headers: headersToObject(req.headers),
      request_body: body, response_status: status, response_body: payload,
      duration_ms: Date.now() - t0, error, client_id: clientId, ref,
    });
    return Response.json({ ...payload, correlation_id: correlationId }, { status });
  };

  if (req.method !== "POST") return respond(405, { ok: false, error: "method not allowed" }, "method not allowed");

  // ---------------------------------------------------------------- /token
  if (route === "token") {
    const { email, password } = (body ?? {}) as Partial<TokenRequest>;
    if (!email || !password) return respond(400, { ok: false, error: "email and password are required" }, "missing credentials");

    const { data: id, error } = await sb.rpc("verify_api_client", { p_email: email, p_password: password });
    if (error) return respond(500, { ok: false, error: "auth check failed" }, error.message);
    if (!id) {
      await logEvent(sb, { event: "gateway.login_failed", level: "warn", ref: email, message: `Bad credentials or locked: ${email}` });
      return respond(401, { ok: false, error: "invalid credentials" }, "invalid credentials");
    }
    clientId = id as string;
    try {
      const token = await signToken(clientId, email);
      return respond<TokenResponse>(200, { ok: true, access_token: token, token_type: "Bearer", expires_in: TOKEN_TTL_SECONDS });
    } catch (e) {
      return respond(500, { ok: false, error: "token signing failed" }, (e as Error).message);
    }
  }

  // ---------------------------------------------------------------- /sales
  if (route === "sales") {
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    try {
      clientId = (await verifyToken(token)).clientId;
    } catch {
      return respond(401, { ok: false, error: "invalid or expired token" }, "invalid token");
    }

    // Accepts one day object, or an ARRAY of day objects (e.g. a whole month) sent in one eGoal call.
    // Callers that send their own alerts (egoal-export: email only after repeated failures) pass X-Alert: off.
    const alerts = (req.headers.get("x-alert") ?? "").toLowerCase() !== "off";
    const eg = body as SalesRequest;
    const many = Array.isArray(body) ? (body as EgoalBody[]) : null;
    if (many) {
      const dates = many.map((d) => d?.transaction_date).filter(Boolean).sort();
      ref = `${many[0]?.outlet_code ?? "?"}/${dates[0] ?? "?"}..${dates.at(-1) ?? "?"}`;
    } else {
      ref = eg && typeof eg === "object" ? `${eg.outlet_code ?? "?"}/${eg.transaction_date ?? "?"}` : null;
    }

    const errors = many
      ? (many.length ? many.flatMap((d, i) => validateEgoalBody(d).map((e) => `[${i}] ${d?.transaction_date ?? "?"}: ${e}`)) : ["array is empty"])
      : validateEgoalBody(body);
    if (many) {
      const seen = new Set<string>();
      for (const d of many) {
        const k = `${d?.outlet_code}|${d?.transaction_date}`;
        if (seen.has(k)) errors.push(`duplicate day ${k} in array`);
        seen.add(k);
      }
    }
    if (errors.length) {
      if (alerts) await failureEmail({ ref, body: eg, error: `Rejected before sending: ${errors.join("; ")}`, status: 422, responseText: "" });
      return respond<SalesValidationError>(422, { ok: false, errors }, errors.join("; "));
    }

    // Environment per outlet (EGOAL_LIVE_OUTLETS). X-Egoal-Env: uat forces UAT (test/bulk tools) — it
    // can only downgrade, never promote a UAT outlet to live.
    const outlets = [...new Set((many ?? [eg]).map((d) => d?.outlet_code ?? ""))];
    const envs = [...new Set(outlets.map((o) => egoalEnv(o)))];
    if (envs.length > 1) {
      return respond(422, { ok: false, errors: ["array mixes LIVE and UAT outlets — send them separately"] }, "mixed envs");
    }
    let env = envs[0] ?? egoalEnv();
    if ((req.headers.get("x-egoal-env") ?? "").toLowerCase() === "uat" && env === "live") env = "uat";

    const call = await postToEgoal(many ?? eg, env);
    await logApi(sb, {
      correlation_id: correlationId, direction: "outbound", service: "egoal", method: "POST",
      url: call.url ?? "(stub — EGOAL_ENV not set)", request_headers: call.requestHeaders,
      request_body: eg, response_status: call.status, response_body: asJson(call.responseText),
      duration_ms: call.durationMs, error: call.error, client_id: clientId, ref,
    });

    if (!call.ok) {
      if (alerts) await failureEmail({ ref, body: eg, error: call.error ?? "unknown error", status: call.status, responseText: call.responseText, env });
      const status = call.status && call.status >= 400 && call.status < 500 ? call.status : 502;
      return respond<SalesUpstreamError>(status, {
        ok: false, error: call.error, egoal_env: env, egoal_status: call.status, egoal_response: asJson(call.responseText) as SalesUpstreamError["egoal_response"],
      }, call.error);
    }
    return respond<SalesAccepted>(200, {
      ok: true, stub: call.stub, egoal_env: env, egoal_status: call.status, egoal_response: asJson(call.responseText) as SalesAccepted["egoal_response"],
      invoices: many ? many.reduce((t, d) => t + (d.transaction_count || 0), 0) : eg.transaction_count,
    });
  }

  return respond(404, { ok: false, error: "unknown route — use /token or /sales" }, "unknown route");

  // ----------------------------------------------------------------
  async function failureEmail(f: { ref: string | null; body: EgoalBody; error: string; status: number | null; responseText: string; env?: string }) {
    const envName = (f.env ?? egoalEnv(f.body?.outlet_code)).toUpperCase();
    const tx = Array.isArray(f.body?.transactions) ? f.body.transactions : [];
    const rows = tx.map((t) =>
      `<tr><td>${escapeHtml(t.invoice_no)}</td><td>${escapeHtml(t.transaction_time ?? "")}</td>` +
      `<td style="text-align:right">${escapeHtml(t.trans_gross_amount)}</td></tr>`
    ).join("");
    const reqJson = JSON.stringify(f.body, null, 2);
    const html = `
      <h2 style="color:#b00020">eGoal upload FAILED</h2>
      <p><b>Outlet / date:</b> ${escapeHtml(f.ref)}<br>
         <b>eGoal environment:</b> ${envName}<br>
         <b>HTTP status:</b> ${escapeHtml(f.status ?? "no response")}<br>
         <b>Error:</b> ${escapeHtml(f.error)}<br>
         <b>Correlation id:</b> ${correlationId} (search api_logs)</p>
      <p>${tx.length} invoice(s) in this upload were <b>not</b> accepted by eGoal.
         Failed sales are retried automatically every 10 minutes (up to 10 attempts), and the owner can
         press <b>Retry failed</b> in POS → Reports. To avoid flooding your inbox, further failures for
         this shop and day are not emailed again for the next hour.</p>
      <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse">
        <tr><th>Invoice</th><th>Time</th><th>Gross AED</th></tr>${rows}</table>
      <h3>eGoal response</h3><pre>${escapeHtml(f.responseText || "(none)").slice(0, 5000)}</pre>
      <h3>Request</h3><pre>${escapeHtml(reqJson.slice(0, 15000))}</pre>`;
    await sendEmail(sb, {
      kind: "egoal.failure", ref: f.ref ?? undefined, dedupeMinutes: 60,
      subject: `⚠ eGoal ${envName} upload FAILED — ${f.ref} (${f.status ?? "no response"})`,
      html,
      text: `eGoal upload failed for ${f.ref}: ${f.error}. ${tx.length} invoice(s). Correlation id ${correlationId}.`,
      attachments: [
        { filename: "request.json", content: b64(reqJson) },
        { filename: "response.txt", content: b64(f.responseText || "") },
      ],
    });
    await logEvent(sb, {
      event: "egoal.failed", level: "error", ref: f.ref,
      message: f.error, data: { correlation_id: correlationId, status: f.status, invoices: tx.map((t) => t.invoice_no) },
    });
  }
});
