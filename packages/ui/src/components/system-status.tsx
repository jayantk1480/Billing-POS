'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from './badge';
import { Button } from './button';
import { Card, CardHeader } from './card';

export interface SystemHealth {
  status: 'ok' | 'degraded';
  version: string;
  database: 'up' | 'down';
  redis: 'up' | 'down';
}

type State = { phase: 'loading' } | { phase: 'ready'; health: SystemHealth } | { phase: 'error'; message: string };

/** Shows live API, database and Redis status. `load` performs the real health request. */
export function SystemStatus({ load, apiUrl }: { load: () => Promise<SystemHealth>; apiUrl: string }) {
  const [state, setState] = useState<State>({ phase: 'loading' });

  const refresh = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      setState({ phase: 'ready', health: await load() });
    } catch (error) {
      setState({ phase: 'error', message: error instanceof Error ? error.message : 'Request failed' });
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows: Array<[string, 'up' | 'down' | undefined]> = [
    ['API server', state.phase === 'ready' ? 'up' : state.phase === 'error' ? 'down' : undefined],
    ['Database', state.phase === 'ready' ? state.health.database : undefined],
    ['Redis', state.phase === 'ready' ? state.health.redis : undefined],
  ];

  return (
    <Card>
      <CardHeader
        title="System status"
        description={apiUrl}
        action={
          <Button variant="secondary" size="sm" onClick={refresh} loading={state.phase === 'loading'}>
            Refresh
          </Button>
        }
      />
      <ul className="divide-y divide-line">
        {rows.map(([label, value]) => (
          <li key={label} className="flex items-center justify-between px-5 py-3.5 text-sm">
            <span className="text-ink-700">{label}</span>
            {value === undefined ? (
              <Badge tone="neutral">{state.phase === 'loading' ? 'Checking' : 'Unknown'}</Badge>
            ) : (
              <Badge tone={value === 'up' ? 'ok' : 'danger'}>{value === 'up' ? 'Connected' : 'Unreachable'}</Badge>
            )}
          </li>
        ))}
      </ul>
      {state.phase === 'error' && (
        <p role="alert" className="border-t border-line px-5 py-3 text-sm text-danger">
          Could not reach the API: {state.message}. Check that it is running, then refresh.
        </p>
      )}
    </Card>
  );
}
