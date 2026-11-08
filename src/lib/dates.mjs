/**
 * src/lib/dates.mjs
 *
 * Date formatting helpers for CV and presentation.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Formats YYYY-MM to 'Mon YYYY' (e.g. '2019-03' → 'Mar 2019').
 * 'present' (case-insensitive) → 'Present'.
 * Bare 'YYYY' and any other inputs remain unchanged.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function formatMonth(value) {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.toLowerCase() === 'present') {
    return 'Present';
  }
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (match) {
    const year = match[1];
    const monthIndex = parseInt(match[2], 10) - 1;
    if (monthIndex >= 0 && monthIndex < MONTHS.length) {
      return `${MONTHS[monthIndex]} ${year}`;
    }
  }
  return value;
}

/**
 * Formats a start and end date into 'Start – End' using an en dash (U+2013)
 * surrounded by single spaces.
 *
 * @param {unknown} start
 * @param {unknown} end
 * @returns {string}
 */
export function formatRange(start, end) {
  return `${formatMonth(start)} \u2013 ${formatMonth(end)}`;
}
