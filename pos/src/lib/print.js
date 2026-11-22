// Printing: QZ Tray (unsigned/free) first, browser print dialog as fallback.
// QZ Tray is loaded lazily so the app still works on PCs without it.
import { getSettings } from './settings'
import { logEvent } from './log'

let qzPromise = null

async function loadQz() {
  if (!qzPromise) {
    qzPromise = import('qz-tray').then((mod) => {
      const qz = mod.default || mod
      // Unsigned mode: QZ Tray shows a one-time "allow" dialog per site (free; no cert purchase).
      qz.security.setCertificatePromise((resolve) => resolve(''))
      qz.security.setSignatureAlgorithm('SHA512')
      qz.security.setSignaturePromise(() => (resolve) => resolve(''))
      return qz
    })
  }
  return qzPromise
}

async function connectQz() {
  const qz = await loadQz()
  if (!qz.websocket.isActive()) {
    await qz.websocket.connect({ retries: 1, delay: 1 })
  }
  return qz
}

/** Returns true when QZ Tray is running and reachable on this PC. */
export async function qzAvailable() {
  try {
    await connectQz()
    return true
  } catch {
    return false
  }
}

export async function listPrinters() {
  const qz = await connectQz()
  return qz.printers.find()
}

// A receipt is { html, raw } from buildReceipt(); a bare HTML string is still accepted.
const asReceipt = (r) => (typeof r === 'string' ? { html: r, raw: null } : r)

/**
 * Print a receipt. Returns { via: 'qz' | 'rawbt' | 'browser' }.
 * Android (or printMethod 'rawbt'): raw ESC/POS through the RawBT app.
 * With QZ Tray: sends raw ESC/POS text (printer's own font — sharp, auto-cut, tiny payload),
 * or the HTML rendering if no raw version was given. Otherwise: browser print dialog.
 */
export const isAndroid = () => /Android/i.test(navigator.userAgent || '')

/** Which method this device uses: 'qz' (PC), 'rawbt' (Android tablet/phone) or 'browser'. */
export function printMethod() {
  const { printMethod: m } = getSettings()
  if (m && m !== 'auto') return m
  return isAndroid() ? 'rawbt' : 'qz'
}

/**
 * Android: hand the raw ESC/POS receipt to the RawBT app (it holds the Bluetooth link to the
 * printer). Same sharp printer-font output as QZ Tray on a PC, no print dialog.
 */
export function rawbtPrint(raw, meta = {}) {
  // Receipt text is plain ASCII + ESC/POS control bytes, so btoa() is safe.
  const b64 = btoa(raw)
  logPrint(meta, 'rawbt')
  window.location.href = `intent:base64,${b64}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;`
}

// meta = { shopId, receiptNo, reprint } — used to log the print in event_logs
export async function printReceipt(receipt, meta = {}) {
  const { html, raw } = asReceipt(receipt)
  const { printerName } = getSettings()
  const method = printMethod()
  if (method === 'rawbt' && raw) {
    rawbtPrint(raw, meta)
    return { via: 'rawbt' }
  }
  if (method === 'browser') {
    browserPrint(html, meta)
    return { via: 'browser' }
  }
  try {
    const qz = await connectQz()
    const printer = printerName ? await qz.printers.find(printerName) : await qz.printers.getDefault()
    if (raw) {
      const config = qz.configs.create(printer)
      await qz.print(config, [{ type: 'raw', format: 'command', flavor: 'plain', data: raw }])
    } else {
      const config = qz.configs.create(printer, { units: 'mm', margins: 0, scaleContent: true })
      await qz.print(config, [{ type: 'pixel', format: 'html', flavor: 'plain', data: html }])
    }
    logPrint(meta, raw ? 'qz-raw' : 'qz', printer)
    return { via: 'qz' }
  } catch (err) {
    console.warn('QZ Tray unavailable, using browser print:', err?.message || err)
    browserPrint(html, meta, String(err?.message || err))
    return { via: 'browser' }
  }
}

function logPrint(meta, via, printer = null, qzError = null) {
  if (!meta?.receiptNo) return
  logEvent(meta.reprint ? 'receipt.reprinted' : 'receipt.printed', {
    shopId: meta.shopId, ref: meta.receiptNo,
    message: `${meta.reprint ? 'Reprinted' : 'Printed'} via ${via}`,
    data: { via, printer, qz_error: qzError },
  })
}

export function browserPrint(receipt, meta = {}, qzError = null) {
  const { html } = asReceipt(receipt)
  logPrint(meta, 'browser', null, qzError)
  // Print from a hidden iframe (no pop-up to be blocked). We must NOT remove it right after
  // print(): on Edge/Chrome/Android print() can return immediately, and tearing the frame
  // down kills the dialog before it appears. Clean up on 'afterprint' (or after 2 min).
  document.getElementById('receipt-print-frame')?.remove()
  const frame = document.createElement('iframe')
  frame.id = 'receipt-print-frame'
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)

  const doc = frame.contentWindow.document
  doc.open()
  doc.write(html)
  doc.close()

  let cleaned = false
  const cleanup = () => { if (!cleaned) { cleaned = true; frame.remove() } }
  frame.contentWindow.addEventListener('afterprint', () => setTimeout(cleanup, 500))
  setTimeout(cleanup, 120000)

  // Give the browser a moment to lay out (fonts/images) before printing
  setTimeout(() => {
    try {
      // Size the page to the receipt itself (printable roll width × real length, no margins),
      // so the driver doesn't place a short receipt somewhere on a 297 mm "sheet".
      const body = doc.body
      const pxToMm = 25.4 / 96
      const wMm = Math.round(body.getBoundingClientRect().width * pxToMm)
      const hMm = Math.ceil(body.scrollHeight * pxToMm) + 2
      const st = doc.createElement('style')
      st.textContent = `@page { size: ${wMm}mm ${hMm}mm; margin: 0; } html, body { height: auto; }`
      doc.head.appendChild(st)
      frame.contentWindow.focus()
      frame.contentWindow.print()
    } catch (e) {
      console.error('Browser print failed:', e)
      alert('Could not open the print dialog: ' + (e?.message || e))
    }
  }, 300)
}
