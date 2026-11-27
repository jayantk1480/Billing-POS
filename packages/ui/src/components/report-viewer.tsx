'use client';

import { formatINR } from '@pos/billing-core';
import { type ReportCell, type ReportColumn, type ReportFormat, REPORTS, type ReportType } from '@pos/validation';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Download, FileBarChart } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useApi } from '../auth';
import { sortRows, useSorter } from '../sorting';
import { cn } from '../cn';
import { formatDateTime } from '../format';
import { errorMessage } from '../use-form';
import { Button } from './button';
import { Card } from './card';
import { EmptyState, ErrorState, LoadingState, Th } from './layout';

const NUMERIC = new Set<ReportColumn['type']>(['number', 'money', 'percent']);

/** Calendar arithmetic on "YYYY-MM-DD" strings, in the restaurant's time zone. */
const iso = (date: Date) => date.toISOString().slice(0, 10);
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const addDays = (date: string, days: number) => iso(new Date(Date.parse(date) + days * 86_400_000));
const monthStart = (date: string) => date.slice(0, 8) + '01';

function presets(): { label: string; from: string; to: string }[] {
  const today = todayIso();
  const lastMonthEnd = addDays(monthStart(today), -1);
  return [
    { label: 'Today', from: today, to: today },
    { label: 'Yesterday', from: addDays(today, -1), to: addDays(today, -1) },
    { label: 'Last 7 days', from: addDays(today, -6), to: today },
    { label: 'This month', from: monthStart(today), to: today },
    { label: 'Last month', from: monthStart(lastMonthEnd), to: lastMonthEnd },
  ];
}

function display(value: ReportCell, type: ReportColumn['type']): string {
  if (value === null || value === '') return '';
  if (type === 'money') return formatINR(Number(value));
  if (type === 'percent') return value + '%';
  if (type === 'datetime') return formatDateTime(String(value));
  if (type === 'date') return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(String(value)));
  return String(value);
}

/** Hands a downloaded file to the browser to save under the given name. */
function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const FORMATS: { id: ReportFormat; label: string }[] = [{ id: 'csv', label: 'CSV' }, { id: 'xlsx', label: 'Excel' }, { id: 'pdf', label: 'PDF' }];

interface ReportViewerProps {
  /** Something to show beside the report's title, such as the back office's Share button. */
  action?: (report: { type: ReportType; title: string }) => ReactNode;
}

/**
 * The reports the signed-in person may open, with a period picker, headline totals, the table and downloads.
 * Someone whose role does not include every report sees only the ones shared with them.
 * Used by the back office and by the billing screen.
 */
