import { describe, expect, it } from 'vitest';
import { allocate, amountInWords, type BillInput, type BillLineInput, computeBill, discountBps } from './index.js';

const GST5 = { gstRateBps: 500, cessRateBps: 0 };
const GST18 = { gstRateBps: 1800, cessRateBps: 0 };

const line = (overrides: Partial<BillLineInput> = {}): BillLineInput => ({
  id: 'a', quantity: 1, unitPricePaise: 10000, priceIncludesTax: false, tax: GST5, ...overrides,
});
const bill = (lines: BillLineInput[], overrides: Partial<BillInput> = {}) =>
  computeBill({ lines, taxApplicable: true, interState: false, roundOff: 'NONE', ...overrides });

/** Every bill must satisfy these, whatever the inputs. */
function expectConsistent(result: ReturnType<typeof computeBill>) {
  expect(result.totalPaise).toBe(result.grossPaise - result.discountPaise + result.serviceChargePaise + result.taxAddedPaise + result.roundOffPaise);
  expect(result.taxPaise).toBe(result.cgstPaise + result.sgstPaise + result.igstPaise + result.cessPaise);
  expect(result.cgstPaise).toBe(result.sgstPaise);
  expect(result.taxSummary.reduce((sum, row) => sum + row.amountPaise, 0)).toBe(result.taxPaise);
  for (const l of result.lines) {
    expect(l.cgstPaise).toBe(l.sgstPaise);
    expect(l.totalPaise).toBe(l.taxablePaise + l.taxPaise);
    expect(l.taxablePaise).toBeGreaterThanOrEqual(0);
  }
}

describe('tax added on top of the price', () => {
  it('charges CGST and SGST as equal halves within the state', () => {
    const result = bill([line({ quantity: 2, unitPricePaise: 26000 })]);
    expect(result).toMatchObject({ grossPaise: 52000, taxablePaise: 52000, cgstPaise: 1300, sgstPaise: 1300, igstPaise: 0, taxAddedPaise: 2600, totalPaise: 54600 });
    expect(result.taxSummary).toEqual([
      { type: 'CGST', rateBps: 250, taxablePaise: 52000, amountPaise: 1300 },
      { type: 'SGST', rateBps: 250, taxablePaise: 52000, amountPaise: 1300 },
    ]);
    expectConsistent(result);
  });

  it('charges IGST at the full rate across states', () => {
    const result = bill([line({ unitPricePaise: 26000 })], { interState: true });
    expect(result).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 1300, totalPaise: 27300 });
    expect(result.taxSummary).toEqual([{ type: 'IGST', rateBps: 500, taxablePaise: 26000, amountPaise: 1300 }]);
  });

  it('keeps each tax rate separate in the summary', () => {
    const result = bill([line({ id: 'food', unitPricePaise: 20000 }), line({ id: 'cola', unitPricePaise: 5000, tax: GST18 })]);
    expect(result.taxSummary.map((row) => [row.type, row.rateBps, row.taxablePaise, row.amountPaise])).toEqual([
      ['CGST', 250, 20000, 500], ['CGST', 900, 5000, 450], ['SGST', 250, 20000, 500], ['SGST', 900, 5000, 450],
    ]);
    expect(result.totalPaise).toBe(25000 + 1000 + 900);
    expectConsistent(result);
  });

  it('adds cess on the same taxable value', () => {
    const result = bill([line({ unitPricePaise: 10000, tax: { gstRateBps: 2800, cessRateBps: 1200 } })]);
    expect(result).toMatchObject({ cgstPaise: 1400, sgstPaise: 1400, cessPaise: 1200, totalPaise: 14000 });
    expectConsistent(result);
  });

  it('rounds each tax component half up to the paisa', () => {
    // 2.5% of ₹1.10 = 2.75 paise → 3 paise each.
    const result = bill([line({ unitPricePaise: 110 })]);
    expect(result).toMatchObject({ cgstPaise: 3, sgstPaise: 3, totalPaise: 116 });
  });
});

