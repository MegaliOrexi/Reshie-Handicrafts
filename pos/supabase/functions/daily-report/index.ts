// Supabase Edge Function: daily-report — sales emails to ALERT_EMAIL_TO, ONE EMAIL PER SHOP.
//
//   Daily   (pg_cron 06:00 UAE):   POST {}                       → yesterday's sales, per shop:
//           every invoice, totals, cash reconciliation, eGoal upload status. CSV attached.
//   Monthly (pg_cron 06:05 UAE):   POST {"period":"month"}       → only does anything on the 1st (UAE):
//           the previous month per shop: day-by-day table, totals, eGoal status. CSV of every invoice.
//
// Manual (service-role key):  {"date":"YYYY-MM-DD"}   or   {"period":"month","month":"YYYY-MM"}
//                             add "shop":"RAK" to send for one shop only.
// Deploy:  supabase functions deploy daily-report --no-verify-jwt

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { adminClient, isServiceCall, logEvent, uaeYesterday } from "../_shared/log.ts";
import { b64, escapeHtml as h, sendEmail } from "../_shared/email.ts";

const money = (n: unknown) => Number(n || 0).toFixed(2);
const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const uaeToday = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const lastDayOf = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};
const monthName = (ym: string) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

// deno-lint-ignore no-explicit-any
type Sale = any;

