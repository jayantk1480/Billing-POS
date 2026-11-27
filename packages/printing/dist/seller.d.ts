import type { SellerDto } from '@pos/validation';
/** The restaurant fields a bill's seller block is made from. */
export interface SellerSource {
    name: string;
    legalName: string | null;
    gstin: string | null;
    fssaiNumber: string | null;
    phone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    stateName: string;
    pincode: string | null;
    stateCode: string;
}
/**
 * Who the bill is from, as it is printed and kept with the bill. Shared so that the POS can make the same block for a
 * bill it prints while the internet is down.
 */
export declare function buildSeller(r: SellerSource, settings: {
    invoiceFooter: string | null;
    upiVpa: string | null;
}): SellerDto;
//# sourceMappingURL=seller.d.ts.map