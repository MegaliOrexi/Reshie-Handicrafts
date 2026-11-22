import { useEffect, useState } from 'react'
import { getSettings, saveSettings } from '../lib/settings'
import { qzAvailable, listPrinters, printReceipt, printMethod, isAndroid } from '../lib/print'
import { buildReceipt } from '../lib/receipt'
import { useAuth } from '../lib/AuthContext'

export default function Settings() {
  const { shop, profile } = useAuth()
  const [s, setS] = useState(getSettings())
  const [qz, setQz] = useState(null)
  const [printers, setPrinters] = useState([])
  const [msg, setMsg] = useState('')

  const method = printMethod()

  const detect = async () => {
    if (printMethod() !== 'qz') { setQz(null); setMsg(''); return }
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
    const { via } = await printReceipt(buildReceipt({ sale, items, shop, cashierName: profile?.full_name || profile?.email }))
    setMsg(via === 'qz' ? 'Test receipt sent to QZ Tray.' : via === 'rawbt' ? 'Test receipt sent to RawBT.' : 'Printed via browser dialog.')
  }

  const setMethod = (v) => { save({ printMethod: v }); setTimeout(detect, 0) }

  return (
    <div className="card narrow">
      <h2>Printer settings (this device)</h2>
      <label className="field">
        <span>Print method</span>
        <select value={s.printMethod || 'auto'} onChange={(e) => setMethod(e.target.value)}>
          <option value="auto">Automatic ({isAndroid() ? 'RawBT on this tablet' : 'QZ Tray on this PC'})</option>
          <option value="qz">QZ Tray (Windows PC)</option>
          <option value="rawbt">RawBT app (Android tablet / phone, Bluetooth)</option>
          <option value="browser">Browser print dialog</option>
        </select>
      </label>
      {method === 'qz' && <p className="muted">
        QZ Tray status: {qz === null ? '…' : qz ? <span className="badge badge-ok">connected</span> : <span className="badge badge-bad">not running</span>}
        {' '}<button className="btn btn-ghost btn-sm" onClick={detect}>Re-detect</button>
      </p>}
      {method === 'qz' && <label className="field">
        <span>Receipt printer</span>
        {printers.length ? (
          <select value={s.printerName} onChange={(e) => save({ printerName: e.target.value })}>
            <option value="">(system default)</option>
            {printers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        ) : (
          <input value={s.printerName} placeholder="Printer name as shown in Windows (blank = default)" onChange={(e) => save({ printerName: e.target.value })} />
        )}
      </label>}
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
      <h3>Windows PC: QZ Tray</h3>
      <ol className="muted small">
        <li>Install the printer driver (printer must show in Windows → Printers &amp; scanners).</li>
        <li>Download and install QZ Tray from qz.io/download, and keep it running (system-tray icon).</li>
        <li>On first print, QZ shows an "untrusted website" prompt — tick remember and choose <b>Allow</b>.</li>
      </ol>
      <h3>Android tablet: RawBT (Bluetooth)</h3>
      <ol className="muted small">
        <li>Pair the printer in the tablet's Bluetooth settings (PIN 0000 or 1234).</li>
        <li>Install <b>RawBT</b> (AppGallery / Play Store, or the APK from rawbt.ru).</li>
        <li>In RawBT: connection <b>Bluetooth</b> → pick the printer; driver <b>ESC/POS</b>, 80 mm. Do its test print.</li>
        <li>Open the POS in <b>Chrome</b>, press <b>Print test receipt</b> here; if asked, open with RawBT and choose "Always".</li>
      </ol>
    </div>
  )
}
