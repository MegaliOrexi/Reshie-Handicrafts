// Per-device settings (printer name etc.) — stored in this browser only.
const KEY = 'reshie-pos-settings'

export function getSettings() {
  try {
    return { printerName: '', autoPrint: true, paperWidthMm: 80, printMethod: 'auto', ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return { printerName: '', autoPrint: true, paperWidthMm: 80, printMethod: 'auto' }
  }
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* ignore */ }
  return next
}
