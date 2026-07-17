// Inline SVG shared by the in-page surfaces (bubble badges + composer glyph). One
// source of truth: the lock shown on a decrypted bubble and on the glyph represent the
// same state and must never drift apart visually.
export const ICON_LOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';
export const ICON_UNLOCKED =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 7.4-2"/></svg>';
