'use client';

import { Badge, Button, Checkbox, cn, Dialog, errorMessage, Table, Td, TextAreaField, Th, toast, useApi } from '@pos/ui';
import type { BulkProductsResult, CategoryDto, TaxGroupDto } from '@pos/validation';
import { useMutation } from '@tanstack/react-query';
import { Download, FileSpreadsheet } from 'lucide-react';
import { useRef, useState } from 'react';
import { productTemplate, readProductSheet, type SheetProduct } from '@/lib/spreadsheet';

interface Props {
  categories: CategoryDto[];
  taxGroups: TaxGroupDto[];
  onClose: () => void;
  onAdded: () => void;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * Adds many products from a spreadsheet, in two steps: give the rows (a CSV file, or rows pasted from Excel or
 * Google Sheets), then look over what the server says about each row before anything is saved.
 */
export function ImportProductsDialog({ categories, taxGroups, onClose, onAdded }: Props) {
  const api = useApi();
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetProduct[]>([]);
  const [verdict, setVerdict] = useState<BulkProductsResult | null>(null);
  const [skippedOnly, setSkippedOnly] = useState(false);

  // The server judges every row; nothing is saved until the rows have been looked over.
  const check = useMutation({
    mutationFn: (products: SheetProduct[]) => api.products.bulkCreate({ rows: products.map((p) => p.row), dryRun: true }),
    onSuccess: (result, products) => {
      setSheet(products);
      setVerdict(result);
      setSkippedOnly(false);
    },
    onError: (error) => setProblem(errorMessage(error)),
  });
  const save = useMutation({
    mutationFn: () => api.products.bulkCreate({ rows: sheet.map((p) => p.row) }),
    onSuccess: (result) => {
      toast.success(`${plural(result.created, 'product')} added`);
      onAdded();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    if (fileInput.current) fileInput.current.value = '';
    if (/\.(xlsx?|ods|numbers)$/i.test(file.name)) {
      setProblem('That is a spreadsheet file. Save it as CSV first (File → Save as → CSV), or copy the rows and paste them below.');
      return;
    }
    setText(await file.text());
    setFileName(file.name);
    setProblem(null);
  }

  function checkRows() {
    const read = readProductSheet(text);
    if ('error' in read) return setProblem(read.error);
    setProblem(null);
    check.mutate(read.products);
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([productTemplate(categories[0]?.name ?? 'Starters', taxGroups[0]?.name ?? '')], { type: 'text/csv;charset=utf-8' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: 'products-template.csv' });
    link.click();
    URL.revokeObjectURL(url);
  }

  if (verdict) {
    const skipped = verdict.duplicates + verdict.errors;
    const rows = verdict.rows.filter((r) => !skippedOnly || r.status !== 'ready');
    return (
      <Dialog
        open onClose={onClose} title="Add products in bulk" size="lg"
        description="Nothing is saved yet. Check the rows, then add them."
        footer={
          <>
            <Button variant="secondary" onClick={() => setVerdict(null)} disabled={save.isPending}>Back</Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={verdict.created === 0}>
              {verdict.created === 0 ? 'Nothing to add' : `Add ${plural(verdict.created, 'product')}`}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2" aria-label="Summary">
            <Badge tone="ok">{verdict.created} will be added</Badge>
            {verdict.duplicates > 0 && <Badge tone="neutral">{verdict.duplicates} already on the menu</Badge>}
            {verdict.errors > 0 && <Badge tone="danger">{plural(verdict.errors, 'row')} with a mistake</Badge>}
          </div>
          {verdict.newCategories.length > 0 && (
            <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-700">
              {verdict.newCategories.length === 1 ? 'A new category will be created: ' : 'New categories will be created: '}
              <strong className="font-medium text-ink-900">{verdict.newCategories.join(', ')}</strong>.
            </p>
          )}
          {skipped > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-ink-500">
                Rows that are skipped are left out; the rest are added. To add them too, go back, correct the sheet and check again.
              </p>
              <Checkbox label="Show only the rows that are skipped" checked={skippedOnly} onChange={setSkippedOnly} />
            </div>
          )}
          <div className="overflow-hidden rounded-lg border border-line">
            <Table>
              <thead>
                <tr>
                  <Th className="w-0">Row</Th>
                  <Th>Product</Th>
                  <Th>Category</Th>
                  <Th className="text-right">Price</Th>
                  <Th>Result</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((result) => {
                  const product = sheet[result.row]!;
                  return (
                    <tr key={result.row} className={cn(result.status === 'error' && 'bg-red-50/60')}>
                      <Td className="tabular-nums text-ink-500">{product.line}</Td>
                      <Td className="min-w-40 font-medium text-ink-900">{product.row.name || '—'}</Td>
                      <Td>{product.row.category || '—'}</Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">{product.row.price || '—'}</Td>
                      <Td>
                        {result.status === 'ready' ? (
                          <span className="text-ok">Will be added</span>
                        ) : (
                          <span className={result.status === 'error' ? 'text-danger' : 'text-ink-500'}>
                            {result.status === 'duplicate' ? 'Skipped: ' : ''}{result.message}
                          </span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open onClose={onClose} title="Add products in bulk" size="lg"
      description="Add many products at once from a spreadsheet."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={checkRows} loading={check.isPending} disabled={text.trim() === ''}>Check rows</Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="rounded-lg bg-canvas px-4 py-3 text-sm text-ink-700">
          <p>
            The first row names the columns. <strong className="font-medium text-ink-900">Name</strong>,{' '}
            <strong className="font-medium text-ink-900">Category</strong> and <strong className="font-medium text-ink-900">Price</strong> are
            needed. Short code, Type (veg, non-veg or egg), Tax group, Description and HSN/SAC are optional.
          </p>
          <p className="mt-1.5">A category that is not on the menu yet is created for you. A product that is already on the menu is skipped.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileInput} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="hidden" aria-label="CSV file" onChange={(e) => void onPickFile(e.target.files?.[0])} />
          <Button variant="secondary" onClick={() => fileInput.current?.click()}><FileSpreadsheet className="size-4" /> Choose a CSV file</Button>
          <Button variant="ghost" onClick={downloadTemplate}><Download className="size-4" /> Download template</Button>
          {fileName && <span className="truncate text-sm text-ink-500">{fileName}</span>}
        </div>

        <TextAreaField
          label="Or paste rows copied from Excel or Google Sheets"
          hint="Include the row of column headings."
          value={text}
          onChange={(value) => {
            setText(value);
            setFileName(null);
            setProblem(null);
          }}
          rows={9} spellCheck={false} wrap="off"
          placeholder={'Name\tCategory\tPrice\nPaneer Tikka\tStarters\t260\nChicken Tikka\tStarters\t320'}
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}
        />
        {problem && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{problem}</p>}
      </div>
    </Dialog>
  );
}
