-- Groundwork for billing while the internet is down. Each POS device registers once and is given a hidden till of
-- its own (kind OFFLINE, a 3-character code starting with Z), so the bills it numbers offline can never collide with
-- another device's. Existing tills are all counter tills.
CREATE TYPE "TerminalKind" AS ENUM ('COUNTER', 'OFFLINE');
ALTER TABLE "terminals" ADD COLUMN "kind" "TerminalKind" NOT NULL DEFAULT 'COUNTER';

CREATE TABLE "pos_devices" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "device_key" UUID NOT NULL,
    "offline_terminal_id" UUID NOT NULL,
    "home_terminal_id" UUID,
    "label" VARCHAR(200),
    "pending_count" INTEGER NOT NULL DEFAULT 0,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sync_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pos_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pos_devices_offline_terminal_id_key" ON "pos_devices"("offline_terminal_id");
CREATE UNIQUE INDEX "pos_devices_restaurant_id_device_key_key" ON "pos_devices"("restaurant_id", "device_key");
ALTER TABLE "pos_devices" ADD CONSTRAINT "pos_devices_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pos_devices" ADD CONSTRAINT "pos_devices_offline_terminal_id_fkey" FOREIGN KEY ("offline_terminal_id") REFERENCES "terminals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_devices" ADD CONSTRAINT "pos_devices_home_terminal_id_fkey" FOREIGN KEY ("home_terminal_id") REFERENCES "terminals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "pos_devices" ADD CONSTRAINT "pos_devices_pending_count_non_negative" CHECK ("pending_count" >= 0);
