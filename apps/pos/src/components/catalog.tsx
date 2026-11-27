'use client';

import { formatINR } from '@pos/billing-core';
import { Button, cn, Dialog } from '@pos/ui';
import type { FoodType, PosBootstrap, ProductDto } from '@pos/validation';
import { Search, Star, UtensilsCrossed } from 'lucide-react';
import { type KeyboardEvent, type RefObject, useMemo, useState } from 'react';
import { lineFromProduct, useCart } from '@/lib/cart';

const FOOD: Record<FoodType, string> = { VEG: 'border-green-700 [&>span]:bg-green-700', NON_VEG: 'border-red-700 [&>span]:bg-red-700', EGG: 'border-amber-500 [&>span]:bg-amber-500' };
const FOOD_LABEL: Record<FoodType, string> = { VEG: 'Vegetarian', NON_VEG: 'Non-vegetarian', EGG: 'Contains egg' };

function FoodMark({ type }: { type: FoodType }) {
  return (
    <span role="img" aria-label={FOOD_LABEL[type]} className={cn('inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border-[1.5px]', FOOD[type])}>
      <span className="size-1.5 rounded-full" />
    </span>
  );
}

/**
 * The product's photo, a short banner at the top of its tile (a small square beside the text on a phone held sideways).
 * A product with no photo, or one whose photo cannot be loaded, gets a utensils icon on a light wash of its category's colour.
 */
function ProductThumb({ url, colour }: { url: string | null; colour: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const box = 'h-16 w-full shrink-0 rounded-lg sm:h-20 short:size-12!';
  if (url && url !== failedUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- served by our API
      <img
        src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailedUrl(url)}
        // The hairline keeps a photo with a white background from dissolving into the tile.
        className={cn(box, 'bg-canvas object-cover outline-1 -outline-offset-1 outline-black/5')}
      />
    );
  }
  return (
    <span
      className={cn(box, 'flex items-center justify-center')}
      style={{ backgroundColor: `color-mix(in srgb, ${colour} 9%, var(--color-surface))`, color: `color-mix(in srgb, ${colour} 45%, var(--color-surface))` }}
    >
      <UtensilsCrossed className="size-6" strokeWidth={1.75} />
    </span>
  );
}

