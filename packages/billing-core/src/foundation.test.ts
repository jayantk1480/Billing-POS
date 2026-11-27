import { describe, expect, it } from 'vitest';
import {
  applyBps, businessDateOf, financialYearOf, formatDocumentNumber, formatINR, orderNumberPeriod,
  rupeesToPaise,
} from './index.js';

describe('money', () => {
  it('converts rupees to paise without floating point drift', () => {
    expect(rupeesToPaise('199.99')).toBe(19999);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
    expect(rupeesToPaise('-5.5')).toBe(-550);
    expect(() => rupeesToPaise('1.234')).toThrow();
  });
  it('formats with Indian digit grouping', () => {
    expect(formatINR(12345678)).toBe('₹1,23,456.78');
    expect(formatINR(99900)).toBe('₹999.00');
    expect(formatINR(-150050, { symbol: false })).toBe('-1,500.50');
  });
  it('rounds tax half up', () => {
    expect(applyBps(1050, 250)).toBe(26); // 26.25
    expect(applyBps(1010, 250)).toBe(25); // 25.25
    expect(applyBps(100, 250)).toBe(3); // 2.5 rounds up
  });
});

describe('calendar', () => {
  it('assigns late-night sales to the previous business date when a cutoff is set', () => {
    const lateNight = new Date('2026-11-21T20:00:00Z'); // 01:30 IST on 22 Nov
    expect(businessDateOf(lateNight, 'Asia/Kolkata', 0)).toBe('2026-11-22');
    expect(businessDateOf(lateNight, 'Asia/Kolkata', 300)).toBe('2026-11-21');
  });
  it('switches financial year on 1 April', () => {
    expect(financialYearOf('2027-03-31')).toBe('2627');
    expect(financialYearOf('2027-04-01')).toBe('2728');
  });
});

describe('numbering', () => {
  it('builds numbers within the 16 character GST limit', () => {
    expect(formatDocumentNumber('A1', '2627', 123)).toBe('A1/2627/000123');
    expect(formatDocumentNumber('COUNTER1', '2627', 7).length).toBeLessThanOrEqual(16);
    expect(() => formatDocumentNumber('A1', '2627', 0)).toThrow();
    expect(() => formatDocumentNumber('A 1', '2627', 1)).toThrow();
  });
  it('derives the order number period from the reset setting', () => {
    expect(orderNumberPeriod('DAILY', '2026-11-21', '2627')).toBe('2026-11-21');
    expect(orderNumberPeriod('FINANCIAL_YEAR', '2026-11-21', '2627')).toBe('FY2627');
    expect(orderNumberPeriod('NEVER', '2026-11-21', '2627')).toBe('ALL');
  });
});