export function ReportViewer({ action }: ReportViewerProps) {
  const api = useApi();
  // Asked afresh every time the screen opens, so a report shared a moment ago is there.
  const available = useQuery({ queryKey: ['reports-available'], queryFn: api.reports.available, staleTime: 0, refetchOnMount: 'always' });
  const reports = REPORTS.filter((report) => available.data?.types.includes(report.type));
  const [type, setType] = useState<ReportType>('sales-daily');
  useEffect(() => {
    if (available.data && !available.data.types.includes(type) && available.data.types[0]) setType(available.data.types[0]);
  }, [available.data, type]);
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const definition = REPORTS.find((report) => report.type === type)!;
  const validRange = Boolean(from && to) && from <= to;
  const allowed = available.data?.types.includes(type) ?? false;

  const report = useQuery({
    queryKey: ['report', type, from, to],
    queryFn: () => api.reports.run(type, { from, to }),
    enabled: validRange && allowed,
    placeholderData: keepPreviousData,
  });
  const exporter = useMutation({
    mutationFn: (format: ReportFormat) => api.reports.export(type, { from, to }, format).then((blob) => ({ blob, format })),
    onSuccess: ({ blob, format }) => saveFile(blob, type + '_' + from + '_to_' + to + '.' + format),
    onError: (error) => toast.error(errorMessage(error)),
  });

  const control = 'h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink-700';
  const data = report.data;
  // Any column can be sorted. A sort carries over to the next report only if that report has the same column.
  const sorter = useSorter();
  const sort = sorter.state && data?.columns.some((column) => column.key === sorter.state!.key) ? sorter.state : null;
  const rows = sortRows(data?.rows ?? [], sort, (row, key) => row[key]);

  if (available.isPending) return <LoadingState />;
  if (available.isError) return <ErrorState message={errorMessage(available.error)} onRetry={() => void available.refetch()} />;
  if (reports.length === 0) {
    return (
      <Card>
        <EmptyState icon={FileBarChart} title="No reports have been shared with you" description="Ask the owner or a manager to share a report with you. It will appear here as soon as they do." />
      </Card>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
      <nav aria-label="Reports">
        <select aria-label="Report" value={type} onChange={(event) => setType(event.target.value as ReportType)} className={cn(control, 'w-full lg:hidden')}>
          {reports.map((entry) => <option key={entry.type} value={entry.type}>{entry.title}</option>)}
        </select>
        <ul className="hidden space-y-0.5 lg:block">
          {reports.map((entry) => (
            <li key={entry.type}>
              <button
                type="button" onClick={() => setType(entry.type)} aria-current={entry.type === type ? 'true' : undefined}
                className={cn(
                  'w-full rounded-lg px-3 py-2 text-left text-sm font-medium',
                  entry.type === type ? 'bg-surface text-brand-700 shadow-(--shadow-card) ring-1 ring-line' : 'text-ink-700 hover:bg-surface',
                )}
              >
                {entry.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <Card className="min-w-0">
        <div className="border-b border-line p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-ink-900">{definition.title}</h2>
              <p className="mt-0.5 text-sm text-ink-500">{definition.description}</p>
            </div>
            {allowed && action?.({ type, title: definition.title })}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {presets().map((preset) => (
              <button
                key={preset.label} type="button" aria-pressed={preset.from === from && preset.to === to}
                onClick={() => { setFrom(preset.from); setTo(preset.to); }}
                className={cn('h-9 rounded-full border px-3.5 text-sm font-medium', preset.from === from && preset.to === to ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line text-ink-700 hover:bg-canvas')}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-ink-500">From <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} className={control} /></label>
            <label className="flex items-center gap-2 text-sm text-ink-500">To <input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} className={control} /></label>
            <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:flex-nowrap">
              <span className="w-full text-sm text-ink-500 sm:w-auto">Download</span>
              {FORMATS.map((format) => (
                <Button
                  key={format.id} variant="secondary" className="flex-1 px-2! sm:flex-none sm:px-4!" disabled={!validRange || !allowed || exporter.isPending} loading={exporter.isPending && exporter.variables === format.id}
                  onClick={() => exporter.mutate(format.id)} aria-label={'Download as ' + format.label}
                >
                  <Download className="size-4" /> {format.label}
                </Button>
              ))}
            </div>
          </div>
        </div>

        {!allowed ? (
          <LoadingState />
        ) : !validRange ? (
          <EmptyState icon={FileBarChart} title="Choose a period" description="The start date must be on or before the end date." />
        ) : report.isPending ? (
          <LoadingState label="Running the report" />
        ) : report.isError || !data ? (
          <ErrorState message={errorMessage(report.error)} onRetry={() => void report.refetch()} />
        ) : (
          <>
            {data.summary.length > 0 && (
              <dl className="flex flex-wrap overflow-hidden border-b border-line" aria-label="Report totals">
                {data.summary.map((figure) => (
                  <div key={figure.label} className="-mb-px -mr-px grow basis-36 border-b border-r border-line bg-surface px-3 py-3 sm:basis-44 sm:px-4 sm:py-4">
                    <dt className="text-sm text-ink-500">{figure.label}</dt>
                    <dd className="mt-1 whitespace-nowrap text-xl font-semibold tracking-tight tabular-nums text-ink-900 sm:text-2xl">
                      {figure.type === 'money' ? formatINR(figure.value) : figure.value.toLocaleString('en-IN')}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {data.note && <p className="border-b border-line bg-canvas/60 px-4 py-2.5 text-sm text-ink-700">{data.note}</p>}
            {data.truncated && <p role="alert" className="border-b border-line bg-amber-50 px-4 py-2.5 text-sm text-amber-800">Only the first 5,000 rows are shown. Choose a shorter period to see everything.</p>}
            {data.rows.length === 0 ? (
              <EmptyState icon={FileBarChart} title="Nothing to report for this period" description="Try a different period, or check that bills were issued on these dates." />
            ) : (
              <div className={cn('overflow-x-auto', report.isPlaceholderData && 'opacity-60')}>
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      {data.columns.map((column) => (
                        <Th key={column.key} sorter={{ state: sort, toggle: sorter.toggle }} sortKey={column.key} className={cn('whitespace-nowrap', NUMERIC.has(column.type) && 'text-right')}>
                          {column.label}
                        </Th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={index} className="hover:bg-canvas/50">
                        {data.columns.map((column, position) => (
                          <td key={column.key} className={cn('border-b border-line px-4 py-2.5 text-ink-700', NUMERIC.has(column.type) ? 'whitespace-nowrap text-right tabular-nums' : column.type !== 'text' && 'whitespace-nowrap', position === 0 && 'font-medium text-ink-900')}>
                            {display(row[column.key] ?? null, column.type)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  {data.totals && (
                    <tfoot>
                      <tr className="bg-canvas/60 font-semibold text-ink-900">
                        {data.columns.map((column, position) => (
                          <td key={column.key} className={cn('whitespace-nowrap px-4 py-3', NUMERIC.has(column.type) && 'text-right tabular-nums')}>
                            {position === 0 ? 'Total' : column.key in data.totals! ? display(data.totals![column.key]!, column.type) : ''}
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
