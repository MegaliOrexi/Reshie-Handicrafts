/**
 * Light 3G resilience: retry a promise-returning fn a few times with backoff.
 * Only retries on network-ish failures; business errors (e.g. "day not opened")
 * are thrown straight away.
 */
export async function withRetry(fn, { attempts = 4, baseDelay = 800 } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isTransient(err) || i === attempts - 1) throw err
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** i))
    }
  }
  throw lastErr
}

export function isTransient(err) {
  if (!err) return false
  const msg = String(err.message || err).toLowerCase()
  if (err.name === 'TypeError' && msg.includes('fetch')) return true // network down
  if (msg.includes('failed to fetch') || msg.includes('network') || msg.includes('timeout')) return true
  const status = err.status || err.code
  if ([502, 503, 504, '502', '503', '504', 'ECONNRESET', 'ETIMEDOUT'].includes(status)) return true
  return false
}
