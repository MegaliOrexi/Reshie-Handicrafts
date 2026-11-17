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

/**
 * Print a receipt (HTML string). Returns { via: 'qz' | 'browser' }.
 * Falls back to the browser print dialog when QZ Tray isn't running.
 */
// meta = { shopId, receiptNo, reprint } — used to log the print in event_logs
export async function printReceipt(html, meta = {}) {
  const { printerName } = getSettings()
  try {
    const qz = await connectQz()
    const printer = printerName ? await qz.printers.find(printerName) : await qz.printers.getDefault()
    // Paper width is controlled by the receipt's own CSS (@page + body width);
    // the printer driver's default roll size is used.
    const config = qz.configs.create(printer, { units: 'mm', margins: 1, scaleContent: true })
    await qz.print(config, [{ type: 'pixel', format: 'html', flavor: 'plain', data: html }])
    logPrint(meta, 'qz', printer)
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

export function browserPrint(html, meta = {}, qzError = null) {
  logPrint(meta, 'browser', null, qzError)
  const w = window.open('', '_blank', 'width=420,height=700')
  if (!w) {
    alert('Pop-up blocked. Please allow pop-ups for this site to print.')
    return
  }
  w.document.open()
  w.document.write(html)
  w.document.close()
  w.focus()
  // Give the browser a tick to lay out before printing
  setTimeout(() => {
    w.print()
    setTimeout(() => w.close(), 300)
  }, 150)
}
