-- AlterTable
ALTER TABLE "orders" ALTER COLUMN "number_period" SET DATA TYPE VARCHAR(20);

-- AlterTable
ALTER TABLE "restaurant_settings" ADD COLUMN     "order_number_epoch" INTEGER NOT NULL DEFAULT 0;
