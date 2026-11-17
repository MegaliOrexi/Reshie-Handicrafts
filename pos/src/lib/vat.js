// UAE VAT 5%. All entered prices are GROSS (VAT-inclusive).
export const VAT_RATE = 0.05

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

/** Split a gross amount into { gross, net, vat } — matches the SQL in create_sale(). */
export function splitVat(gross) {
  const g = round2(gross)
  const net = round2(g / (1 + VAT_RATE))
  return { gross: g, net, vat: round2(g - net) }
}

/** Totals for a cart of { unit_price, qty } lines. */
export function cartTotals(lines) {
  return lines.reduce(
    (acc, l) => {
      const { gross, net, vat } = splitVat(round2(Number(l.unit_price || 0) * Number(l.qty || 0)))
      acc.gross = round2(acc.gross + gross)
      acc.net = round2(acc.net + net)
      acc.vat = round2(acc.vat + vat)
      acc.qty += Number(l.qty || 0)
      return acc
    },
    { gross: 0, net: 0, vat: 0, qty: 0 },
  )
}

export const fmt = (n) =>
  'AED ' + Number(n || 0).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
