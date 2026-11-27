'use client';

import { formatINR } from '@pos/billing-core';
import { Button, Checkbox, Dialog, errorMessage, SelectField, Switch, TextAreaField, TextField, toast, useApi, useFormState } from '@pos/ui';
import {
  type CategoryDto, createProductSchema, type FoodType, type ModifierGroupDto, type ProductDto, type StationDto, type TaxGroupDto,
} from '@pos/validation';
import { ImagePlus, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { inputToPaise, paiseToInput } from '@/lib/format';

interface VariantRow {
  key: string;
  id?: string;
  name: string;
  price: string;
  isAvailable: boolean;
}

interface Props {
  product: ProductDto | null;
  categories: CategoryDto[];
  taxGroups: TaxGroupDto[];
  stations: StationDto[];
  modifierGroups: ModifierGroupDto[];
  defaultCategoryId?: string;
  onClose: () => void;
  onSaved: () => void;
}

let rowCounter = 0;
const newKey = () => `row-${(rowCounter += 1)}`;

/** The station choice for something the kitchen never makes. */
const NO_TICKET = 'none';

export function ProductDialog({ product, categories, taxGroups, stations, modifierGroups, defaultCategoryId, onClose, onSaved }: Props) {
  // Products with no station of their own go to the first active station, in the order of Settings, Kitchen stations.
  const firstStation = [...stations].filter((s) => s.isActive).sort((a, b) => a.sortOrder - b.sortOrder)[0];
  const api = useApi();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const form = useFormState({
    name: product?.name ?? '',
    categoryId: product?.categoryId ?? defaultCategoryId ?? categories[0]?.id ?? '',
    shortCode: product?.shortCode ?? '',
    description: product?.description ?? '',
    foodType: (product?.foodType ?? 'VEG') as FoodType,
    price: product ? paiseToInput(product.basePricePaise) : '',
    taxGroupId: product?.taxGroupId ?? '',
    priceIncludesTax: product?.priceIncludesTax == null ? '' : product.priceIncludesTax ? 'yes' : 'no',
    hsnSac: product?.hsnSac ?? '',
    // '' sends the item to the first active station; 'none' keeps it off kitchen tickets altogether.
    stationId: product?.sendToKitchen === false ? NO_TICKET : (product?.stationId ?? ''),
    isAvailable: product?.isAvailable ?? true,
    isActive: product?.isActive ?? true,
    isFavourite: product?.isFavourite ?? false,
    imageKey: product?.imageKey ?? null as string | null,
    imageUrl: product?.imageUrl ?? null as string | null,
    variants: (product?.variants ?? []).map<VariantRow>((v) => ({
      key: v.id, id: v.id, name: v.name, price: paiseToInput(v.pricePaise), isAvailable: v.isAvailable,
    })),
    modifierGroupIds: product?.modifierGroupIds ?? [],
  });
  const { values, set, errors } = form;
  const hasVariants = values.variants.length > 0;

  const setVariant = (key: string, patch: Partial<VariantRow>) =>
    set('variants', values.variants.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  async function onPickImage(file: File | undefined) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error('The image must be 2 MB or smaller.');
      return;
    }
    setUploading(true);
    try {
      const uploaded = await api.files.uploadImage(file);
      form.setValues((current) => ({ ...current, imageKey: uploaded.key, imageUrl: uploaded.url }));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const payload = {
      categoryId: values.categoryId,
      name: values.name,
      shortCode: values.shortCode,
      description: values.description,
      foodType: values.foodType,
      // With variants the first variant's price is used, so the single price field is ignored.
      basePricePaise: hasVariants ? inputToPaise(values.variants[0]!.price) : inputToPaise(values.price),
      taxGroupId: values.taxGroupId || null,
      priceIncludesTax: values.priceIncludesTax === '' ? null : values.priceIncludesTax === 'yes',
      hsnSac: values.hsnSac,
      stationId: values.stationId === NO_TICKET ? null : values.stationId || null,
      sendToKitchen: values.stationId !== NO_TICKET,
      isAvailable: values.isAvailable,
      isActive: values.isActive,
      isFavourite: values.isFavourite,
      imageKey: values.imageKey,
      variants: values.variants.map((row) => ({ id: row.id, name: row.name, pricePaise: inputToPaise(row.price), isAvailable: row.isAvailable })),
      modifierGroupIds: values.modifierGroupIds,
    };
    const saved = await form.submit(createProductSchema, payload, (data) =>
      product ? api.products.update(product.id, data) : api.products.create(data),
    );
    if (saved) {
      toast.success(product ? 'Product updated' : 'Product added');
      onSaved();
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={product ? `Edit ${product.name}` : 'Add product'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>
            Cancel
          </Button>
          <Button type="submit" form="product-form" loading={form.submitting} disabled={uploading}>
            {product ? 'Save changes' : 'Add product'}
          </Button>
        </>
      }
    >
      <form id="product-form" onSubmit={onSubmit} noValidate className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField className="sm:col-span-2" label="Name" value={values.name} onChange={(v) => set('name', v)} error={errors.name} autoFocus />
            <SelectField
              label="Category" value={values.categoryId} onChange={(v) => set('categoryId', v)} error={errors.categoryId}
              options={categories.map((c) => ({ value: c.id, label: c.name }))}
            />
            <SelectField
              label="Type" value={values.foodType} onChange={(v) => set('foodType', v as FoodType)}
              options={[{ value: 'VEG', label: 'Vegetarian' }, { value: 'NON_VEG', label: 'Non-vegetarian' }, { value: 'EGG', label: 'Contains egg' }]}
            />
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium text-ink-700">Photo</p>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void onPickImage(e.target.files?.[0])} />
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={uploading}
                className="flex size-28 items-center justify-center overflow-hidden rounded-xl border border-dashed border-ink-300 bg-canvas text-ink-500 hover:border-brand-500 hover:text-brand-600"
                aria-label={values.imageUrl ? 'Replace photo' : 'Upload photo'}
              >
                {values.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- served by our API, not a static asset
                  <img src={values.imageUrl} alt="" className="size-full object-cover" />
                ) : (
                  <span className="flex flex-col items-center gap-1 text-xs">
                    <ImagePlus className="size-5" />
                    {uploading ? 'Uploading' : 'Upload'}
                  </span>
                )}
              </button>
              {values.imageUrl && (
                <Button variant="ghost" size="sm" onClick={() => form.setValues((c) => ({ ...c, imageKey: null, imageUrl: null }))}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            label="Price" prefix="₹" inputMode="decimal" value={hasVariants ? '' : values.price} onChange={(v) => set('price', v)}
            error={hasVariants ? undefined : errors.basePricePaise} disabled={hasVariants}
            hint={hasVariants ? 'Set by the first variant below' : undefined} placeholder={hasVariants ? 'See variants' : '0'}
          />
          <TextField
            label="Short code" value={values.shortCode} onChange={(v) => set('shortCode', v.toUpperCase())} error={errors.shortCode}
            hint="Typed at the counter for fast billing" maxLength={8}
          />
          <SelectField
            label="Kitchen station" value={values.stationId} onChange={(v) => set('stationId', v)} error={errors.stationId}
            placeholder={firstStation ? `Default (${firstStation.name})` : 'Default (no kitchen station yet)'}
            hint={values.stationId === NO_TICKET ? 'Never printed on a kitchen ticket' : 'Where its kitchen ticket goes'}
            options={[
              ...stations.filter((s) => s.isActive || s.id === values.stationId).map((s) => ({ value: s.id, label: s.name })),
              { value: NO_TICKET, label: 'No kitchen ticket' },
            ]}
          />
        </div>

        <fieldset>
          <legend className="text-sm font-semibold text-ink-900">Tax</legend>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <SelectField
              label="Tax group" value={values.taxGroupId} onChange={(v) => set('taxGroupId', v)} error={errors.taxGroupId}
              placeholder="Restaurant default" options={taxGroups.filter((t) => t.isActive || t.id === values.taxGroupId).map((t) => ({ value: t.id, label: t.name }))}
            />
            <SelectField
              label="Price includes tax" value={values.priceIncludesTax} onChange={(v) => set('priceIncludesTax', v)}
              placeholder="Restaurant default" options={[{ value: 'yes', label: 'Yes, tax is inside the price' }, { value: 'no', label: 'No, tax is added on top' }]}
            />
            <TextField label="HSN / SAC code" inputMode="numeric" value={values.hsnSac} onChange={(v) => set('hsnSac', v)} error={errors.hsnSac} maxLength={8} />
          </div>
        </fieldset>

        <fieldset>
          <div className="flex items-center justify-between">
            <legend className="text-sm font-semibold text-ink-900">Variants</legend>
            <Button
              variant="secondary" size="sm"
              onClick={() => set('variants', [...values.variants, { key: newKey(), name: '', price: hasVariants ? '' : values.price, isAvailable: true }])}
            >
              <Plus className="size-4" /> Add variant
            </Button>
          </div>
          {hasVariants ? (
            <ul className="mt-3 space-y-2">
              {values.variants.map((row, index) => (
                <li key={row.key} className="grid grid-cols-[1fr_8rem_auto_auto] items-start gap-2">
                  <TextField
                    label={index === 0 ? 'Name (first is the default)' : 'Name'} value={row.name}
                    onChange={(v) => setVariant(row.key, { name: v })} error={errors[`variants.${index}.name`]} placeholder="Half, Full, Large"
                  />
                  <TextField
                    label="Price" prefix="₹" inputMode="decimal" value={row.price}
                    onChange={(v) => setVariant(row.key, { price: v })} error={errors[`variants.${index}.pricePaise`]}
                  />
                  <div className="pt-8">
                    <Checkbox label="Available" checked={row.isAvailable} onChange={(checked) => setVariant(row.key, { isAvailable: checked })} />
                  </div>
                  <button
                    type="button" aria-label={`Remove variant ${row.name || index + 1}`}
                    onClick={() => set('variants', values.variants.filter((other) => other.key !== row.key))}
                    className="mt-7 rounded-lg p-2 text-ink-500 hover:bg-red-50 hover:text-danger"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-ink-500">No variants. Add them for sizes or portions that have their own price.</p>
          )}
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold text-ink-900">Modifier groups</legend>
          {modifierGroups.length === 0 ? (
            <p className="mt-2 text-sm text-ink-500">None yet. Create add-on groups on the Modifiers page.</p>
          ) : (
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              {modifierGroups.map((group) => (
                <Checkbox
                  key={group.id}
                  checked={values.modifierGroupIds.includes(group.id)}
                  onChange={(checked) =>
                    set('modifierGroupIds', checked ? [...values.modifierGroupIds, group.id] : values.modifierGroupIds.filter((id) => id !== group.id))
                  }
                  label={
                    <>
                      <span className="font-medium text-ink-900">{group.name}</span>{' '}
                      <span className="text-ink-500">
                        · {group.modifiers.map((m) => (m.pricePaise ? `${m.name} ${formatINR(m.pricePaise)}` : m.name)).join(', ')}
                      </span>
                    </>
                  }
                />
              ))}
            </div>
          )}
        </fieldset>

        <TextAreaField label="Description" value={values.description} onChange={(v) => set('description', v)} error={errors.description} rows={2} />

        <div className="grid gap-4 rounded-xl bg-canvas p-4 sm:grid-cols-3">
          <Switch label="Available" description="Off hides it from billing for now" checked={values.isAvailable} onChange={(v) => set('isAvailable', v)} />
          <Switch label="Favourite" description="Shown on the quick-pick screen" checked={values.isFavourite} onChange={(v) => set('isFavourite', v)} />
          <Switch label="Active" description="Off removes it from the menu" checked={values.isActive} onChange={(v) => set('isActive', v)} />
        </div>
      </form>
    </Dialog>
  );
}
