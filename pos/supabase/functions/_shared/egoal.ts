// eGoal — Aldar "Invoice-wise Sales" API (https://aldar.egoalprime.com/apidocsv3/option2.html)
//   UAT : https://aldar.egoalprime.com/v2api/api/uat/salestransactioninvoice
//   LIVE: https://aldar.egoalprime.com/v2api/api/salestransactioninvoice
// One POST per shop per business day: header totals + every invoice of that day.
// Auth: static `x-api-key` header (issued by the eGoal technical team).
//
// Secrets:
//   EGOAL_ENV      — "uat" | "live" | "stub". Unset → stub (validates + logs, nothing sent).
//                    Currently configured: uat. Switch to live only after eGoal signs off UAT.
//   EGOAL_API_KEY  — x-api-key (eGoal: same key for UAT and LIVE).
//
// This is the ONLY file that knows eGoal's format.

// ------------------------------------------------------------ request body
// Field rules from the eGoal spec. All money is AED decimal; header totals must equal the
// signed sum of the invoices (RETURN subtracts), except return_amount which is a plain sum.

export type EgoalTransactionType = "SALES" | "RETURN";
/** Retail: "Store" | "Online". (F&B "DineIn"/delivery partners don't apply to us.) */
export type EgoalSalesChannel = "Store" | "Online";

export interface EgoalPaymentMethod {
  /** e.g. "Cash", "Card", "Online" */
  payment_method_name: string;
  payment_amount: number;
}

export interface EgoalTransaction {
  /** required, unique within the payload */
  invoice_no: string;
  /** required, excl. VAT */
  trans_net_sales: number;
  /** required */
  trans_tax_amount: number;
  /** required */
  trans_gross_amount: number;
  /** required (0 for us — prices are bargained) */
  trans_discount_amount: number;
  /** required */
  sales_channel: EgoalSalesChannel | string;
  /** optional, HH:mm:ss 24h, default 00:00:00 */
  transaction_time?: string;
  /** optional, default SALES, case-insensitive */
  transaction_type?: EgoalTransactionType | string;
  /** optional, positive on RETURN, default 0 */
  trans_return_amount?: number;
  /** optional, total items, default 0 */
  quantity?: number;
  /** optional, e.g. "AED" */
  currency?: string;
  /** optional, e.g. "Morning" */
  shift?: string;
  /** optional, default [] (eGoal: structure to be confirmed before go-live) */
  payment_methods?: EgoalPaymentMethod[];
}

/** POST body for /salestransactioninvoice — one outlet, one business day. */
export interface EgoalBody {
  concessionaire_code: string;
  /** store unit, e.g. "FF62" */
  outlet_code: string;
  tenant_code: string;
  /** e.g. "alhamra", "cmsouk" */
  mall_code: string;
  /** YYYY-MM-DD, not in the future */
  transaction_date: string;
  /** must equal transactions.length */
  transaction_count: number;
  net_sales: number;
  gross_amount: number;
  tax_amount: number;
  discount_amount: number;
  return_amount: number;
  transactions: EgoalTransaction[];
}

// ------------------------------------------------------------ response body
// eGoal documents status codes only (201 inserted · 4xx validation failure · 5xx server error),
// NOT a response body. We keep whatever comes back (via asJson): parsed JSON, or { raw: text }
// when it isn't JSON, or null when empty. Tighten this once real UAT responses are in api_logs.
export type EgoalResponse =
  | { message?: string; error?: string; errors?: unknown; raw?: string; [k: string]: unknown }
  | unknown[]
  | string
  | number
  | boolean
  | null;

/** Internal payload built by build_egoal_export() in Postgres. */
export interface InternalPayload {
  business_date: string;
  shop?: { code: string };
  egoal?: {
    concessionaire_code: string | null;
    outlet_code: string | null;
    tenant_code: string | null;
    mall_code: string | null;
  };
  sales: { receipt_no: string; at: string; payment: "cash" | "card"; gross: number; net: number; vat: number; qty: number }[];
}

// Work in integer fils so header totals equal the invoice sums exactly
// (eGoal rejects any mismatch).
const fils = (n: unknown) => Math.round(Number(n || 0) * 100);
const aed = (f: number) => Math.round(f) / 100;

function uaeTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(iso));
}

/** Map our payload to eGoal's request body. Returns null when the shop has no eGoal codes. */
export function toEgoalBody(p: InternalPayload): EgoalBody | null {
  const c = p.egoal;
  if (!c?.concessionaire_code || !c.outlet_code || !c.tenant_code || !c.mall_code) return null;

  const transactions: EgoalTransaction[] = (p.sales ?? []).map((s) => {
    const gross = fils(s.gross);
    return {
      invoice_no: s.receipt_no,
      trans_net_sales: aed(fils(s.net)),
      trans_tax_amount: aed(fils(s.vat)),
      trans_gross_amount: aed(gross),
      trans_discount_amount: 0, // prices are bargained; the final price is what's recorded
      sales_channel: "Store",
      transaction_time: uaeTime(s.at),
      transaction_type: "SALES",
      trans_return_amount: 0,
      quantity: Number(s.qty || 0),
      currency: "AED",
      payment_methods: [{ payment_method_name: s.payment === "card" ? "Card" : "Cash", payment_amount: aed(gross) }],
    };
  });

  const sum = (k: "trans_net_sales" | "trans_tax_amount" | "trans_gross_amount") =>
    aed(transactions.reduce((t, x) => t + fils(x[k]), 0));

  return {
    concessionaire_code: c.concessionaire_code,
    outlet_code: c.outlet_code,
    tenant_code: c.tenant_code,
    mall_code: c.mall_code,
    transaction_date: p.business_date,
    transaction_count: transactions.length,
    net_sales: sum("trans_net_sales"),
    gross_amount: sum("trans_gross_amount"),
    tax_amount: sum("trans_tax_amount"),
    discount_amount: 0,
    return_amount: 0,
    transactions,
  };
}

