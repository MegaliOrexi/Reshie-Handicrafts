// On tablets the on-screen keyboard can hide the field being typed in.
// When an input gets focus, wait for the keyboard to open, then scroll that
// field to the middle of the visible area.
export function keepFocusedFieldVisible() {
  const scroll = (el) => {
    if (!el || !el.matches?.('input, select, textarea')) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  document.addEventListener('focusin', (e) => setTimeout(() => scroll(e.target), 300))
  // Some browsers resize the visual viewport when the keyboard opens.
  window.visualViewport?.addEventListener('resize', () => scroll(document.activeElement))
}