describe('prices that include tax', () => {
  it('works the taxable value backwards so the customer pays the listed price', () => {
    const result = bill([line({ unitPricePaise: 10500, priceIncludesTax: true })]);
    expect(result).toMatchObject({ grossPaise: 10500, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, taxAddedPaise: 0, totalPaise: 10500 });
    expectConsistent(result);
  });

  it('never changes the amount payable, even when the split does not divide evenly', () => {
    for (const price of [100, 199, 333, 9999, 26000, 12345]) {
      for (const tax of [GST5, GST18, { gstRateBps: 2800, cessRateBps: 1200 }]) {
        const result = bill([line({ unitPricePaise: price, quantity: 3, priceIncludesTax: true, tax })]);
        expect(result.totalPaise).toBe(price * 3);
        expectConsistent(result);
      }
    }
  });

  it('mixes inclusive and exclusive lines on one bill', () => {
    const result = bill([
      line({ id: 'inclusive', unitPricePaise: 10500, priceIncludesTax: true }),
      line({ id: 'exclusive', unitPricePaise: 10000 }),
    ]);
    expect(result).toMatchObject({ grossPaise: 20500, taxablePaise: 20000, taxPaise: 1000, taxAddedPaise: 500, totalPaise: 21000 });
    expectConsistent(result);
  });
});

describe('discounts', () => {
  it('takes a line discount off before tax', () => {
    const result = bill([line({ unitPricePaise: 20000, discount: { type: 'PERCENT', value: 1000 } })]);
    expect(result).toMatchObject({ discountPaise: 2000, taxablePaise: 18000, taxPaise: 900, totalPaise: 18900 });
  });

  it('spreads a bill discount across lines in proportion, to the exact paisa', () => {
    const result = bill(
      [line({ id: 'a', unitPricePaise: 10000 }), line({ id: 'b', unitPricePaise: 20000 }), line({ id: 'c', unitPricePaise: 3333 })],
      { discount: { type: 'AMOUNT', value: 1000 } },
    );
    expect(result.lines.map((l) => l.discountPaise)).toEqual([300, 600, 100]);
    expect(result.discountPaise).toBe(1000);
    expectConsistent(result);
  });

  it('applies the bill discount after line discounts', () => {
    const result = bill(
      [line({ unitPricePaise: 10000, discount: { type: 'AMOUNT', value: 2000 } })],
      { discount: { type: 'PERCENT', value: 5000 } },
    );
    expect(result).toMatchObject({ discountPaise: 6000, taxablePaise: 4000, totalPaise: 4200 });
  });

  it('reduces the tax-inclusive amount, then extracts tax from what is left', () => {
    const result = bill([line({ unitPricePaise: 10500, priceIncludesTax: true })], { discount: { type: 'PERCENT', value: 1000 } });
    expect(result).toMatchObject({ discountPaise: 1050, totalPaise: 9450, taxablePaise: 9000, taxPaise: 450 });
    expectConsistent(result);
  });

  it('never discounts below zero', () => {
    const result = bill([line({ unitPricePaise: 5000, discount: { type: 'AMOUNT', value: 9000 } })], { discount: { type: 'AMOUNT', value: 9000 } });
    expect(result).toMatchObject({ discountPaise: 5000, taxablePaise: 0, taxPaise: 0, totalPaise: 0 });
  });

  it('reports a discount as a share of the bill for limit checks', () => {
    expect(discountBps(20000, { type: 'AMOUNT', value: 2500 })).toBe(1250);
    expect(discountBps(20000, { type: 'PERCENT', value: 1000 })).toBe(1000);
    expect(discountBps(0, { type: 'AMOUNT', value: 100 })).toBe(0);
  });
});

