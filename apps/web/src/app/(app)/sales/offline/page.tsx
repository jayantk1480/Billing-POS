'use client';

import {
  Badge, Button, Card, cn, Dialog, EmptyState, ErrorState, errorMessage, formatDateTime, LoadingState, PageHeader, Table, Td, TextAreaField, Th, toast, useApi,
} from '@pos/ui';
import type { SyncReviewDto, SyncReviewQuery } from '@pos/validation';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, CloudOff } from 'lucide-react';
import { useState } from 'react';

const PAGE_SIZE = 25;
const KIND: Record<string, string> = { 'order.save': 'Order', 'kot.print': 'Kitchen ticket', 'invoice.issue': 'Bill', 'payment.record': 'Payment' };
const VIEWS: { id: NonNullable<SyncReviewQuery['status']>; label: string }[] = [
  { id: 'open', label: 'To check' }, { id: 'checked', label: 'Checked' }, { id: 'all', label: 'All' },
];

/** Marks one upload as checked, with an optional note kept in the audit log. */
function CheckDialog({ review, onClose }: { review: SyncReviewDto; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    try {
      await api.sync.check(review.id, { note: note.trim() || null });
      await queryClient.invalidateQueries({ queryKey: ['sync-reviews'] });
      toast.success('Marked as checked');
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open onClose={onClose} title="Mark as checked" description={review.summary}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void check()} loading={busy}>Mark as checked</Button>
        </>
      }
    >
      <TextAreaField label="Note (optional)" value={note} onChange={setNote} placeholder="What was found, or what was done about it" maxLength={300} />
    </Dialog>
  );
}

/**
 * What the billing devices uploaded after working without the internet, where something needs the owner's eye: a bill
 * whose amounts do not add up, a number skipped or used twice, a discount over the limit, cash for a register already
 * closed, or something that could not be stored at all.
 */
export default function OfflineUploadsPage() {
  const api = useApi();
  const [view, setView] = useState<NonNullable<SyncReviewQuery['status']>>('open');
  const [page, setPage] = useState(1);
  const [checking, setChecking] = useState<SyncReviewDto | null>(null);
  const filters = { status: view, page, pageSize: PAGE_SIZE };
  const reviews = useQuery({ queryKey: ['sync-reviews', filters], queryFn: () => api.sync.reviews(filters), placeholderData: keepPreviousData });
  const total = reviews.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="Offline uploads"
        description="Bills, payments and orders made on a billing device without the internet, where something needs checking. They are kept as printed: nothing here was changed by the upload."
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <div className="flex rounded-xl bg-canvas p-1" role="radiogroup" aria-label="Show">
            {VIEWS.map((option) => (
              <button
                key={option.id} type="button" role="radio" aria-checked={view === option.id} onClick={() => { setView(option.id); setPage(1); }}
                className={cn('h-9 rounded-lg px-4 text-sm font-semibold', view === option.id ? 'bg-surface text-brand-700 shadow-(--shadow-card)' : 'text-ink-700')}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {reviews.isPending ? <LoadingState label="Loading uploads" /> : reviews.isError ? <ErrorState message={errorMessage(reviews.error)} onRetry={() => void reviews.refetch()} /> : reviews.data.items.length === 0 ? (
          <EmptyState
            icon={CloudOff} title={view === 'open' ? 'Nothing to check' : 'Nothing here'}
            description={view === 'open' ? 'Everything the billing devices uploaded after working offline added up.' : 'Uploads that needed checking are listed here once they are marked.'}
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr><Th>Made</Th><Th>Device</Th><Th>What</Th><Th>Needs checking</Th><Th className="text-right">{view === 'open' ? '' : 'Checked'}</Th></tr>
              </thead>
              <tbody>
                {reviews.data.items.map((review) => (
                  <tr key={review.id} className="align-top">
                    <Td className="whitespace-nowrap">
                      {formatDateTime(review.happenedAt)}
                      <span className="block text-xs text-ink-500">Uploaded {formatDateTime(review.uploadedAt)}</span>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span className="font-mono text-ink-900">{review.deviceCode}</span>
                      {review.deviceLabel && <span className="block text-xs text-ink-500">{review.deviceLabel}</span>}
                      {review.userName && <span className="block text-xs text-ink-500">By {review.userName}</span>}
                    </Td>
                    <Td>
                      <span className="font-medium text-ink-900">{review.summary}</span>
                      <span className="block text-xs text-ink-500">{KIND[review.type] ?? 'Upload'}</span>
                    </Td>
                    <Td className="max-w-md">
                      {review.status === 'REJECTED' && (
                        <p className="text-sm text-danger"><Badge tone="danger">Not stored</Badge> {review.error}</p>
                      )}
                      <ul className="space-y-1">
                        {review.flags.map((flag) => <li key={flag.code} className="text-sm text-ink-700">{flag.message}</li>)}
                      </ul>
                    </Td>
                    <Td className="whitespace-nowrap text-right">
                      {review.reviewedAt ? (
                        <span className="text-xs text-ink-500">{review.reviewedByName ?? 'Someone'}<span className="block">{formatDateTime(review.reviewedAt)}</span></span>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => setChecking(review)}>Mark checked</Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between px-4 py-3 text-sm text-ink-500">
              <span>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}</span>
              <div className="flex items-center gap-1">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>
                <span className="px-2 tabular-nums">{page} / {pageCount}</span>
                <Button variant="secondary" size="sm" disabled={page >= pageCount} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button>
              </div>
            </div>
          </>
        )}
      </Card>
      {checking && <CheckDialog review={checking} onClose={() => setChecking(null)} />}
    </>
  );
}
