'use client';

import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, errorMessage, formatDateTime, LoadingState, Table, Td, Th, toast, type Tone, useApi, useRealtime } from '@pos/ui';
import type { PrintJobDto } from '@pos/validation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Pager } from '@/components/pager';

const PAGE_SIZE = 10;
const STATUS: Record<PrintJobDto['status'], { label: string; tone: Tone }> = {
  QUEUED: { label: 'Waiting', tone: 'warn' }, PRINTING: { label: 'Printing', tone: 'warn' }, DONE: { label: 'Printed', tone: 'ok' }, FAILED: { label: 'Failed', tone: 'danger' },
};
const TYPES: Record<PrintJobDto['type'], string> = { RECEIPT: 'Bill', KOT: 'Kitchen ticket', CREDIT_NOTE: 'Credit note', REGISTER_REPORT: 'Register report', TEST: 'Test page' };

export function PrintQueueCard() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<PrintJobDto['status'] | ''>('');
  const [page, setPage] = useState(1);
  const query = { status: status || undefined, page, pageSize: PAGE_SIZE };
  const jobs = useQuery({ queryKey: ['print-jobs', query], queryFn: () => api.printing.jobs(query), placeholderData: keepPreviousData });
  useRealtime((event) => {
    if (event !== 'printJob.updated') return;
    void queryClient.invalidateQueries({ queryKey: ['print-jobs'] });
    // A finished or failed job also changes the status shown against its printer.
    void queryClient.invalidateQueries({ queryKey: ['printers'] });
  });

  const retry = useMutation({
    mutationFn: (job: PrintJobDto) => api.printing.retry(job.id),
    onSuccess: (_again, job) => {
      toast.success(`${job.title} sent to the printer again`);
      void queryClient.invalidateQueries({ queryKey: ['print-jobs'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const control = 'h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink-700';

  return (
    <Card>
      <CardHeader
        title="Print queue" description="Everything sent to a printer through the print bridge, newest first. A job that failed can be sent again."
        action={
          <select aria-label="Filter print jobs by status" value={status} onChange={(e) => { setStatus(e.target.value as PrintJobDto['status'] | ''); setPage(1); }} className={control}>
            <option value="">Any status</option>
            {Object.entries(STATUS).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
          </select>
        }
      />
      {jobs.isPending ? (
        <LoadingState label="Loading the print queue" />
      ) : jobs.isError ? (
        <ErrorState message={errorMessage(jobs.error)} onRetry={() => void jobs.refetch()} />
      ) : jobs.data.items.length === 0 ? (
        <EmptyState icon={Printer} title={status ? 'No print jobs with this status' : 'Nothing has been printed yet'} description={status ? 'Choose another status.' : 'Bills and kitchen tickets sent to a printer appear here.'} />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Time</Th><Th>What</Th><Th>Printer</Th><Th>Status</Th><Th className="text-right">Attempts</Th><Th>Error</Th><Th>Requested by</Th>
                <Th className="w-0"><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.items.map((job) => (
                <tr key={job.id} className="hover:bg-canvas/50">
                  <Td className="whitespace-nowrap">{formatDateTime(job.createdAt)}</Td>
                  <Td>
                    <span className="font-medium text-ink-900">{job.title}</span>
                    <span className="block text-xs text-ink-500">{TYPES[job.type]}{job.isReprint && ' · reprint'}</span>
                  </Td>
                  <Td>{job.printerName ?? <span className="text-ink-300">Deleted printer</span>}</Td>
                  <Td>
                    <Badge tone={STATUS[job.status].tone}>{STATUS[job.status].label}</Badge>
                    {job.printedAt && <span className="mt-1 block whitespace-nowrap text-xs text-ink-500">{formatDateTime(job.printedAt)}</span>}
                  </Td>
                  <Td className="text-right tabular-nums">{job.attempts}</Td>
                  <Td className="max-w-56 text-xs text-danger">{job.lastError ?? <span className="text-ink-300">—</span>}</Td>
                  <Td>{job.requestedByName ?? <span className="text-ink-300">—</span>}</Td>
                  <Td>
                    {job.status === 'FAILED' && (
                      <Button variant="secondary" size="sm" className="whitespace-nowrap" aria-label={`Send ${job.title} again`} disabled={retry.isPending} onClick={() => retry.mutate(job)}>
                        <RotateCw className="size-4" /> Send again
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pager page={page} pageSize={PAGE_SIZE} total={jobs.data.total} onChange={setPage} />
        </>
      )}
    </Card>
  );
}
