// The variation code is a private internal tag — it must NEVER appear on the customer receipt.
//
// Two renderings of the same receipt:
//  - receiptEscPos(): raw ESC/POS text for thermal printers (via QZ Tray). Uses the printer's own
//    built-in font: razor sharp, starts at the top, auto-cuts, and is only ~1 KB to send.
//  - receiptHtml():   HTML for the on-screen preview and the browser print-dialog fallback.
import { getSettings } from './settings'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const money = (n) => Number(n || 0).toFixed(2)

const dateText = (sale) =>
  new Date(sale.created_at).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', hour12: false })

/** Registered company name for this shop's receipts (shops.legal_name; RAK is a separate LLC). */
const companyName = (shop) => shop?.legal_name || 'Reshie Antiques & Gifts'

/** Printable width of the roll in mm (80 mm roll → 72 mm, 58 mm roll → 48 mm). */
export function printableWidthMm() {
  return Number(getSettings().paperWidthMm) === 58 ? 48 : 72
}

/** Both renderings at once — pass this to printReceipt(). */
export function buildReceipt(args) {
  return { html: receiptHtml(args), raw: receiptEscPos(args) }
}

// ---------------------------------------------------------------------------------------------
// ESC/POS (raw) receipt
// ---------------------------------------------------------------------------------------------
const ESC = '\x1B'
const GS = '\x1D'
const CMD = {
  init: ESC + '@',
  codepage437: ESC + 't\x00',
  left: ESC + 'a\x00',
  center: ESC + 'a\x01',
  boldOn: ESC + 'E\x01',
  boldOff: ESC + 'E\x00',
  normal: GS + '!\x00',
  tall: GS + '!\x01', // double height
  big: GS + '!\x11', // double width + height
  feed: (n) => ESC + 'd' + String.fromCharCode(n),
  cut: GS + 'V\x42\x00', // feed to cutter + partial cut
}

// Printer font is plain ASCII (code page 437) — strip accents / symbols that it can't draw.
const ascii = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[–—·]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')

function wrap(text, width) {
  const words = ascii(text).split(/\s+/).filter(Boolean)
  const out = []
  let cur = ''
  for (let w of words) {
    while (w.length > width) { // hard-break very long words
      if (cur) { out.push(cur); cur = '' }
      out.push(w.slice(0, width))
      w = w.slice(width)
    }
    if (!cur) cur = w
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w
    else { out.push(cur); cur = w }
  }
  if (cur) out.push(cur)
  return out.length ? out : ['']
}

/** "Left ....... Right" on one line (right side wins if both don't fit). */
function lr(left, right, width) {
  const l = ascii(left)
  const r = ascii(right)
  const room = width - r.length - 1
  if (room <= 0) return r.slice(-width)
  return l.slice(0, room).padEnd(room) + ' ' + r
}

export function receiptEscPos({ sale, items, shop, cashierName }) {
  const W = Number(getSettings().paperWidthMm) === 58 ? 32 : 48 // Font A characters per line
  const dash = '-'.repeat(W)
  const out = []
  const line = (s = '') => out.push(s + '\n')
  const center = (s) => wrap(s, W).forEach((l) => line(l))

  out.push(CMD.init, CMD.codepage437, CMD.center)

  // Header
  const title = 'RESHIE HANDICRAFTS'
  out.push(CMD.boldOn, title.length * 2 <= W ? CMD.big : CMD.tall)
  line(title)
  out.push(CMD.normal, CMD.boldOff)
  center(companyName(shop))
  if (shop.location) center(shop.location)
  if (shop.address) center(shop.address)
  if (shop.phone) center(`Tel: ${shop.phone}`)
  out.push(CMD.boldOn)
  center(`TRN: ${shop.trn || 'TRN-PENDING'}`)
  out.push(CMD.boldOff)
  line(dash)
  out.push(CMD.boldOn, CMD.tall)
  line('TAX INVOICE')
  out.push(CMD.normal, CMD.boldOff, CMD.left)

  // Meta
  line(lr('Receipt', sale.receipt_no, W))
  line(lr('Date', dateText(sale), W))
  line(lr('Cashier', cashierName || '', W))
  line(lr('Payment', String(sale.payment_method || '').toUpperCase(), W))
  line(dash)

  // Lines (item name + qty x price — never the variation code)
  for (const li of items) {
    out.push(CMD.boldOn)
    wrap(li.item_name, W).forEach((l) => line(l))
    out.push(CMD.boldOff)
    line(lr(`  ${li.qty} x ${money(li.unit_price)}`, money(li.line_gross), W))
  }
  line(dash)

  // Totals
  line(lr('Net (excl. VAT)', money(sale.net_total), W))
  line(lr('VAT 5%', money(sale.vat_total), W))
  out.push(CMD.boldOn, CMD.tall)
  line(lr('TOTAL AED', money(sale.gross_total), W))
  out.push(CMD.normal, CMD.boldOff)
  line(dash)

  // Footer
  out.push(CMD.center)
  center('Prices include 5% VAT.')
  if (shop.receipt_footer) center(shop.receipt_footer)
  center('Thank you for shopping with us!')
  center('@reshiehandicrafts')
  center('reshiehandcrafts@gmail.com')

  out.push(CMD.feed(4), CMD.cut)
  return out.join('')
}

