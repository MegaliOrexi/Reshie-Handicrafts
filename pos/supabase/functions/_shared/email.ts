// Email via Resend (https://resend.com — free tier: 3,000/month, 100/day).
// Secrets:
//   RESEND_API_KEY  — required; without it emails are skipped (and logged as skipped).
//   EMAIL_FROM      — e.g. "Reshie POS <pos@reshiehandicrafts.com>" (domain verified in Resend).
//                     Default "onboarding@resend.dev" only delivers to the Resend account's own address.
//   ALERT_EMAIL_TO  — comma-separated recipients. Default: reshiehandicrafts@gmail.com
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { asJson, logApi, logEvent } from "./log.ts";

export interface Attachment {
  filename: string;
  content: string; // base64
}

export interface EmailInput {
  subject: string;
  html: string;
  text?: string;
  attachments?: Attachment[];
  kind: string; // what the email is for, e.g. "egoal.failure", "report.daily"
  ref?: string;
  /** Skip if an email of the same kind was already sent within this many minutes (anti-spam). */
  dedupeMinutes?: number;
}

const RESEND_URL = "https://api.resend.com/emails";

export async function sendEmail(sb: SupabaseClient, e: EmailInput): Promise<{ ok: boolean; error?: string }> {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM") ?? "Reshie POS <onboarding@resend.dev>";
  const to = (Deno.env.get("ALERT_EMAIL_TO") ?? "reshiehandicrafts@gmail.com")
    .split(",").map((s) => s.trim()).filter(Boolean);

  if (e.dedupeMinutes) {
    const since = new Date(Date.now() - e.dedupeMinutes * 60_000).toISOString();
    let q = sb.from("event_logs").select("id", { count: "exact", head: true })
      .eq("event", "email.sent").eq("data->>kind", e.kind).gte("created_at", since);
    if (e.ref) q = q.eq("ref", e.ref);
    const { count } = await q;
    if (count) return { ok: true, error: "deduped" };
  }

  if (!key) {
    await logEvent(sb, {
      event: "email.skipped", level: "warn", ref: e.ref,
      message: `RESEND_API_KEY not set — email not sent: ${e.subject}`, data: { kind: e.kind, to },
    });
    return { ok: false, error: "RESEND_API_KEY not set" };
  }

  const body = { from, to, subject: e.subject, html: e.html, text: e.text, attachments: e.attachments };
  // Log the email without attachment contents (could be large)
  const loggedBody = {
    ...body, html: `[${e.html.length} chars]`,
    attachments: e.attachments?.map((a) => ({ filename: a.filename, bytes: a.content.length })),
  };

  const t0 = Date.now();
  let status: number | null = null;
  let text = "";
  let error: string | null = null;
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    status = res.status;
    text = await res.text();
    if (!res.ok) error = `HTTP ${res.status}: ${text.slice(0, 300)}`;
  } catch (err) {
    error = (err as Error).message;
  }

  await logApi(sb, {
    direction: "outbound", service: "email", method: "POST", url: RESEND_URL,
    request_body: loggedBody, response_status: status, response_body: asJson(text),
    duration_ms: Date.now() - t0, error, ref: e.ref,
  });
  await logEvent(sb, {
    event: error ? "email.failed" : "email.sent", level: error ? "error" : "info", ref: e.ref,
    message: `${e.subject}${error ? ` — ${error}` : ""}`, data: { kind: e.kind, to },
  });
  return error ? { ok: false, error } : { ok: true };
}

export const escapeHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Base64 of a UTF-8 string (for attachments). */
export function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
