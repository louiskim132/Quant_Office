/** The UI is English; every date and number uses one fixed locale so text and numbers match. */
export const UI_LOCALE = 'en-US';
const dateTime = new Intl.DateTimeFormat(UI_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const numberFormat = new Intl.NumberFormat(UI_LOCALE);
export const formatDateTime = (value: string | number | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTime.format(date);
};
export const formatNumber = (value: number): string => numberFormat.format(value);

/**
 * Absolute Windows/POSIX paths in prose become their last two segments: "…\outputs\ema200.py".
 * The full path stays available in the underlying record; running text does not need it.
 */
export const shortenPaths = (text: string): string =>
  text.replace(/(?:[A-Za-z]:[\/]|\/(?:home|Users|tmp|var)\/)[^\s"'`)\]]+/g, match => {
    const parts = match.split(/[\/]+/).filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : match;
  });

/** First sentence (or first `max` characters) of a long text, and whether anything was cut. */
export function firstSentence(text: string, max = 160): { head: string; cut: boolean } {
  const flat = text.replace(/\s+/g, ' ').trim();
  const stop = flat.search(/[.!?](\s|$)/);
  const end = stop >= 0 ? stop + 1 : flat.length;
  const head = flat.slice(0, Math.min(end, max));
  return { head: head + (head.length < flat.length && end > max ? '…' : ''), cut: head.length < flat.length };
}
