import { Button } from '@pos/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/** "1–25 of 80" with previous and next buttons, under a list the server pages. */
export function Pager({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (page: number) => void }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between px-4 py-3 text-sm text-ink-500">
      <span>{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</span>
      <div className="flex items-center gap-1">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>
        <span className="px-2 tabular-nums">{page} / {pageCount}</span>
        <Button variant="secondary" size="sm" disabled={page >= pageCount} onClick={() => onChange(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button>
      </div>
    </div>
  );
}
