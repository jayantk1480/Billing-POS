-- Offline billing, step 2: what each uploaded operation is about, who did it, and what the owner should check.
ALTER TABLE "sync_operations"
  ADD COLUMN "device_id" UUID,
  ADD COLUMN "user_id" UUID,
  ADD COLUMN "uploaded_by_id" UUID,
  ADD COLUMN "entity_id" UUID,
  ADD COLUMN "order_id" UUID,
  ADD COLUMN "flags" JSONB,
  ADD COLUMN "reviewed_at" TIMESTAMP(3),
  ADD COLUMN "reviewed_by_id" UUID;

ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "pos_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "sync_operations_restaurant_id_entity_id_idx" ON "sync_operations"("restaurant_id", "entity_id");
CREATE INDEX "sync_operations_restaurant_id_reviewed_at_idx" ON "sync_operations"("restaurant_id", "reviewed_at");

-- A kitchen ticket made offline keeps the number printed on it; the server numbers it in the restaurant's sequence.
ALTER TABLE "kots" ADD COLUMN "offline_number" VARCHAR(20);
