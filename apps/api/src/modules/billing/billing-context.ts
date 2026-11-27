import { Injectable } from '@nestjs/common';
import { businessDateOf, financialYearOf, orderNumberPeriod, type TaxRates } from '@pos/billing-core';
import { type Prisma, PrismaClient } from '@pos/database';

export type Db = Prisma.TransactionClient | PrismaClient;

/** The restaurant-wide facts every bill calculation needs, read once per request. */
export interface BillingContext {
  restaurant: Prisma.RestaurantGetPayload<object>;
  settings: Prisma.RestaurantSettingsGetPayload<object>;
  /** GST and cess rates by tax group id. */
  taxRates: Map<string, TaxRates>;
  defaultTax: TaxRates | null;
  /** False for unregistered and composition-scheme restaurants. */
  taxApplicable: boolean;
  businessDate: string;
  financialYear: string;
  /** The period new order numbers are unique within. */
  numberPeriod: string;
  /** Kitchen stations that take tickets, first in the list first. */
  activeStationIds: string[];
}

@Injectable()
export class BillingContextService {
  constructor(private readonly prisma: PrismaClient) {}

  async load(restaurantId: string, db: Db = this.prisma): Promise<BillingContext> {
    const [restaurant, settings, groups, stations] = await Promise.all([
      db.restaurant.findUniqueOrThrow({ where: { id: restaurantId } }),
      db.restaurantSettings.upsert({ where: { restaurantId }, update: {}, create: { restaurantId } }),
      db.taxGroup.findMany({ where: { restaurantId }, include: { components: true } }),
      db.kitchenStation.findMany({ where: { restaurantId, isActive: true }, select: { id: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    ]);
    const taxRates = new Map<string, TaxRates>(
      groups.map((group) => {
        const rate = (type: string) => group.components.find((c) => c.type === type)?.rateBps ?? 0;
        return [group.id, { gstRateBps: rate('IGST'), cessRateBps: rate('CESS') }];
      }),
    );
    const businessDate = businessDateOf(new Date(), settings.timezone, settings.dayCutoffMinutes);
    const financialYear = financialYearOf(businessDate);
    const period = orderNumberPeriod(settings.orderNumberReset, businessDate, financialYear);
    return {
      restaurant,
      settings,
      taxRates,
      defaultTax: settings.defaultTaxGroupId ? (taxRates.get(settings.defaultTaxGroupId) ?? null) : null,
      taxApplicable: settings.gstRegistration === 'REGULAR',
      businessDate,
      financialYear,
      numberPeriod: settings.orderNumberEpoch > 0 ? `${period}#${settings.orderNumberEpoch}` : period,
      activeStationIds: stations.map((station) => station.id),
    };
  }
}

/** A "YYYY-MM-DD" business date as the Date value Prisma stores in a DATE column. */
export const asDate = (businessDate: string) => new Date(`${businessDate}T00:00:00.000Z`);
export const fromDate = (date: Date) => date.toISOString().slice(0, 10);
