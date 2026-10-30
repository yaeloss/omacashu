// Control, format (incl. bidi overrides), and line/paragraph separators can spoof terminals and UIs.
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function sanitizeText(value, maxChars = 64) {
  if (typeof value !== 'string') return null;
  const chars = Array.from(value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim());
  if (chars.length === 0) return null;
  return chars.length > maxChars ? chars.slice(0, maxChars - 1).join('') + '…' : chars.join('');
}
