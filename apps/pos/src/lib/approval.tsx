'use client';

import { ApiRequestError } from '@pos/api-client';
import { Button, Dialog, SelectField, toast, useApi } from '@pos/ui';
import type { ApprovalInput, PinUser } from '@pos/validation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { PinPad } from '@/components/pin-pad';

/** Thrown when the manager PIN dialog is dismissed; callers treat it as "nothing happened". */
export class ApprovalCancelled extends Error {}

type Run = <T>(action: (approval?: ApprovalInput) => Promise<T>) => Promise<T>;
const ApprovalContext = createContext<Run | null>(null);

interface Request {
  message: string;
  error: string | null;
  resolve: (approval: ApprovalInput | null) => void;
}

/**
 * Runs an action; if the server says a manager must approve it, asks for a manager's PIN at
 * this terminal and runs it again with that sign-off.
 */
export function ApprovalProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);

  const run = useCallback<Run>(async (action) => {
    try {
      return await action();
    } catch (first) {
      if (!(first instanceof ApiRequestError) || first.code !== 'APPROVAL_REQUIRED') throw first;
      let error: string | null = null;
      for (;;) {
        const approval = await new Promise<ApprovalInput | null>((resolve) => setRequest({ message: first.message, error, resolve }));
        if (!approval) {
          setRequest(null);
          throw new ApprovalCancelled();
        }
        try {
          const result = await action(approval);
          setRequest(null);
          return result;
        } catch (again) {
          if (again instanceof ApiRequestError && (again.code === 'APPROVAL_INVALID' || again.code === 'APPROVAL_LOCKED')) {
            error = again.message;
            continue;
          }
          setRequest(null);
          throw again;
        }
      }
    }
  }, []);

  return (
    <ApprovalContext value={run}>
      {children}
      {request && <ApprovalDialog key={request.error ?? 'first'} request={request} />}
    </ApprovalContext>
  );
}

export function useApproval(): Run {
  const run = useContext(ApprovalContext);
  if (!run) throw new Error('useApproval must be used inside ApprovalProvider');
  return run;
}

/** Shows a failure to the cashier, unless they simply closed the manager PIN dialog. */
export function reportError(error: unknown): void {
  if (error instanceof ApprovalCancelled) return;
  toast.error(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
}

function ApprovalDialog({ request }: { request: Request }) {
  const api = useApi();
  const [users, setUsers] = useState<PinUser[]>([]);
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');

  useEffect(() => {
    void api.auth.pinUsers().then(setUsers, () => setUsers([]));
  }, [api]);

  return (
    <Dialog
      open onClose={() => request.resolve(null)} size="sm" title="Manager approval" description={request.message}
      footer={
        <>
          <Button variant="secondary" size="touch" onClick={() => request.resolve(null)}>Cancel</Button>
          <Button size="touch" disabled={!userId || pin.length < 4} onClick={() => request.resolve({ userId, pin })}>Approve</Button>
        </>
      }
    >
      <div className="space-y-4">
        <SelectField
          label="Approving manager" value={userId} onChange={setUserId} placeholder="Choose a manager"
          options={users.map((user) => ({ value: user.id, label: `${user.name} (${user.roleName})` }))}
        />
        <PinPad value={pin} onChange={setPin} label="Manager PIN" error={request.error} />
      </div>
    </Dialog>
  );
}