describe('bill totals', () => {
  it('rounds the total to the nearest rupee and shows the difference', () => {
    const down = bill([line({ unitPricePaise: 9990 })], { roundOff: 'NEAREST_RUPEE' }); // 104.90 → 105
    expect(down).toMatchObject({ roundOffPaise: 10, totalPaise: 10500 });
    const up = bill([line({ unitPricePaise: 10020 })], { roundOff: 'NEAREST_RUPEE' }); // 105.22 → 105
    expect(up).toMatchObject({ roundOffPaise: -22, totalPaise: 10500 });
    const half = bill([line({ unitPricePaise: 10000, tax: { gstRateBps: 50, cessRateBps: 0 } })], { roundOff: 'NEAREST_RUPEE' }); // 100.50 → 101
    expect(half).toMatchObject({ roundOffPaise: 50, totalPaise: 10100 });
    expectConsistent(down);
    expectConsistent(up);
  });

  it('charges no tax for an unregistered or composition restaurant', () => {
    const result = bill([line({ unitPricePaise: 10500, priceIncludesTax: true }), line({ id: 'b' })], { taxApplicable: false });
    expect(result).toMatchObject({ taxPaise: 0, taxAddedPaise: 0, taxablePaise: 20500, totalPaise: 20500, taxSummary: [] });
  });

  it('charges no tax on a line without a tax group', () => {
    const result = bill([line({ tax: null })]);
    expect(result).toMatchObject({ taxPaise: 0, totalPaise: 10000 });
  });

  it('adds a service charge on the taxable value and taxes it', () => {
    const result = bill([line({ unitPricePaise: 20000 })], { serviceChargeBps: 1000, serviceChargeTax: GST5 });
    // Food 200 + GST 10; service charge 20 + GST 1.
    expect(result).toMatchObject({ serviceChargePaise: 2000, taxablePaise: 22000, taxPaise: 1100, totalPaise: 23100 });
    expectConsistent(result);
  });

  it('gives an empty bill a zero total', () => {
    expect(bill([])).toMatchObject({ grossPaise: 0, totalPaise: 0, lines: [], taxSummary: [] });
  });

  it('rejects fractional quantities and prices', () => {
    expect(() => bill([line({ quantity: 1.5 })])).toThrow();
    expect(() => bill([line({ quantity: 0 })])).toThrow();
    expect(() => bill([line({ unitPricePaise: 99.5 })])).toThrow();
  });

  it('stays consistent across a large mixed bill', () => {
    const lines = Array.from({ length: 40 }, (_, i) =>
      line({
        id: `l${i}`, quantity: (i % 4) + 1, unitPricePaise: 1999 + i * 137, priceIncludesTax: i % 3 === 0,
        tax: i % 5 === 0 ? GST18 : GST5, discount: i % 7 === 0 ? { type: 'PERCENT', value: 750 } : null,
      }),
    );
    const result = bill(lines, { discount: { type: 'PERCENT', value: 1250 }, serviceChargeBps: 500, serviceChargeTax: GST5, roundOff: 'NEAREST_RUPEE' });
    expectConsistent(result);
    expect(result.totalPaise % 100).toBe(0);
  });
});

describe('helpers', () => {
  it('allocates to the exact paisa', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1000, [10000, 20000, 3333])).toEqual([300, 600, 100]);
    expect(allocate(5, [0, 0])).toEqual([0, 0]);
    expect(allocate(7, [1, 2, 4]).reduce((a, b) => a + b)).toBe(7);
  });

  it('writes amounts in words using lakh and crore', () => {
    expect(amountInWords(12345678)).toBe('Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only');
    expect(amountInWords(50000)).toBe('Rupees Five Hundred Only');
    expect(amountInWords(1_00_00_000_00)).toBe('Rupees One Crore Only');
    expect(amountInWords(1900)).toBe('Rupees Nineteen Only');
    expect(amountInWords(0)).toBe('Rupees Zero Only');
  });
});