/** Choosing a variant and add-ons for an item that needs them. */
function ItemDialog({ product, boot, quantity, onClose }: { product: ProductDto; boot: PosBootstrap; quantity: number; onClose: () => void }) {
  const addLine = useCart((cart) => cart.addLine);
  const groups = boot.modifierGroups.filter((group) => product.modifierGroupIds.includes(group.id));
  const [variantId, setVariantId] = useState<string | null>(product.variants.find((v) => v.isAvailable)?.id ?? null);
  const [chosen, setChosen] = useState<string[]>([]);

  const toggle = (groupId: string, modifierId: string) => {
    const group = groups.find((g) => g.id === groupId)!;
    const inGroup = chosen.filter((id) => group.modifiers.some((m) => m.id === id));
    if (chosen.includes(modifierId)) return setChosen(chosen.filter((id) => id !== modifierId));
    // In a choose-one group a new pick replaces the old one; otherwise stop at the maximum.
    if (group.maxSelect === 1) return setChosen([...chosen.filter((id) => !inGroup.includes(id)), modifierId]);
    if (inGroup.length < group.maxSelect) setChosen([...chosen, modifierId]);
  };

  const unmet = groups.find((group) => chosen.filter((id) => group.modifiers.some((m) => m.id === id)).length < group.minSelect);
  const line = lineFromProduct(product, boot, variantId, chosen);
  const ready = (product.variants.length === 0 || variantId) && !unmet;

  return (
    <Dialog
      open onClose={onClose} title={product.name}
      footer={
        <>
          <Button variant="secondary" size="touch" onClick={onClose}>Cancel</Button>
          <Button size="touch" disabled={!ready} onClick={() => { addLine(line, quantity); onClose(); }}>
            Add {quantity > 1 ? `${quantity} × ` : ''}{formatINR(line.unitPricePaise)}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {product.variants.length > 0 && (
          <fieldset>
            <legend className="text-sm font-semibold text-ink-900">Choose one</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {product.variants.map((variant) => (
                <button
                  key={variant.id} type="button" role="radio" aria-checked={variantId === variant.id} disabled={!variant.isAvailable}
                  onClick={() => setVariantId(variant.id)}
                  className={cn(
                    'flex h-14 items-center justify-between rounded-xl border px-4 text-left disabled:opacity-40',
                    variantId === variant.id ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-line hover:border-ink-300',
                  )}
                >
                  <span className="font-medium text-ink-900">{variant.name}</span>
                  <span className="tabular-nums text-ink-700">{formatINR(variant.pricePaise)}</span>
                </button>
              ))}
            </div>
          </fieldset>
        )}
        {groups.map((group) => (
          <fieldset key={group.id}>
            <legend className="text-sm font-semibold text-ink-900">
              {group.name}{' '}
              <span className="font-normal text-ink-500">
                {group.minSelect > 0 ? `· choose ${group.minSelect === group.maxSelect ? group.minSelect : `${group.minSelect} to ${group.maxSelect}`}` : `· optional, up to ${group.maxSelect}`}
              </span>
            </legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {group.modifiers.map((modifier) => (
                <button
                  key={modifier.id} type="button" role="checkbox" aria-checked={chosen.includes(modifier.id)} disabled={!modifier.isAvailable}
                  onClick={() => toggle(group.id, modifier.id)}
                  className={cn(
                    'flex h-14 items-center justify-between rounded-xl border px-4 text-left disabled:opacity-40',
                    chosen.includes(modifier.id) ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-line hover:border-ink-300',
                  )}
                >
                  <span className="font-medium text-ink-900">{modifier.name}</span>
                  <span className="text-sm tabular-nums text-ink-500">{modifier.pricePaise ? `+ ${formatINR(modifier.pricePaise)}` : ''}</span>
                </button>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </Dialog>
  );
}

const FAVOURITES = 'favourites';
const ALL = 'all';

/** The category rail, search box and product grid. */
export function Catalog({ boot, searchRef }: { boot: PosBootstrap; searchRef: RefObject<HTMLInputElement | null> }) {
  const addLine = useCart((cart) => cart.addLine);
  const hasFavourites = boot.products.some((product) => product.isFavourite);
  const [category, setCategory] = useState<string>(hasFavourites ? FAVOURITES : ALL);
  const [search, setSearch] = useState('');
  const [choosing, setChoosing] = useState<{ product: ProductDto; quantity: number } | null>(null);
  const colours = useMemo(() => new Map(boot.categories.map((c) => [c.id, c.color ?? '#94a3b8'])), [boot.categories]);

  // "3 MT" at the counter means three of the item with short code MT.
  const typed = /^(\d{1,3})\s+(.+)$/.exec(search.trim());
  const quantity = typed ? Math.max(1, Number(typed[1])) : 1;
  const term = (typed ? typed[2]! : search).trim().toLowerCase();

  const visible = useMemo(() => {
    if (term) {
      const byCode = boot.products.filter((p) => p.shortCode?.toLowerCase() === term);
      return byCode.length > 0 ? byCode : boot.products.filter((p) => p.name.toLowerCase().includes(term) || p.shortCode?.toLowerCase().startsWith(term));
    }
    if (category === FAVOURITES) return boot.products.filter((p) => p.isFavourite);
    if (category === ALL) return boot.products;
    return boot.products.filter((p) => p.categoryId === category);
  }, [boot.products, category, term]);

  function pick(product: ProductDto, count = 1) {
    if (!product.isAvailable) return;
    if (product.variants.length > 0 || product.modifierGroupIds.length > 0) setChoosing({ product, quantity: count });
    else addLine(lineFromProduct(product, boot, null, []), count);
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && visible[0]) {
      pick(visible[0], quantity);
      setSearch('');
    } else if (event.key === 'Escape') {
      setSearch('');
    }
  }

  const tabs = [
    ...(hasFavourites ? [{ id: FAVOURITES, name: 'Favourites', colour: '#f59e0b' }] : []),
    { id: ALL, name: 'All items', colour: '#64748b' },
    ...boot.categories.map((c) => ({ id: c.id, name: c.name, colour: c.color ?? '#94a3b8' })),
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/*
        The categories stay down the left side on every screen; on a phone the rail is narrow. A scrollbar there would take
        a fifth of its width, so the rail scrolls by touch with no bar; wider screens get a thin one.
      */}
      <nav
        aria-label="Categories"
        className={cn(
          'w-[5.5rem] shrink-0 space-y-1 overflow-y-auto overflow-x-hidden overscroll-contain border-r border-line bg-surface p-1 md:w-40 md:p-2',
          '[scrollbar-width:none] md:[scrollbar-width:thin] [&::-webkit-scrollbar]:hidden md:[&::-webkit-scrollbar]:block',
        )}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id} type="button" onClick={() => { setCategory(tab.id); setSearch(''); }} aria-current={!term && category === tab.id ? 'true' : undefined}
            className={cn(
              'relative flex min-h-12 w-full items-center gap-2 overflow-hidden rounded-lg py-2 pl-2.5 pr-1.5 text-left text-xs font-medium leading-tight wrap-break-word md:pl-4 md:pr-3 md:text-sm',
              !term && category === tab.id ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-canvas',
            )}
          >
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: tab.colour }} />
            {tab.id === FAVOURITES && <Star className="hidden size-4 shrink-0 fill-amber-400 text-amber-400 md:block" />}
            <span className="min-w-0">{tab.name}</span>
          </button>
        ))}
      </nav>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-line bg-surface p-2 short:py-2 sm:p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-ink-500" />
            <input
              ref={searchRef} type="search" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={onSearchKey}
              placeholder="Search or short code, e.g. 3 MT" aria-label="Search items"
              className="h-12 w-full rounded-xl border border-line bg-canvas pl-11 pr-4 text-base placeholder:text-ink-500 lg:pr-12"
            />
            {/* The keyboard shortcut, where there is a keyboard. */}
            <kbd className="pointer-events-none absolute right-3.5 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-xs text-ink-500 lg:block" aria-hidden="true">/</kbd>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 [scrollbar-width:thin] sm:p-3">
          {visible.length === 0 ? (
            <p className="py-16 text-center text-sm text-ink-500">{term ? `Nothing matches "${term}".` : 'No items in this category.'}</p>
          ) : (
            <ul
              className={cn(
                // As many tiles across as fit, so they stay narrow and tall at every width; two on a small phone.
                'grid grid-cols-2 gap-2 min-[480px]:grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] sm:gap-2.5',
                // A phone held sideways has no height to spare: there the tiles lie flat, photo beside the text.
                'short:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]!',
              )}
              aria-label="Items"
            >
              {visible.map((product) => (
                <li key={product.id}>
                  <button
                    type="button" onClick={() => pick(product, 1)} disabled={!product.isAvailable}
                    className={cn(
                      'flex w-full flex-col gap-2 rounded-xl border border-l-4 border-line bg-surface p-2 text-left shadow-(--shadow-card) short:flex-row short:items-center',
                      'transition duration-150 active:scale-[0.97] disabled:opacity-45',
                      product.isAvailable && 'hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-md',
                    )}
                    style={{ borderLeftColor: colours.get(product.categoryId) }}
                  >
                    <ProductThumb url={product.imageUrl} colour={colours.get(product.categoryId) ?? '#94a3b8'} />
                    <span className="flex w-full min-w-0 flex-col gap-1 px-0.5 short:flex-1">
                      {/* Room for two lines of name, so every tile is the same height. */}
                      <span className="flex min-h-[2.5em] items-start gap-1.5 text-sm font-semibold leading-tight text-ink-900">
                        <span className="mt-0.5"><FoodMark type={product.foodType} /></span>
                        <span className="line-clamp-2 min-w-0 wrap-break-word">{product.name}</span>
                      </span>
                      {product.isAvailable ? (
                        // One line, of fixed height: a short code too long to fit beside the price wraps out of sight rather than being cut off.
                        <span className="flex h-5 flex-wrap items-end justify-between gap-x-1 overflow-hidden sm:h-6">
                          <span className="text-sm font-medium tabular-nums text-ink-900 sm:text-base">
                            {formatINR(product.basePricePaise)}
                            {product.variants.length > 0 && <span className="text-xs font-normal text-ink-500"> +</span>}
                          </span>
                          {product.shortCode && <span className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[11px] leading-4 text-ink-500">{product.shortCode}</span>}
                        </span>
                      ) : (
                        <span className="flex h-5 items-end text-xs font-medium text-danger sm:h-6">Unavailable</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {choosing && <ItemDialog product={choosing.product} boot={boot} quantity={choosing.quantity} onClose={() => setChoosing(null)} />}
    </div>
  );
}
