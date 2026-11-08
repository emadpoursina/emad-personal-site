/**
 * src/lib/contrast.mjs
 *
 * WCAG 2.1 Color Contrast Helpers.
 * Calculates relative luminance and contrast ratios between colors.
 */

/**
 * Parses a 3-digit (#rgb) or 6-digit (#rrggbb) hex color string into [r, g, b] (0-255).
 *
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function parseHex(hex) {
  if (typeof hex !== 'string') {
    throw new TypeError(`Expected string for hex color, got ${typeof hex}`);
  }
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    h = h.split('').map((c) => c + c).join('');
  }
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`Invalid hex color: "${hex}"`);
  }
  const num = parseInt(h, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/**
 * Computes the relative luminance contribution of an sRGB channel value (0-255).
 * Formula per WCAG 2.1: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 *
 * @param {number} c
 * @returns {number}
 */
export function channelLuminance(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * Computes the relative luminance of a color per WCAG 2.1.
 *
 * @param {string | [number, number, number]} color - hex string or [r, g, b]
 * @returns {number}
 */
export function relativeLuminance(color) {
  const [r, g, b] = Array.isArray(color) ? color : parseHex(color);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/**
 * Computes the contrast ratio between two colors per WCAG 2.1.
 * Returns a float between 1.0 and 21.0.
 *
 * @param {string | [number, number, number]} color1
 * @param {string | [number, number, number]} color2
 * @returns {number}
 */
export function contrastRatio(color1, color2) {
  const l1 = relativeLuminance(color1);
  const l2 = relativeLuminance(color2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
