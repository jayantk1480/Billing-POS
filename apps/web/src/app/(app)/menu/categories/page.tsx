'use client';

import {
  Badge, Button, Card, cn, ConfirmDialog, Dialog, EmptyState, ErrorState, errorMessage, InlineSwitch, LoadingState, PageHeader,
  Switch, TextField, toast, useApi, useAuth, useFormState,
} from '@pos/ui';
import { type CategoryDto, categorySchema } from '@pos/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, LayoutGrid, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

const COLOURS = ['#f97316', '#dc2626', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#9333ea', '#db2777', '#475569'];

function CategoryDialog({ category, onClose, onSaved }: { category: CategoryDto | null; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const form = useFormState({ name: category?.name ?? '', color: category?.color ?? COLOURS[0]!, isActive: category?.isActive ?? true });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const saved = await form.submit(categorySchema, form.values, (data) =>
      category ? api.categories.update(category.id, data) : api.categories.create(data),
    );
    if (saved) {
      toast.success(category ? 'Category updated' : 'Category added');
      onSaved();
    }
  }

  return (
    <Dialog
      open onClose={onClose} size="sm" title={category ? 'Edit category' : 'Add category'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="category-form" loading={form.submitting}>{category ? 'Save changes' : 'Add category'}</Button>
        </>
      }
    >
      <form id="category-form" onSubmit={onSubmit} noValidate className="space-y-5">
        <TextField label="Name" value={form.values.name} onChange={(v) => form.set('name', v)} error={form.errors.name} autoFocus />
        <div>
          <p className="mb-2 text-sm font-medium text-ink-700">Colour on the billing screen</p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
            {COLOURS.map((colour) => (
              <button
                key={colour} type="button" role="radio" aria-checked={form.values.color === colour} aria-label={colour}
                onClick={() => form.set('color', colour)}
                className={cn('size-8 rounded-full ring-offset-2 transition-shadow', form.values.color === colour && 'ring-2 ring-ink-900')}
                style={{ backgroundColor: colour }}
              />
            ))}
          </div>
        </div>
        <Switch label="Active" description="Inactive categories are hidden from billing" checked={form.values.isActive} onChange={(v) => form.set('isActive', v)} />
      </form>
    </Dialog>
  );
}

export default function CategoriesPage() {
  const api = useApi();
  const canManage = useAuth().can('menu.manage');
  const queryClient = useQueryClient();
  const categories = useQuery({ queryKey: ['categories'], queryFn: api.categories.list });
  const [editing, setEditing] = useState<CategoryDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CategoryDto | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['categories'] });
  const onError = (error: unknown) => toast.error(errorMessage(error));

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.categories.reorder(ids),
    onSuccess: (updated) => queryClient.setQueryData(['categories'], updated),
    onError,
  });
  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.categories.update(id, { isActive }),
    onSuccess: () => refresh(),
    onError,
  });
  const remove = useMutation({
    mutationFn: (category: CategoryDto) => api.categories.remove(category.id),
    onSuccess: (_result, category) => {
      toast.success(`${category.name} deleted`);
      setDeleting(null);
      void refresh();
    },
    onError: (error) => {
      setDeleting(null);
      onError(error);
    },
  });

  function move(index: number, direction: -1 | 1) {
    const ids = (categories.data ?? []).map((c) => c.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate(ids);
  }

  return (
    <>
      <PageHeader
        title="Categories"
        description="Groups shown on the billing screen, in this order."
        action={canManage && <Button onClick={() => setEditing('new')}><Plus className="size-4" /> Add category</Button>}
      />
      <Card>
        {categories.isPending ? (
          <LoadingState label="Loading categories" />
        ) : categories.isError ? (
          <ErrorState message={errorMessage(categories.error)} onRetry={() => void categories.refetch()} />
        ) : categories.data.length === 0 ? (
          <EmptyState
            icon={LayoutGrid} title="No categories yet" description="Start with groups such as Starters, Main Course and Beverages."
            action={canManage && <Button onClick={() => setEditing('new')}><Plus className="size-4" /> Add category</Button>}
          />
        ) : (
          <ul className="divide-y divide-line">
            {categories.data.map((category, index) => (
              <li key={category.id} className="flex items-center gap-3 px-4 py-3">
                {canManage && (
                  <div className="flex flex-col">
                    <button type="button" aria-label={`Move ${category.name} up`} disabled={index === 0 || reorder.isPending} onClick={() => move(index, -1)} className="rounded p-0.5 text-ink-500 hover:bg-canvas hover:text-ink-900 disabled:opacity-30">
                      <ArrowUp className="size-4" />
                    </button>
                    <button type="button" aria-label={`Move ${category.name} down`} disabled={index === categories.data.length - 1 || reorder.isPending} onClick={() => move(index, 1)} className="rounded p-0.5 text-ink-500 hover:bg-canvas hover:text-ink-900 disabled:opacity-30">
                      <ArrowDown className="size-4" />
                    </button>
                  </div>
                )}
                <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: category.color ?? '#cbd5e1' }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">{category.name}</p>
                  <p className="text-xs text-ink-500">{category.productCount} {category.productCount === 1 ? 'product' : 'products'}</p>
                </div>
                {!category.isActive && <Badge tone="neutral">Hidden</Badge>}
                {canManage && (
                  <>
                    <InlineSwitch label={`${category.name} active`} checked={category.isActive} disabled={setActive.isPending} onChange={(isActive) => setActive.mutate({ id: category.id, isActive })} />
                    <button type="button" aria-label={`Edit ${category.name}`} onClick={() => setEditing(category)} className="rounded-lg p-2 text-ink-500 hover:bg-canvas hover:text-ink-900">
                      <Pencil className="size-4" />
                    </button>
                    <button type="button" aria-label={`Delete ${category.name}`} onClick={() => setDeleting(category)} className="rounded-lg p-2 text-ink-500 hover:bg-red-50 hover:text-danger">
                      <Trash2 className="size-4" />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && (
        <CategoryDialog
          category={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting)}
        title="Delete category" confirmLabel="Delete" danger loading={remove.isPending}
        message={<>Delete <strong>{deleting?.name}</strong>? A category can only be deleted when it has no products.</>}
      />
    </>
  );
}