// ---------------------------------------------------------------------------------------------
// HTML receipt (screen preview + browser print fallback)
// ---------------------------------------------------------------------------------------------
export function receiptHtml({ sale, items, shop, cashierName }) {
  const width = printableWidthMm()

  const lines = items
    .map(
      (li) => `
      <tr class="line"><td colspan="2">${esc(li.item_name)}</td></tr>
      <tr><td>&nbsp;&nbsp;${li.qty} x ${money(li.unit_price)}</td><td class="r">${money(li.line_gross)}</td></tr>`,
    )
    .join('')

  // Thermal printers have no grey: everything is solid black, a bit heavier than screen text,
  // so the driver's black/white conversion keeps clean edges. The page is exactly the roll's
  // printable width; browserPrint() sets the page height to the receipt's real length.
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(sale.receipt_no)}</title>
<style>
  @page { size: ${width}mm 297mm; margin: 0; }
  * { box-sizing: border-box; color: #000 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html { background: #fff; }
  body { margin: 0 auto; padding: 2mm 1.5mm 4mm; width: ${width}mm;
         font-family: Arial, Helvetica, sans-serif; font-size: 12.5px; font-weight: 600; line-height: 1.3; }
  .c { text-align: center; } .r { text-align: right; white-space: nowrap; }
  h1 { font-size: 19px; font-weight: 900; margin: 0 0 3px; letter-spacing: .3px; }
  .sm { font-size: 11.5px; }
  b, .b { font-weight: 800; }
  hr { border: 0; border-top: 1.5px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  tr.line td { padding-top: 4px; font-weight: 800; }
  .title { font-size: 15px; font-weight: 900; margin: 2px 0; }
  .grand td { font-size: 17px; font-weight: 900; padding-top: 4px; }
  .foot { margin-top: 4px; }
</style></head>
<body>
  <div class="c">
    <h1>RESHIE HANDICRAFTS</h1>
    <div class="sm">${esc(companyName(shop))}</div>
    <div class="sm">${esc(shop.location)}</div>
    ${shop.address ? `<div class="sm">${esc(shop.address)}</div>` : ''}
    ${shop.phone ? `<div class="sm">Tel: ${esc(shop.phone)}</div>` : ''}
    <div class="sm b">TRN: ${esc(shop.trn || 'TRN-PENDING')}</div>
  </div>
  <hr>
  <div class="c title">TAX INVOICE</div>
  <table class="sm">
    <tr><td>Receipt</td><td class="r b">${esc(sale.receipt_no)}</td></tr>
    <tr><td>Date</td><td class="r">${esc(dateText(sale))}</td></tr>
    <tr><td>Cashier</td><td class="r">${esc(cashierName || '')}</td></tr>
    <tr><td>Payment</td><td class="r">${esc(String(sale.payment_method).toUpperCase())}</td></tr>
  </table>
  <hr>
  <table>${lines}</table>
  <hr>
  <table>
    <tr><td>Net (excl. VAT)</td><td class="r">${money(sale.net_total)}</td></tr>
    <tr><td>VAT 5%</td><td class="r">${money(sale.vat_total)}</td></tr>
    <tr class="grand"><td>TOTAL AED</td><td class="r">${money(sale.gross_total)}</td></tr>
  </table>
  <hr>
  <div class="c sm foot">
    Prices include 5% VAT.<br>
    ${shop.receipt_footer ? esc(shop.receipt_footer) + '<br>' : ''}
    Thank you for shopping with us!<br>
    @reshiehandicrafts<br>reshiehandcrafts@gmail.com
  </div>
</body></html>`
}
