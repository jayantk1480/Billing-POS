-- CreateTable
CREATE TABLE "report_shares" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "report_type" VARCHAR(40) NOT NULL,
    "user_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_shares_user_id_idx" ON "report_shares"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_shares_restaurant_id_report_type_user_id_key" ON "report_shares"("restaurant_id", "report_type", "user_id");

-- AddForeignKey
ALTER TABLE "report_shares" ADD CONSTRAINT "report_shares_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_shares" ADD CONSTRAINT "report_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The new "share reports" permission, for restaurants that already exist.
-- Owners and managers get it, matching the built-in roles for new restaurants.
INSERT INTO permissions (id, key, "group", description)
VALUES (gen_random_uuid(), 'report.share', 'Reports', 'Share individual reports with other users')
ON CONFLICT (key) DO NOTHING;

UPDATE permissions SET description = 'View and export all reports' WHERE key = 'report.view';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE p.key = 'report.share' AND r.key IN ('owner', 'manager')
ON CONFLICT DO NOTHING;
