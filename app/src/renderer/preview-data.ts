/** Bounded CSV reader with quoted commas/newlines and escaped quotes. Returns null for incomplete quoted input. */
export function previewCsv(text: string, limit = 200): { rows: string[][]; truncated: boolean } | null {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (char === '\r' && text[i + 1] === '\n') i++;
      if (rows.length >= limit) return { rows, truncated: i < text.length - 1 };
    } else cell += char;
  }
  if (quoted) return null;
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return { rows, truncated: false };
}
