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
        <td colspan="3">${esc(li.item_name)} <span class="code">${esc(li.variation_code)}</span></td>
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
  @page { margin: 0; size: ${paperWidthMm || 80}mm auto; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 3mm; width: ${width}mm; font-family: "Courier New", Courier, monospace; font-size: 11px; color: #000; }
  .c { text-align: center; } .r { text-align: right; }
  h1 { font-size: 15px; margin: 0 0 2px; letter-spacing: .5px; }
  .muted { font-size: 10px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 5px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  tr.line td { padding-top: 3px; font-weight: bold; }
  .code { font-weight: normal; border: 1px solid #000; padding: 0 3px; margin-left: 3px; font-size: 10px; }
  .totals td { padding: 1px 0; }
  .grand td { font-size: 14px; font-weight: bold; padding-top: 3px; }
  .meta td { font-size: 10px; }
  .foot { margin-top: 6px; font-size: 10px; }
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
