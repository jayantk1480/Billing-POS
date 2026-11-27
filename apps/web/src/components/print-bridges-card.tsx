'use client';

import { Badge, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, ErrorState, errorMessage, formatDateTime, LoadingState, TextField, toast, useApi, useFormState } from '@pos/ui';
import { type BridgeCreatedDto, type BridgeDto, createBridgeSchema } from '@pos/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cable, Copy, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { API_URL } from '@/lib/api';

function AddBridgeDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (bridge: BridgeCreatedDto) => void }) {
  const api = useApi();
  const form = useFormState({ name: '' });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await form.submit(createBridgeSchema, form.values, async (data) => onCreated(await api.printing.createBridge(data)));
  }

  return (
    <Dialog
      open onClose={onClose} size="sm" title="Add print bridge" description="Name it after the computer it will run on."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="bridge-form" loading={form.submitting}>Add print bridge</Button>
        </>
      }
    >
      <form id="bridge-form" onSubmit={onSubmit} noValidate>
        <TextField label="Name" value={form.values.name} onChange={(v) => form.set('name', v)} error={form.errors.name} autoFocus placeholder="Counter computer" />
      </form>
    </Dialog>
  );
}

/** Shows the token of a bridge that was just added. The server never sends it again, so it lives only in this dialog. */
function TokenDialog({ bridge, onClose }: { bridge: BridgeCreatedDto; onClose: () => void }) {
  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error('Could not copy. Select the text and copy it yourself.');
    }
  }
  const field = 'block h-10 w-full min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 font-mono text-xs text-ink-900';

  return (
    <Dialog open onClose={onClose} title={`${bridge.name} added`} description="Finish setting it up on the counter computer." footer={<Button onClick={onClose}>I have saved the token</Button>}>
      <div className="space-y-5 text-sm">
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2.5 text-amber-700">
          Copy this token now. It cannot be shown again after you close this window. If it is lost, remove the bridge and add a new one.
        </p>
        <div>
          <label htmlFor="bridge-token" className="mb-1.5 block text-sm font-medium text-ink-700">Token</label>
          <div className="flex gap-2">
            <input id="bridge-token" readOnly value={bridge.token} onFocus={(event) => event.target.select()} className={field} />
            <Button variant="secondary" onClick={() => void copy(bridge.token, 'Token')}><Copy className="size-4" /> Copy</Button>
          </div>
        </div>
        <div>
          <label htmlFor="bridge-server" className="mb-1.5 block text-sm font-medium text-ink-700">Server address</label>
          <div className="flex gap-2">
            <input id="bridge-server" readOnly value={API_URL} onFocus={(event) => event.target.select()} className={field} />
            <Button variant="secondary" onClick={() => void copy(API_URL, 'Server address')}><Copy className="size-4" /> Copy</Button>
          </div>
        </div>
        <div>
          <p className="font-medium text-ink-900">Setting up</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-ink-700">
            <li>Install the print bridge on the computer at the counter, the one the printers are connected to.</li>
            <li>Set <code className="rounded bg-canvas px-1 py-0.5 font-mono text-xs text-ink-900">PRINT_BRIDGE_TOKEN</code> to the token above.</li>
            <li>Set <code className="rounded bg-canvas px-1 py-0.5 font-mono text-xs text-ink-900">PRINT_BRIDGE_API_URL</code> to the server address above.</li>
            <li>Start the print bridge. Within half a minute it shows as Connected on this page.</li>
          </ol>
        </div>
      </div>
    </Dialog>
  );
}

export function PrintBridgesCard() {
  const api = useApi();
  const queryClient = useQueryClient();
  // Asked again every ten seconds, so "Connected" follows the bridge being started or stopped.
  const bridges = useQuery({ queryKey: ['print-bridges'], queryFn: api.printing.bridges, refetchInterval: 10_000 });
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<BridgeCreatedDto | null>(null);
  const [removing, setRemoving] = useState<BridgeDto | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['print-bridges'] });

  const remove = useMutation({
    mutationFn: (bridge: BridgeDto) => api.printing.removeBridge(bridge.id),
    onSuccess: (_result, bridge) => {
      toast.success(`${bridge.name} removed`);
      setRemoving(null);
      void refresh();
    },
    onError: (error) => {
      setRemoving(null);
      toast.error(errorMessage(error));
    },
  });
  const addButton = <Button className="shrink-0 whitespace-nowrap" onClick={() => setAdding(true)}><Plus className="size-4" /> Add print bridge</Button>;

  return (
    <Card>
      <CardHeader
        title="Print bridge" description="A small program on the counter computer that passes bills and kitchen tickets to the printers. Printers that print through the browser do not need it."
        action={bridges.data && bridges.data.length > 0 ? addButton : undefined}
      />
      {bridges.isPending ? (
        <LoadingState label="Loading print bridges" />
      ) : bridges.isError ? (
        <ErrorState message={errorMessage(bridges.error)} onRetry={() => void bridges.refetch()} />
      ) : bridges.data.length === 0 ? (
        <EmptyState icon={Cable} title="No print bridge yet" description="Add one to print on network, USB or Bluetooth printers straight from the billing screen." action={addButton} />
      ) : (
        <ul className="divide-y divide-line">
          {bridges.data.map((bridge) => (
            <li key={bridge.id} className="flex items-center gap-3 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-900">{bridge.name}</p>
                <p className="text-xs text-ink-500">
                  {bridge.lastSeenAt ? `Last seen ${formatDateTime(bridge.lastSeenAt)}` : 'Has not connected yet'}{bridge.version && ` · version ${bridge.version}`}
                </p>
              </div>
              <Badge tone={bridge.online ? 'ok' : 'danger'}>{bridge.online ? 'Connected' : 'Not connected'}</Badge>
              <button type="button" aria-label={`Remove ${bridge.name}`} onClick={() => setRemoving(bridge)} className="rounded-lg p-2 text-ink-500 hover:bg-red-50 hover:text-danger">
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <AddBridgeDialog
          onClose={() => setAdding(false)}
          onCreated={(bridge) => {
            setAdding(false);
            setCreated(bridge);
            void refresh();
          }}
        />
      )}
      {created && <TokenDialog bridge={created} onClose={() => setCreated(null)} />}
      <ConfirmDialog
        open={removing !== null} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing)}
        title="Remove print bridge" confirmLabel="Remove" danger loading={remove.isPending}
        message={<>Remove <strong>{removing?.name}</strong>? Its token stops working at once, and printing through it stops until a new bridge is added and set up.</>}
      />
    </Card>
  );
}
