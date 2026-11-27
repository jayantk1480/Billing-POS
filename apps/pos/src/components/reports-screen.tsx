'use client';

import { Button, ReportViewer } from '@pos/ui';
import { ArrowLeft } from 'lucide-react';
import { useEffect } from 'react';

/** The reports this person may open, shown over the billing screen. The order being taken stays as it was underneath. */
export function ReportsScreen({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-canvas" role="dialog" aria-modal="true" aria-label="Reports">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
        <Button variant="secondary" onClick={onClose} autoFocus><ArrowLeft className="size-4" /> Back to billing</Button>
        <h1 className="text-base font-semibold text-ink-900">Reports</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4 lg:p-6">
        <ReportViewer />
      </div>
    </div>
  );
}
