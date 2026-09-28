/** The UI is English; every date and number uses one fixed locale so text and numbers match. */
export const UI_LOCALE = 'en-US';
const dateTime = new Intl.DateTimeFormat(UI_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const numberFormat = new Intl.NumberFormat(UI_LOCALE);
export const formatDateTime = (value: string | number | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTime.format(date);
};
export const formatNumber = (value: number): string => numberFormat.format(value);
