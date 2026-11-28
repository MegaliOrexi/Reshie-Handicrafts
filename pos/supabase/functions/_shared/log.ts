// Logging helpers for Edge Functions. Writes to api_logs / event_logs with the
// service-role client. Logging must never break the main flow, so every write
// swallows its own errors.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

const SECRET_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|cookie/i;

/** Deep copy with secret-looking fields replaced by "[REDACTED]". */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redact(v);
    }
    return out as T;
  }
  return value;
}

export function headersToObject(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => (o[k] = v));
  return o;
}

/** JSON if parseable, otherwise wrapped as { raw: text } (jsonb column). */
export function asJson(text: string | null | undefined): unknown {
  if (text == null || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 20000) };
  }
}

export interface ApiLog {
  correlation_id?: string;
  direction: "inbound" | "outbound";
  service: string;
  method?: string;
  url?: string;
  request_headers?: unknown;
  request_body?: unknown;
  response_status?: number | null;
  response_body?: unknown;
  duration_ms?: number;
  error?: string | null;
  client_id?: string | null;
  ref?: string | null;
}

export async function logApi(sb: SupabaseClient, row: ApiLog) {
  const { error } = await sb.from("api_logs").insert({
    ...row,
    request_headers: redact(row.request_headers ?? null),
    request_body: redact(row.request_body ?? null),
    response_body: redact(row.response_body ?? null),
  });
  if (error) console.error("[log] api_logs insert failed:", error.message);
}

export interface EventLog {
  event: string;
  level?: "info" | "warn" | "error";
  shop_id?: string | null;
  ref?: string | null;
  message?: string;
  data?: unknown;
}

export async function logEvent(sb: SupabaseClient, row: EventLog) {
  const { error } = await sb.from("event_logs").insert({ level: "info", ...row, data: redact(row.data ?? null) });
  if (error) console.error("[log] event_logs insert failed:", error.message);
}

/** Yesterday's business date in UAE time (UTC+4, no DST) as YYYY-MM-DD. */
export function uaeYesterday(): string {
  return new Date(Date.now() + 4 * 3600_000 - 86400_000).toISOString().slice(0, 10);
}

/** Cron / internal callers authenticate with the service-role key. */
/** Trusted server-side caller: the service_role key, or pg_cron's X-Cron-Secret (CRON_SECRET, kept in
 *  Supabase secrets + Vault — so the cron jobs never need the service_role key). */
export function isServiceCall(req: Request): boolean {
  if ((req.headers.get("Authorization") ?? "") === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) return true;
  const cron = Deno.env.get("CRON_SECRET") ?? "";
  return cron.length >= 32 && (req.headers.get("x-cron-secret") ?? "") === cron;
}
