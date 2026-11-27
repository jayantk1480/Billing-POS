-- AlterTable
ALTER TABLE "kot_items" ADD COLUMN     "cancelled_quantity" INTEGER NOT NULL DEFAULT 0;

-- When an order line is deleted, the database clears the link from the lines of bills that
-- mentioned it (ON DELETE SET NULL). That is not a change to the bill, and the append-only
-- rule must not refuse it: without this, removing an item from an order whose earlier bill
-- was cancelled failed.
CREATE OR REPLACE FUNCTION forbid_change_without_override() RETURNS trigger AS $$
BEGIN
  IF owner_override() AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'invoice_items'
     AND (to_jsonb(NEW) ->> 'order_item_id') IS NULL
     AND (to_jsonb(NEW) - 'order_item_id') = (to_jsonb(OLD) - 'order_item_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
