// The variation code is a private internal tag — it must NEVER appear on the customer receipt.
// Builds the receipt as a standalone HTML document (used for QZ Tray + browser print + preview).
import { getSettings } from './settings'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const money = (n) => Number(n || 0).toFixed(2)

export function receiptHtml({ sale, items, shop, cashierName }) {
  const { paperWidthMm } = getSettings()
  const width = (paperWidthMm || 80) - 6
  const when = new Date(sale.created_at)
  const dateStr = when.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', hour12: false })

  const lines = items
    .map(
      (li) => `
      <tr class="line">
        <td colspan="3">${esc(li.item_name)}</td>
      </tr>
      <tr class="sub">
        <td>${li.qty} x ${money(li.unit_price)}</td>
        <td></td>
        <td class="r">${money(li.line_gross)}</td>
      </tr>`,
    )
    .join('')

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(sale.receipt_no)}</title>
<style>
  /* Screen (preview iframe) + QZ Tray: a centred roll-width receipt. */
  @page { margin: 4mm; }
  * { box-sizing: border-box; }
  html { background: #fff; }
  body { margin: 0 auto; padding: 3mm; width: ${width}mm; max-width: 100%; font-family: "Courier New", Courier, monospace; font-size: 11px; color: #000; }
  .c { text-align: center; } .r { text-align: right; }
  h1 { font-size: 15px; margin: 0 0 2px; letter-spacing: .5px; }
  .muted { font-size: 10px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 5px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  tr.line td { padding-top: 3px; font-weight: bold; }
  .totals td { padding: 1px 0; }
  .grand td { font-size: 14px; font-weight: bold; padding-top: 3px; }
  .meta td { font-size: 10px; }
  .foot { margin-top: 6px; font-size: 10px; }
  /* Browser print: use the full width of whatever paper the printer has (roll or A4). */
  @media print {
    body { width: auto; max-width: none; padding: 0; }
  }
  /* Full-size sheet (A4/Letter): scale the text up so it fills the page instead of a corner. */
  @media print and (min-width: 120mm) {
    body { font-size: 17px; }
    h1 { font-size: 28px; margin-bottom: 6px; }
    .muted, .meta td, .foot { font-size: 15px; }
    .grand td { font-size: 22px; padding-top: 8px; }
    td { padding: 4px 0; }
    tr.line td { padding-top: 8px; }
    hr { margin: 12px 0; }
  }
</style></head>
<body>
  <div class="c">
    <h1>RESHIE HANDICRAFTS</h1>
    <div class="muted">Reshie Antiques &amp; Gifts</div>
    <div class="muted">${esc(shop.location)}</div>
    ${shop.address ? `<div class="muted">${esc(shop.address)}</div>` : ''}
    ${shop.phone ? `<div class="muted">Tel: ${esc(shop.phone)}</div>` : ''}
    <div class="muted"><b>TRN: ${esc(shop.trn || 'TRN-PENDING')}</b></div>
  </div>
  <hr>
  <div class="c"><b>TAX INVOICE</b></div>
  <table class="meta">
    <tr><td>Receipt</td><td class="r"><b>${esc(sale.receipt_no)}</b></td></tr>
    <tr><td>Date</td><td class="r">${esc(dateStr)}</td></tr>
    <tr><td>Cashier</td><td class="r">${esc(cashierName || '')}</td></tr>
    <tr><td>Payment</td><td class="r">${esc(String(sale.payment_method).toUpperCase())}</td></tr>
  </table>
  <hr>
  <table>${lines}</table>
  <hr>
  <table class="totals">
    <tr><td>Net (excl. VAT)</td><td class="r">${money(sale.net_total)}</td></tr>
    <tr><td>VAT 5%</td><td class="r">${money(sale.vat_total)}</td></tr>
    <tr class="grand"><td>TOTAL AED</td><td class="r">${money(sale.gross_total)}</td></tr>
  </table>
  <hr>
  <div class="c foot">
    Prices include 5% VAT.<br>
    ${shop.receipt_footer ? esc(shop.receipt_footer) + '<br>' : ''}
    Thank you for shopping with us!<br>
    @reshiehandicrafts · reshiehandcrafts@gmail.com
  </div>
</body></html>`
}
