'use client';

import { useCallback, useMemo, useState } from 'react';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: string;
  direction: SortDirection;
}

/** What a table header needs to show and change the sort. Pass it to every sortable `Th` of a table. */
export interface Sorter {
  /** Null while the table is in its own default order. */
  state: SortState | null;
  /** First click on a column sorts it ascending, the next descending, and so on. */
  toggle: (key: string) => void;
}

/**
 * Holds which column a table is sorted by. For a list the server pages, send `state` with the request
 * and let the server sort; for a list that is all on the page, use `useSorted` instead.
 */
export function useSorter(initial: SortState | null = null, onChange?: () => void): Sorter {
  const [state, setState] = useState<SortState | null>(initial);
  const toggle = useCallback(
    (key: string) => {
      setState((current) => ({ key, direction: current?.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
      onChange?.();
    },
    [onChange],
  );
  return { state, toggle };
}

export type SortValue = string | number | boolean | null | undefined;

/** Text is compared as people read it ("Table 2" before "Table 10", case ignored); empty values always go last. */
export function compareValues(a: SortValue, b: SortValue): number {
  const emptyA = a === null || a === undefined || a === '';
  const emptyB = b === null || b === undefined || b === '';
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), 'en-IN', { numeric: true, sensitivity: 'base' });
}

/** Rows in the order the sort asks for. Rows that compare equal keep the order they came in. */
export function sortRows<T>(rows: readonly T[], state: SortState | null, value: (row: T, key: string) => SortValue): T[] {
  if (!state) return [...rows];
  const sign = state.direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, key: value(row, state.key) }))
    .sort((a, b) => {
      const emptyA = a.key === null || a.key === undefined || a.key === '';
      const emptyB = b.key === null || b.key === undefined || b.key === '';
      // Empty cells stay at the bottom whichever way the column is sorted.
      if (emptyA !== emptyB) return emptyA ? 1 : -1;
      return sign * compareValues(a.key, b.key) || a.index - b.index;
    })
    .map((entry) => entry.row);
}

/**
 * Sorting for a table whose rows are all on the page. `columns` gives, for each sortable column,
 * the value its rows are ordered by.
 */
export function useSorted<T>(rows: readonly T[] | undefined, columns: Record<string, (row: T) => SortValue>, initial: SortState | null = null): { rows: T[]; sorter: Sorter } {
  const sorter = useSorter(initial);
  const sorted = useMemo(
    () => sortRows(rows ?? [], sorter.state, (row, key) => columns[key]?.(row)),
    // The accessors are written inline by callers and do not change what they compute between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, sorter.state],
  );
  return { rows: sorted, sorter };
}
