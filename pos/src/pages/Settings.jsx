import { useEffect, useState } from 'react'
import { getSettings, saveSettings } from '../lib/settings'
import { qzAvailable, listPrinters, printReceipt } from '../lib/print'
import { receiptHtml } from '../lib/receipt'
import { useAuth } from '../lib/AuthContext'

export default function Settings() {
  const { shop, profile } = useAuth()
  const [s, setS] = useState(getSettings())
  const [qz, setQz] = useState(null)
  const [printers, setPrinters] = useState([])
  const [msg, setMsg] = useState('')

  const detect = async () => {
    setMsg('Looking for QZ Tray…')
    const ok = await qzAvailable()
    setQz(ok)
    if (ok) {
      try { setPrinters(await listPrinters()) } catch (e) { setMsg(e.message) }
      setMsg('')
    } else {
      setMsg('QZ Tray not detected on this PC. Receipts will use the browser print dialog.')
    }
  }
  useEffect(() => { detect() }, [])

  const save = (patch) => setS(saveSettings(patch))

  const testPrint = async () => {
    const sale = { receipt_no: `${shop.code}-TEST`, created_at: new Date().toISOString(), payment_method: 'cash', gross_total: 210, net_total: 200, vat_total: 10 }
    const items = [{ item_name: 'Shawl', variation_code: 'TEST', qty: 1, unit_price: 210, line_gross: 210, line_net: 200, line_vat: 10 }]
    const { via } = await printReceipt(receiptHtml({ sale, items, shop, cashierName: profile?.full_name || profile?.email }))
    setMsg(via === 'qz' ? 'Test receipt sent to QZ Tray.' : 'Printed via browser dialog (QZ Tray not available).')
  }

  return (
    <div className="card narrow">
      <h2>Printer settings (this PC)</h2>
      <p className="muted">
        QZ Tray status: {qz === null ? '…' : qz ? <span className="badge badge-ok">connected</span> : <span className="badge badge-bad">not running</span>}
        {' '}<button className="btn btn-ghost btn-sm" onClick={detect}>Re-detect</button>
      </p>
      <label className="field">
        <span>Receipt printer</span>
        {printers.length ? (
          <select value={s.printerName} onChange={(e) => save({ printerName: e.target.value })}>
            <option value="">(system default)</option>
            {printers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        ) : (
          <input value={s.printerName} placeholder="Printer name as shown in Windows (blank = default)" onChange={(e) => save({ printerName: e.target.value })} />
        )}
      </label>
      <label className="field">
        <span>Paper width (mm)</span>
        <select value={s.paperWidthMm} onChange={(e) => save({ paperWidthMm: Number(e.target.value) })}>
          <option value={58}>58 mm</option>
          <option value={80}>80 mm</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.autoPrint} onChange={(e) => save({ autoPrint: e.target.checked })} />
        Print automatically after each sale
      </label>
      <button className="btn btn-primary" onClick={testPrint}>Print test receipt</button>
      {msg && <p className="muted">{msg}</p>}
      <hr />
      <h3>Installing QZ Tray</h3>
      <ol className="muted small">
        <li>Download and install QZ Tray from qz.io/download on the shop PC.</li>
        <li>Make sure it is running (icon in the system tray).</li>
        <li>On first print, QZ shows an "untrusted website" prompt — choose <b>Allow</b> / remember.</li>
      </ol>
    </div>
  )
}