/** Same checks eGoal applies, so a bad body is caught (and reported) before sending. */
export function validateEgoalBody(b: unknown): string[] {
  const errs: string[] = [];
  if (!b || typeof b !== "object") return ["body must be a JSON object"];
  const x = b as EgoalBody;
  for (const k of ["concessionaire_code", "outlet_code", "tenant_code", "mall_code"] as const) {
    if (!x[k] || typeof x[k] !== "string") errs.push(`${k} is required`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.transaction_date))) errs.push("transaction_date must be YYYY-MM-DD");
  else {
    const todayUae = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
    if (x.transaction_date > todayUae) errs.push("transaction_date must not be in the future");
  }
  if (!Array.isArray(x.transactions)) return [...errs, "transactions must be an array"];

  if (x.transaction_count !== x.transactions.length) errs.push("transaction_count does not match transactions.length");
  const seen = new Set<string>();
  let net = 0, gross = 0, tax = 0, disc = 0, ret = 0;
  x.transactions.forEach((t, i) => {
    if (!t.invoice_no) errs.push(`transactions[${i}].invoice_no is required`);
    else if (seen.has(t.invoice_no)) errs.push(`duplicate invoice_no ${t.invoice_no}`);
    else seen.add(t.invoice_no);
    if (!t.sales_channel) errs.push(`transactions[${i}].sales_channel is required`);
    if (t.transaction_time && !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(t.transaction_time)) {
      errs.push(`transactions[${i}].transaction_time must be HH:mm:ss`);
    }
    const type = String(t.transaction_type ?? "SALES").toUpperCase();
    if (type !== "SALES" && type !== "RETURN") errs.push(`transactions[${i}].transaction_type must be SALES or RETURN`);
    const sign = type === "RETURN" ? -1 : 1;
    net += sign * fils(t.trans_net_sales);
    gross += sign * fils(t.trans_gross_amount);
    tax += sign * fils(t.trans_tax_amount);
    disc += sign * fils(t.trans_discount_amount);
    ret += fils(t.trans_return_amount);
  });
  if (fils(x.net_sales) !== net) errs.push(`net_sales ${x.net_sales} != sum of invoices ${aed(net)}`);
  if (fils(x.gross_amount) !== gross) errs.push(`gross_amount ${x.gross_amount} != sum of invoices ${aed(gross)}`);
  if (fils(x.tax_amount) !== tax) errs.push(`tax_amount ${x.tax_amount} != sum of invoices ${aed(tax)}`);
  if (fils(x.discount_amount) !== disc) errs.push(`discount_amount ${x.discount_amount} != sum of invoices ${aed(disc)}`);
  if (fils(x.return_amount) !== ret) errs.push(`return_amount ${x.return_amount} != sum of invoices ${aed(ret)}`);
  return errs;
}

export interface EgoalCall {
  ok: boolean;
  stub: boolean;
  url: string | null;
  status: number | null; // eGoal HTTP status (201 = inserted)
  responseText: string;
  error: string | null;
  durationMs: number;
  requestHeaders: Record<string, string>;
}

export const EGOAL_URLS = {
  uat: "https://aldar.egoalprime.com/v2api/api/uat/salestransactioninvoice",
  live: "https://aldar.egoalprime.com/v2api/api/salestransactioninvoice",
} as const;

export type EgoalEnv = keyof typeof EGOAL_URLS | "stub";

export function egoalEnv(): EgoalEnv {
  const e = (Deno.env.get("EGOAL_ENV") ?? "stub").trim().toLowerCase();
  return e === "uat" || e === "live" ? e : "stub";
}

export async function postToEgoal(body: EgoalBody): Promise<EgoalCall> {
  const env = egoalEnv();
  const url = env === "stub" ? null : EGOAL_URLS[env];
  const apiKey = Deno.env.get("EGOAL_API_KEY");
  const requestHeaders = { "Content-Type": "application/json", "x-api-key": apiKey ?? "" };
  const t0 = Date.now();
  const base = { url, requestHeaders, responseText: "" };

  if (!url) {
    console.log("[egoal:stub] would send", JSON.stringify(body).slice(0, 800));
    return { ...base, ok: true, stub: true, status: null, error: null, durationMs: 0 };
  }
  if (!apiKey) return { ...base, ok: false, stub: false, status: null, error: "EGOAL_API_KEY secret not set", durationMs: 0 };

  try {
    const res = await fetch(url, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
    const text = await res.text();
    // Docs: 201 Created = inserted; 4xx = validation error; 5xx = server error.
    return {
      ...base, ok: res.ok, stub: false, status: res.status, responseText: text,
      error: res.ok ? null : `HTTP ${res.status}: ${text.slice(0, 500)}`, durationMs: Date.now() - t0,
    };
  } catch (e) {
    return { ...base, ok: false, stub: false, status: null, error: (e as Error).message, durationMs: Date.now() - t0 };
  }
}
