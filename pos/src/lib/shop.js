// How a shop is shown in the UI: "Shop No FF62", "Shop No G85", "Shop No G50".
// Built from the mall unit number (egoal_outlet_code: FF62 / G-085 / G-050) — dash and leading
// zeros dropped. Falls back to the internal code (RAK / AUH / AUH2) if a shop has no unit number.
export function shopNo(shop) {
  const unit = shop?.egoal_outlet_code
  if (!unit) return shop?.code ?? ''
  const m = unit.replace(/-/g, '').match(/^([A-Za-z]*)0*(\d+)$/)
  return m ? `${m[1].toUpperCase()}${m[2]}` : unit
}

export const shopLabel = (shop) => `Shop No ${shopNo(shop)}`
