'use client';

import { Button, Checkbox, Dialog, ErrorState, errorMessage, LoadingState, PageHeader, ReportViewer, toast, useApi, useAuth } from '@pos/ui';
import type { ReportType } from '@pos/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Share2 } from 'lucide-react';
import { useState } from 'react';

/** Choose which people, among those who cannot already see every report, may open this one. */
function ShareDialog({ type, title, onClose }: { type: ReportType; title: string; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const sharing = useQuery({ queryKey: ['report-sharing'], queryFn: api.reports.sharing });
  const [chosen, setChosen] = useState<string[] | null>(null);
  const selected = chosen ?? sharing.data?.shares[type] ?? [];
  const save = useMutation({
    mutationFn: () => api.reports.share(type, selected),
    onSuccess: (updated) => {
      queryClient.setQueryData(['report-sharing'], updated);
      toast.success(selected.length === 0 ? title + ' is no longer shared with anyone.' : title + ' shared with ' + selected.length + (selected.length === 1 ? ' person.' : ' people.'));
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog
      open onClose={onClose} size="sm" title={'Share ' + title}
      description="The people you tick can open this one report, for any dates, from Reports in the menu on their billing screen. They see the whole restaurant's figures in it, not only their own."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!sharing.data}>Save</Button>
        </>
      }
    >
      {sharing.isPending ? <LoadingState /> : sharing.isError ? <ErrorState message={errorMessage(sharing.error)} onRetry={() => void sharing.refetch()} /> : sharing.data.candidates.length === 0 ? (
        <p className="text-sm text-ink-500">Everyone on your team can already see all reports through their role. Add a biller under Team → Users to share with them.</p>
      ) : (
        <ul className="space-y-3" aria-label="People to share with">
          {sharing.data.candidates.map((person) => (
            <li key={person.id}>
              <Checkbox
                checked={selected.includes(person.id)}
                onChange={(checked) => setChosen(checked ? [...selected, person.id] : selected.filter((id) => id !== person.id))}
                label={<><span className="font-medium text-ink-900">{person.name}</span> <span className="text-ink-500">· {person.roleName}</span></>}
              />
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export default function ReportsPage() {
  const api = useApi();
  const { can } = useAuth();
  const canShare = can('report.share');
  const shares = useQuery({ queryKey: ['report-sharing'], queryFn: api.reports.sharing, enabled: canShare });
  const [sharing, setSharing] = useState<{ type: ReportType; title: string } | null>(null);

  return (
    <>
      <PageHeader title="Reports" description="Figures come from bills, payments and credit notes, so they always match the paper. An order counts as a sale once it is paid in full; cancelled bills are left out." />
      <ReportViewer
        action={canShare ? (report) => {
          const sharedWith = shares.data?.shares[report.type]?.length ?? 0;
          return (
            <Button variant="secondary" onClick={() => setSharing(report)} aria-label={'Share ' + report.title}>
              <Share2 className="size-4" /> {sharedWith > 0 ? 'Shared with ' + sharedWith : 'Share'}
            </Button>
          );
        } : undefined}
      />
      {sharing && <ShareDialog type={sharing.type} title={sharing.title} onClose={() => setSharing(null)} />}
    </>
  );
}