/** All sales of one shop between two business dates (paged past the 1000-row API limit). */
async function salesFor(sb: SupabaseClient, shopId: string, from: string, to: string): Promise<Sale[]> {
  const out: Sale[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await sb.from("sales")
      .select("receipt_no, receipt_seq, created_at, payment_method, gross_total, net_total, vat_total, egoal_status, egoal_error, profiles:cashier_id(full_name, email), sale_items(item_name, variation_code, note, qty, line_gross), cash_sessions!inner(business_date)")
      .eq("shop_id", shopId)
      .gte("cash_sessions.business_date", from).lte("cash_sessions.business_date", to)
      .order("created_at").range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

function totals(list: Sale[]) {
  const t = { count: list.length, gross: 0, net: 0, vat: 0, cash: 0, card: 0, sent: 0, failed: 0, other: 0 };
  for (const s of list) {
    t.gross += Number(s.gross_total); t.net += Number(s.net_total); t.vat += Number(s.vat_total);
    if (s.payment_method === "cash") t.cash += Number(s.gross_total); else t.card += Number(s.gross_total);
    if (s.egoal_status === "sent") t.sent++; else if (s.egoal_status === "failed") t.failed++; else t.other++;
  }
  return t;
}

const egoalLine = (t: ReturnType<typeof totals>) =>
  t.count === 0 ? "eGoal: nothing to upload" :
  `eGoal: <b>${t.sent}</b> uploaded` +
  (t.failed ? ` · <b style="color:#b00020">${t.failed} FAILED</b> (retry in POS → Reports)` : "") +
  (t.other ? ` · ${t.other} pending/skipped` : "");

const cashierOf = (s: Sale) => s.profiles?.full_name || s.profiles?.email || "";
const timeOf = (s: Sale) => new Date(s.created_at).toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai", hour12: false });
const itemsOf = (s: Sale) => (s.sale_items ?? []).map((i: Sale) => `${i.item_name}${i.note ? ` (${i.note})` : ""} ${i.variation_code} ×${i.qty}`).join(", ");

function invoiceCsv(shopCode: string, list: Sale[]) {
  const lines = [["business_date", "shop", "receipt_no", "time", "cashier", "payment", "items", "net", "vat", "gross", "egoal"].join(",")];
  for (const s of list) {
    lines.push([s.cash_sessions.business_date, shopCode, s.receipt_no, timeOf(s), cashierOf(s), s.payment_method,
      itemsOf(s), s.net_total, s.vat_total, s.gross_total, s.egoal_status].map(csvCell).join(","));
  }
  return lines.join("\n");
}

Deno.serve(async (req) => {
  if (!isServiceCall(req)) return new Response("unauthorized", { status: 401 });
  const sb = adminClient();

  let b: { date?: string; period?: string; month?: string; shop?: string } = {};
  try { b = (await req.json()) ?? {}; } catch (_) { /* defaults */ }
  const monthly = b.period === "month";

  let from: string, to: string, label: string, kind: string;
  if (monthly) {
    if (!b.month && uaeToday().slice(8) !== "01") return Response.json({ ok: true, skipped: "not the 1st of the month" });
    const ym = b.month ?? uaeYesterday().slice(0, 7); // on the 1st, yesterday is in last month
    from = `${ym}-01`; to = lastDayOf(ym); label = monthName(ym); kind = "report.monthly";
  } else {
    from = to = b.date ?? uaeYesterday(); label = from; kind = "report.daily";
  }

  let shopsQ = sb.from("shops").select("id, code, name").eq("active", true).order("code");
  if (b.shop) shopsQ = shopsQ.eq("code", b.shop);
  const { data: shops, error: shopErr } = await shopsQ;
  if (shopErr) return Response.json({ ok: false, error: shopErr.message }, { status: 500 });

  const sent: Array<Record<string, unknown>> = [];
  for (const shop of shops ?? []) {
    try {
      const [list, sessionsQ] = await Promise.all([
        salesFor(sb, shop.id, from, to),
        sb.from("cash_sessions").select("business_date, opening_cash, closing_cash, closed_at")
          .eq("shop_id", shop.id).gte("business_date", from).lte("business_date", to).order("business_date"),
      ]);
      const sessions = sessionsQ.data ?? [];
      const t = totals(list);
      const head = `<h2 style="margin-bottom:4px">${h(shop.code)} — ${h(shop.name)}</h2>
        <h3 style="margin-top:0">${monthly ? "Monthly" : "Daily"} sales · ${h(label)}</h3>
        <p>${t.count} invoice(s) · Total <b>AED ${money(t.gross)}</b> · Net ${money(t.net)} · VAT 5% ${money(t.vat)}<br>
           Cash ${money(t.cash)} · Card ${money(t.card)}<br>${egoalLine(t)}</p>`;

      let bodyHtml: string;
      if (monthly) {
        const days: string[] = [];
        for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
          days.push(d.toISOString().slice(0, 10));
        }
        const rows = days.map((day) => {
          const dt = totals(list.filter((s) => s.cash_sessions.business_date === day));
          const ses = sessions.find((s) => s.business_date === day);
          if (!ses && !dt.count) return `<tr style="color:#999"><td>${day}</td><td colspan="7">closed / not opened</td></tr>`;
          return `<tr><td>${day}</td><td align="right">${dt.count}</td><td align="right">${money(dt.net)}</td>
            <td align="right">${money(dt.vat)}</td><td align="right"><b>${money(dt.gross)}</b></td>
            <td align="right">${money(dt.cash)}</td><td align="right">${money(dt.card)}</td>
            <td>${dt.failed ? `<b style="color:#b00020">${dt.failed} failed</b>` : dt.count ? "ok" : ""}</td></tr>`;
        }).join("");
        bodyHtml = `<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:13px">
          <tr><th>Date</th><th>Invoices</th><th>Net</th><th>VAT</th><th>Total AED</th><th>Cash</th><th>Card</th><th>eGoal</th></tr>
          ${rows}
          <tr><th>Total</th><th align="right">${t.count}</th><th align="right">${money(t.net)}</th><th align="right">${money(t.vat)}</th>
          <th align="right">${money(t.gross)}</th><th align="right">${money(t.cash)}</th><th align="right">${money(t.card)}</th><th></th></tr></table>`;
      } else {
        const ses = sessions[0];
        const expected = ses ? Number(ses.opening_cash) + t.cash : null;
        const variance = ses?.closing_cash != null && expected != null ? Number(ses.closing_cash) - expected : null;
        const cashLine = ses
          ? `Opening cash ${money(ses.opening_cash)} · Expected in drawer ${money(expected)} · Counted ${ses.closing_cash != null ? money(ses.closing_cash) : "<b>day not closed</b>"}${variance != null ? ` · Variance <b>${money(variance)}</b>` : ""}`
          : "<b>Day was not opened</b>";
        const rows = list.map((s) => `<tr><td>${h(s.receipt_no)}</td><td>${h(timeOf(s))}</td><td>${h(cashierOf(s))}</td>
          <td>${h(itemsOf(s))}</td><td>${h(String(s.payment_method).toUpperCase())}</td><td align="right">${money(s.gross_total)}</td>
          <td>${s.egoal_status === "failed" ? `<b style="color:#b00020">failed</b>` : h(s.egoal_status)}</td></tr>`).join("");
        bodyHtml = `<p>${cashLine}</p>` + (list.length
          ? `<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:13px">
             <tr><th>Receipt</th><th>Time</th><th>Cashier</th><th>Items</th><th>Pay</th><th>Total AED</th><th>eGoal</th></tr>${rows}</table>`
          : "<p>No sales.</p>");
      }

      const file = monthly ? `reshie-${shop.code}-${from.slice(0, 7)}.csv` : `reshie-${shop.code}-${from}.csv`;
      const result = await sendEmail(sb, {
        kind, ref: `${shop.code}/${monthly ? from.slice(0, 7) : from}`,
        subject: `Reshie ${shop.code} ${monthly ? "monthly" : "daily"} sales ${label} — ${t.count} invoice(s), AED ${money(t.gross)}${t.failed ? ` — ⚠ ${t.failed} eGoal failed` : ""}`,
        html: `<div style="font-family:Arial,sans-serif">${head}${bodyHtml}
          <p style="color:#666;font-size:12px">Every invoice attached as CSV. Sent automatically by Reshie POS.</p></div>`,
        text: `${shop.code} ${monthly ? "monthly" : "daily"} sales ${label}: ${t.count} invoice(s), AED ${money(t.gross)}. See attached CSV.`,
        attachments: [{ filename: file, content: b64(invoiceCsv(shop.code, list)) }],
      });
      await logEvent(sb, {
        event: result.ok ? `${kind}_sent` : `${kind}_failed`, level: result.ok ? "info" : "error",
        shop_id: shop.id, ref: `${shop.code}/${label}`, message: result.error ?? `${t.count} invoices`,
      });
      sent.push({ shop: shop.code, ok: result.ok, invoices: t.count, gross: money(t.gross), error: result.error });
    } catch (e) {
      await logEvent(sb, { event: `${kind}_failed`, level: "error", shop_id: shop.id, ref: `${shop.code}/${label}`, message: (e as Error).message });
      sent.push({ shop: shop.code, ok: false, error: (e as Error).message });
    }
  }
  return Response.json({ ok: sent.every((s) => s.ok), period: monthly ? "month" : "day", from, to, shops: sent });
});
