'use client';

import { X } from 'lucide-react';
import { Dialog as RadixDialog } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../cn';
import { Button } from './button';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  footer?: ReactNode;
}

const WIDTHS = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' };

/** A modal dialog: traps focus, closes on Escape, and scrolls its body when the content is tall. */
export function Dialog({ open, onClose, title, description, size = 'md', children, footer }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-[1px]" />
        <RadixDialog.Content
          aria-describedby={description ? undefined : undefined}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[94dvh] w-[calc(100vw-1.5rem)] sm:max-h-[90dvh] short:max-h-[96dvh] sm:w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col',
            'rounded-2xl bg-surface shadow-2xl outline-none',
            WIDTHS[size],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 short:py-2.5 sm:px-6">
            <div>
              <RadixDialog.Title className="text-base font-semibold text-ink-900">{title}</RadixDialog.Title>
              <RadixDialog.Description className={cn('mt-0.5 text-sm text-ink-500', !description && 'sr-only')}>
                {description ?? title}
              </RadixDialog.Description>
            </div>
            <RadixDialog.Close className="rounded-lg p-1.5 text-ink-500 hover:bg-canvas hover:text-ink-900" aria-label="Close">
              <X className="size-4" />
            </RadixDialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-4 short:py-2.5 sm:px-6">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

interface ConfirmProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => unknown;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel, danger, loading }: ConfirmProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => void onConfirm()} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-ink-700">{message}</div>
    </Dialog>
  );
}
