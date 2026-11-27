/**
 * Sorting for list columns whose value is worked out from related rows (a bill number on an order,
 * a cashier's name on a bill), which the database cannot order by in one query. The caller reads a
 * light version of every matching row, this puts them in order, and the caller then loads the one page.
 */
export function pageOfSorted<T extends { id: string }>(
  rows: T[], value: (row: T) => string | number | null, direction: 'asc' | 'desc', page: number, pageSize: number,
): string[] {
  const sign = direction === 'asc' ? 1 : -1;
  const empty = (key: string | number | null) => key === null || key === '';
  return rows
    .map((row, index) => ({ id: row.id, index, key: value(row) }))
    .sort((a, b) => {
      // Rows with nothing in the column stay at the bottom whichever way it is sorted.
      if (empty(a.key) !== empty(b.key)) return empty(a.key) ? 1 : -1;
      const order = typeof a.key === 'number' && typeof b.key === 'number'
        ? a.key - b.key
        : String(a.key ?? '').localeCompare(String(b.key ?? ''), 'en-IN', { numeric: true, sensitivity: 'base' });
      return sign * order || a.index - b.index;
    })
    .slice((page - 1) * pageSize, page * pageSize)
    .map((entry) => entry.id);
}

/** Puts rows loaded by id back into the order of those ids. */
export function inOrderOf<T extends { id: string }>(ids: string[], rows: T[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}
