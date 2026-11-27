'use client';

import { formatINR } from '@pos/billing-core';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, errorMessage, InlineSwitch, LoadingState, PageHeader, Table, Td, Th, toast, useApi, useAuth, useSorter,
} from '@pos/ui';
import type { ProductDto, ProductQuery } from '@pos/validation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FileSpreadsheet, Pencil, Plus, Search, Star, Trash2, UtensilsCrossed } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FoodMark } from '@/components/food-mark';
import { ImportProductsDialog } from '@/components/import-products-dialog';
import { ProductDialog } from '@/components/product-dialog';

const PAGE_SIZE = 25;
/** The most products the API deletes in one request; a larger selection goes in parts. */
const DELETE_BATCH = 500;
const CHECKBOX = 'size-4 cursor-pointer rounded border-ink-300 align-middle accent-brand-600';

export default function ProductsPage() {
  const api = useApi();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canManage = can('menu.manage');
  const canToggle = can('menu.availability');

  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [availability, setAvailability] = useState<'' | 'available' | 'unavailable'>('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ProductDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ProductDto | null>(null);
  const [importing, setImporting] = useState(false);
  // Products ticked for deleting together. The ticks survive paging and sorting, and are dropped when the search or a filter changes.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deletingSelected, setDeletingSelected] = useState(false);

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchText]);

  useEffect(() => setSelected(new Set()), [search, categoryId, availability]);

  // Sorting is done by the server, across every page of the list, so a new sort starts again from page one.
  const sorter = useSorter(null, () => setPage(1));
  const filters = {
    search: search || undefined, categoryId: categoryId || undefined, availability: availability || undefined, page, pageSize: PAGE_SIZE,
    sort: sorter.state?.key as ProductQuery['sort'], direction: sorter.state?.direction,
  };
  const products = useQuery({ queryKey: ['products', filters], queryFn: () => api.products.list(filters), placeholderData: keepPreviousData });
  const categories = useQuery({ queryKey: ['categories'], queryFn: api.categories.list });
  const taxGroups = useQuery({ queryKey: ['tax-groups'], queryFn: api.taxGroups.list });
  const stations = useQuery({ queryKey: ['stations'], queryFn: api.stations.list });
  const modifierGroups = useQuery({ queryKey: ['modifier-groups'], queryFn: api.modifierGroups.list });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['products'] });
    void queryClient.invalidateQueries({ queryKey: ['categories'] });
  };

  const toggle = useMutation({
    mutationFn: ({ id, isAvailable }: { id: string; isAvailable: boolean }) => api.products.setAvailability(id, isAvailable),
    onSuccess: (updated) => {
      toast.success(`${updated.name} is now ${updated.isAvailable ? 'available' : 'unavailable'}`);
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (product: ProductDto) => api.products.remove(product.id),
    onSuccess: (_result, product) => {
      toast.success(`${product.name} deleted`);
      setDeleting(null);
      setSelected((current) => new Set([...current].filter((id) => id !== product.id)));
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const removeSelected = useMutation({
    mutationFn: async () => {
      const ids = [...selected];
      let deleted = 0;
      for (let start = 0; start < ids.length; start += DELETE_BATCH) deleted += (await api.products.bulkRemove(ids.slice(start, start + DELETE_BATCH))).deleted;
      return deleted;
    },
    onSuccess: (deleted) => {
      toast.success(`${deleted} ${deleted === 1 ? 'product' : 'products'} deleted`);
      setDeletingSelected(false);
      setSelected(new Set());
      setPage(1);
      refresh();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
      refresh();
    },
  });
  // Ticks every product that matches the search and filters, on every page of the list.
  const selectEverything = useMutation({
    mutationFn: async () => {
      const ids: string[] = [];
      for (let next = 1; ; next++) {
        const batch = await api.products.list({ ...filters, page: next, pageSize: 200 });
        ids.push(...batch.items.map((product) => product.id));
        if (batch.items.length === 0 || ids.length >= batch.total) return ids;
      }
    },
    onSuccess: (ids) => setSelected(new Set(ids)),
    onError: (error) => toast.error(errorMessage(error)),
  });

  const taxName = (id: string | null) => (id ? (taxGroups.data?.find((t) => t.id === id)?.name ?? '—') : 'Default');
  const total = products.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Boolean(search || categoryId || availability);
  const formReady = categories.data && taxGroups.data && stations.data && modifierGroups.data;

  const pageIds = products.data?.items.map((product) => product.id) ?? [];
  const pageTicked = pageIds.filter((id) => selected.has(id)).length;
  const wholePageTicked = pageIds.length > 0 && pageTicked === pageIds.length;
  const tick = (ids: string[], on: boolean) =>
    setSelected((current) => new Set(on ? [...current, ...ids] : [...current].filter((id) => !ids.includes(id))));

  return (
    <>
      <PageHeader
        title="Products"
        description="Everything you sell. Prices, tax and kitchen routing set here apply at every billing counter."
        action={
          canManage && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setImporting(true)} disabled={!formReady}>
                <FileSpreadsheet className="size-4" /> Add in bulk
              </Button>
              <Button onClick={() => setEditing('new')} disabled={!formReady || categories.data?.length === 0}>
                <Plus className="size-4" /> Add product
              </Button>
            </div>
          )
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
            <input
              type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search by name or short code"
              aria-label="Search products"
              className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm placeholder:text-ink-300 hover:border-ink-300"
            />
          </div>
          <select
            aria-label="Filter by category" value={categoryId}
            onChange={(e) => { setCategoryId(e.target.value); setPage(1); }}
            className="h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink-700"
          >
            <option value="">All categories</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.productCount})
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by availability" value={availability}
            onChange={(e) => { setAvailability(e.target.value as typeof availability); setPage(1); }}
            className="h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink-700"
          >
            <option value="">Any availability</option>
            <option value="available">Available</option>
            <option value="unavailable">Unavailable</option>
          </select>
        </div>

        {products.isPending ? (
          <LoadingState label="Loading products" />
        ) : products.isError ? (
          <ErrorState message={errorMessage(products.error)} onRetry={() => void products.refetch()} />
        ) : products.data.items.length === 0 ? (
          filtered ? (
            <EmptyState icon={Search} title="No products match" description="Try a different search or clear the filters." />
          ) : categories.data?.length === 0 ? (
            <EmptyState
              icon={UtensilsCrossed} title="Create a category first"
              description="Products live inside categories. Add one on the Categories page, or add products in bulk from a spreadsheet and the categories are created for you."
              action={canManage && <Button variant="secondary" onClick={() => setImporting(true)} disabled={!formReady}><FileSpreadsheet className="size-4" /> Add in bulk</Button>}
            />
          ) : (
            <EmptyState
              icon={UtensilsCrossed} title="No products yet" description="Add your first dish to start building the menu."
              action={canManage && <Button onClick={() => setEditing('new')}><Plus className="size-4" /> Add product</Button>}
            />
          )
        ) : (
          <>
            {selected.size > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-brand-50 px-4 py-2.5 text-sm" role="region" aria-label="Selected products">
                <span className="font-medium text-ink-900">{selected.size} selected</span>
                {wholePageTicked && selected.size < total && (
                  <button type="button" className="font-medium text-brand-700 hover:underline disabled:opacity-60" disabled={selectEverything.isPending} onClick={() => selectEverything.mutate()}>
                    Select all {total}{filtered ? ' that match' : ''}
                  </button>
                )}
                <button type="button" className="text-ink-700 hover:underline" onClick={() => setSelected(new Set())}>Clear selection</button>
                <Button variant="danger" size="sm" className="ml-auto" onClick={() => setDeletingSelected(true)}>
                  <Trash2 className="size-4" /> Delete selected
                </Button>
              </div>
            )}
            <Table>
              <thead>
                <tr>
                  {canManage && (
                    <Th className="w-0 pr-0">
                      <input
                        type="checkbox" className={CHECKBOX} aria-label="Select every product on this page" checked={wholePageTicked}
                        ref={(box) => { if (box) box.indeterminate = pageTicked > 0 && !wholePageTicked; }}
                        onChange={(e) => tick(pageIds, e.target.checked)}
                      />
                    </Th>
                  )}
                  <Th sorter={sorter} sortKey="product">Product</Th>
                  <Th sorter={sorter} sortKey="category">Category</Th>
                  <Th sorter={sorter} sortKey="price" className="text-right">Price</Th>
                  <Th sorter={sorter} sortKey="tax">Tax</Th>
                  <Th sorter={sorter} sortKey="available">Available</Th>
                  {canManage && <Th className="w-0"><span className="sr-only">Actions</span></Th>}
                </tr>
              </thead>
              <tbody className={products.isPlaceholderData ? 'opacity-60' : undefined}>
                {products.data.items.map((product) => (
                  <tr key={product.id} className={selected.has(product.id) ? 'bg-brand-50/60' : 'hover:bg-canvas/50'}>
                    {canManage && (
                      <Td className="pr-0">
                        <input
                          type="checkbox" className={CHECKBOX} aria-label={`Select ${product.name}`} checked={selected.has(product.id)}
                          onChange={(e) => tick([product.id], e.target.checked)}
                        />
                      </Td>
                    )}
                    <Td>
                      <div className="flex items-center gap-3">
                        {product.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- served by our API
                          <img src={product.imageUrl} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
                        ) : (
                          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-canvas text-ink-300">
                            <UtensilsCrossed className="size-4" />
                          </span>
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 font-medium text-ink-900">
                            <FoodMark type={product.foodType} />
                            <span className="truncate">{product.name}</span>
                            {product.isFavourite && <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Favourite" />}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-500">
                            {product.shortCode && <span className="rounded bg-canvas px-1.5 py-0.5 font-mono">{product.shortCode}</span>}
                            {!product.isActive && <Badge tone="neutral">Inactive</Badge>}
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td>{product.categoryName}</Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">
                      <span className="font-medium text-ink-900">{formatINR(product.basePricePaise)}</span>
                      {product.variants.length > 0 && <span className="block text-xs text-ink-500">{product.variants.length} variants</span>}
                    </Td>
                    <Td>{taxName(product.taxGroupId)}</Td>
                    <Td>
                      <InlineSwitch
                        label={`${product.name} available`} checked={product.isAvailable} disabled={!canToggle || toggle.isPending}
                        onChange={(isAvailable) => toggle.mutate({ id: product.id, isAvailable })}
                      />
                    </Td>
                    {canManage && (
                      <Td>
                        <div className="flex justify-end gap-1">
                          <button type="button" aria-label={`Edit ${product.name}`} onClick={() => setEditing(product)} disabled={!formReady} className="rounded-lg p-2 text-ink-500 hover:bg-canvas hover:text-ink-900">
                            <Pencil className="size-4" />
                          </button>
                          <button type="button" aria-label={`Delete ${product.name}`} onClick={() => setDeleting(product)} className="rounded-lg p-2 text-ink-500 hover:bg-red-50 hover:text-danger">
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between px-4 py-3 text-sm text-ink-500">
              <span>
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex items-center gap-1">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="px-2 tabular-nums">
                  {page} / {pageCount}
                </span>
                <Button variant="secondary" size="sm" disabled={page >= pageCount} onClick={() => setPage(page + 1)} aria-label="Next page">
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {editing && formReady && (
        <ProductDialog
          product={editing === 'new' ? null : editing}
          categories={categories.data}
          taxGroups={taxGroups.data}
          stations={stations.data}
          modifierGroups={modifierGroups.data}
          defaultCategoryId={categoryId || undefined}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {importing && formReady && (
        <ImportProductsDialog
          categories={categories.data}
          taxGroups={taxGroups.data}
          onClose={() => setImporting(false)}
          onAdded={() => {
            setImporting(false);
            refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={deletingSelected}
        onClose={() => setDeletingSelected(false)}
        onConfirm={() => removeSelected.mutate()}
        title={selected.size === 1 ? 'Delete 1 product' : `Delete ${selected.size} products`}
        message={<>Delete the <strong>{selected.size}</strong> selected {selected.size === 1 ? 'product' : 'products'}? They disappear from the menu. Past bills that include them are not changed.</>}
        confirmLabel={selected.size === 1 ? 'Delete 1 product' : `Delete ${selected.size} products`}
        danger
        loading={removeSelected.isPending}
      />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
        title="Delete product"
        message={<>Delete <strong>{deleting?.name}</strong>? It disappears from the menu. Past bills that include it are not changed.</>}
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
      />
    </>
  );
}
