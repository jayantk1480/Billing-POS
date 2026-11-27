'use client';

import { PageHeader } from '@pos/ui';
import { PrintBridgesCard } from '@/components/print-bridges-card';
import { PrintLayoutsCard } from '@/components/print-layouts-card';
import { PrintQueueCard } from '@/components/print-queue-card';
import { PrintersCard } from '@/components/printers-card';

export default function PrintersPage() {
  return (
    <>
      <PageHeader title="Printers" description="Set up the printers for bills and kitchen tickets, choose what is printed on them, and see what was sent to print." />
      <div className="space-y-6">
        <PrintBridgesCard />
        <PrintersCard />
        <PrintLayoutsCard />
        <PrintQueueCard />
      </div>
    </>
  );
}
