/**
 * Who the bill is from, as it is printed and kept with the bill. Shared so that the POS can make the same block for a
 * bill it prints while the internet is down.
 */
export function buildSeller(r, settings) {
    const cityLine = [r.city, r.stateName, r.pincode].filter(Boolean).join(', ');
    return {
        name: r.name, legalName: r.legalName, gstin: r.gstin, fssaiNumber: r.fssaiNumber, phone: r.phone,
        addressLines: [r.addressLine1, r.addressLine2, cityLine].filter((line) => Boolean(line)),
        stateCode: r.stateCode, stateName: r.stateName, footer: settings.invoiceFooter, upiVpa: settings.upiVpa,
    };
}
//# sourceMappingURL=seller.js.map