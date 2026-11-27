-- A customer has no GSTIN: a restaurant bill is not one the buyer claims tax on, so the number was never used. Bills
-- already issued keep the GSTIN they were made out with (invoices.customer_gstin).
ALTER TABLE "customers" DROP COLUMN "gstin";
