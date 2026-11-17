// Supabase Edge Function: egoal-export — sends sales to eGoal, ONE SALE PER UPLOAD, in real time.
//
// Callers:
//   • The till, right after a sale is confirmed:   POST {"sale_id": "<uuid>"}   (staff user's JWT)
//   • The owner's "Retry failed" button (Reports):  POST {"shop_id": "<uuid>"}   (owner's JWT)
//   • pg_cron every 10 minutes (see cron.sql):      POST {}                      (service_role key)
//       → retries sales still pending after 2 min (till lost signal), failed ones (< 10 attempts),
//         and ones stuck "sending" for 5 min.
//
// For each claimed sale (claim_egoal_sales = row lock, so no double posting):
//   egoal_sale_payload → toEgoalBody (one invoice; header totals = that invoice)
//   → egoal-gateway /token (email + password) → /sales (Bearer) → eGoal
// The result is stored on the sale (egoal_status / egoal_error / egoal_sent_at) + event_logs.
// The gateway logs every request/response in api_logs and emails ALERT_EMAIL_TO on failure.
//
// Deploy:  supabase functions deploy egoal-export --no-verify-jwt   (we check the caller ourselves)
// Secrets: GATEWAY_CLIENT_EMAIL, GATEWAY_CLIENT_PASSWORD (an api_clients login)

import { createClient } from "npm:@supabase/supabase-js@2";
import { adminClient, isServiceCall, logEvent } from "../_shared/log.ts";
import { type InternalPayload, toEgoalBody } from "../_shared/egoal.ts";
import { escapeHtml, sendEmail } from "../_shared/email.ts";

const GATEWAY = `${Deno.env.get("SUPABASE_URL")}/functions/v1/egoal-gateway`;
const MAX_ATTEMPTS = 10;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = adminClient();

  let body: { sale_id?: string; shop_id?: string } = {};
  try {
    body = (await req.json()) ?? {};
  } catch (_) { /* empty body = retry job */ }

  // ------------------------------------------------------------ who is calling?
  let claimArgs: Record<string, unknown>;
  if (isServiceCall(req)) {
    claimArgs = body.sale_id ? { p_sale_id: body.sale_id } : body.shop_id ? { p_shop_id: body.shop_id } : { p_max_attempts: MAX_ATTEMPTS };
  } else {
    // A logged-in POS user. Use THEIR token so RLS decides what they may touch.
    const auth = req.headers.get("Authorization") ?? "";
    const userDb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } }, auth: { persistSession: false },
    });
    const { data: u } = await userDb.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "unauthorized" }, 401);

    if (body.sale_id) {
      const { data: sale } = await userDb.from("sales").select("id").eq("id", body.sale_id).maybeSingle();
      if (!sale) return json({ ok: false, error: "sale not found" }, 404); // not theirs (RLS) or no such sale
      claimArgs = { p_sale_id: body.sale_id };
    } else if (body.shop_id) {
      const { data: owner } = await userDb.rpc("is_owner");
      if (!owner) return json({ ok: false, error: "owner only" }, 403);
      claimArgs = { p_shop_id: body.shop_id };
    } else {
      return json({ ok: false, error: "sale_id or shop_id required" }, 400);
    }
  }

  const { data: claimed, error: claimErr } = await sb.rpc("claim_egoal_sales", claimArgs);
  if (claimErr) return json({ ok: false, step: "claim", error: claimErr.message }, 500);
  if (!claimed?.length) return json({ ok: true, processed: 0, results: [] });

  // ------------------------------------------------------------ build bodies
  const rows: Array<{ id: string; shop_id: string; receipt_no: string; attempts: number; body: ReturnType<typeof toEgoalBody>; ref: string }> = [];
  for (const s of claimed) {
    const { data: payload } = await sb.rpc("egoal_sale_payload", { p_sale_id: s.id });
    const p = payload as InternalPayload | null;
    rows.push({
      id: s.id, shop_id: s.shop_id, receipt_no: s.receipt_no, attempts: s.egoal_attempts + 1,
      body: p ? toEgoalBody(p) : null, ref: `${p?.shop?.code ?? "?"}/${p?.business_date ?? "?"}/${s.receipt_no}`,
    });
  }

  // ------------------------------------------------------------ gateway token (once per run)
  let token: string | null = null;
  let tokenError: string | null = null;
  if (rows.some((r) => r.body)) {
    try {
      const res = await fetch(`${GATEWAY}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: Deno.env.get("GATEWAY_CLIENT_EMAIL"), password: Deno.env.get("GATEWAY_CLIENT_PASSWORD") }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.access_token) token = j.access_token;
      else tokenError = `token endpoint HTTP ${res.status}: ${j.error ?? "no token"}`;
    } catch (e) {
      tokenError = `token endpoint unreachable: ${(e as Error).message}`;
    }
    if (tokenError) {
      await logEvent(sb, { event: "egoal.token_failed", level: "error", message: tokenError });
      await sendEmail(sb, {
        kind: "egoal.failure", ref: "gateway-token", dedupeMinutes: 60,
        subject: "⚠ eGoal upload FAILED — could not get gateway token",
        html: `<h2 style="color:#b00020">eGoal upload FAILED</h2><p>${escapeHtml(tokenError)}</p>
               <p>${rows.length} sale(s) were not uploaded: ${rows.map((r) => escapeHtml(r.receipt_no)).join(", ")}.
               Check GATEWAY_CLIENT_EMAIL / GATEWAY_CLIENT_PASSWORD and the api_clients table.
               Failed sales are retried every 10 minutes. (Not emailed again for 1 hour.)</p>`,
      });
    }
  }

  // ------------------------------------------------------------ send each sale
  const results: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    let patch: Record<string, unknown>;
    if (!row.body) {
      patch = { egoal_status: "skipped", egoal_attempts: row.attempts, egoal_error: "shop has no eGoal codes" };
    } else if (!token) {
      patch = { egoal_status: "failed", egoal_attempts: row.attempts, egoal_error: tokenError };
    } else {
      let status = 0;
      let j: Record<string, unknown> = {};
      try {
        const res = await fetch(`${GATEWAY}/sales`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(row.body),
        });
        status = res.status;
        j = await res.json().catch(() => ({}));
      } catch (e) {
        j = { error: `gateway unreachable: ${(e as Error).message}` };
      }
      if (status === 200 && j.ok) {
        patch = {
          egoal_status: "sent", egoal_sent_at: new Date().toISOString(), egoal_attempts: row.attempts,
          egoal_error: j.stub ? "stub mode: EGOAL_ENV not set, nothing sent" : j.egoal_env === "uat" ? "sent to UAT (test), not LIVE" : null,
        };
      } else {
        const err = (j.errors as string[] | undefined)?.join("; ") ?? (j.error as string | undefined) ?? `HTTP ${status}`;
        patch = { egoal_status: "failed", egoal_attempts: row.attempts, egoal_error: `${err} (correlation ${j.correlation_id ?? "?"})` };
      }
    }

    await sb.from("sales").update(patch).eq("id", row.id);
    await logEvent(sb, {
      event: `egoal.sale.${patch.egoal_status}`, level: patch.egoal_status === "failed" ? "error" : "info",
      shop_id: row.shop_id, ref: row.ref, message: (patch.egoal_error as string) ?? `Uploaded ${row.receipt_no}`,
      data: { sale_id: row.id, attempts: row.attempts },
    });
    results.push({ sale_id: row.id, receipt_no: row.receipt_no, ...patch });
  }

  return json({ ok: true, processed: results.length, results });
});
