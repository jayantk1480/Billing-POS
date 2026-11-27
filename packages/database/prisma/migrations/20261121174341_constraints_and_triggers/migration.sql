-- Rules PostgreSQL enforces directly, beyond what the Prisma schema can express.

-- Fast "contains" search on product names for the POS search box.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX products_name_trgm_idx ON products USING gin (name gin_trgm_ops);

-- A table can have only one running order at a time.
CREATE UNIQUE INDEX orders_one_running_per_table
  ON orders (table_id)
  WHERE table_id IS NOT NULL AND status IN ('OPEN', 'HELD', 'BILLED');

-- A user can have only one open cash register session.
CREATE UNIQUE INDEX cash_register_one_open_per_user
  ON cash_register_sessions (user_id)
  WHERE status = 'OPEN';

-- Value checks.
ALTER TABLE restaurant_settings
  ADD CONSTRAINT settings_cutoff_range CHECK (day_cutoff_minutes BETWEEN 0 AND 1439),
  ADD CONSTRAINT settings_service_charge_range CHECK (service_charge_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT settings_discount_cap_range CHECK (discount_cap_bps BETWEEN 0 AND 10000);
ALTER TABLE tax_components ADD CONSTRAINT tax_rate_range CHECK (rate_bps BETWEEN 0 AND 10000);
ALTER TABLE number_series ADD CONSTRAINT series_next_positive CHECK (next_number >= 1);
ALTER TABLE products ADD CONSTRAINT product_price_non_negative CHECK (base_price_paise >= 0);
ALTER TABLE variants ADD CONSTRAINT variant_price_non_negative CHECK (price_paise >= 0);
ALTER TABLE modifiers ADD CONSTRAINT modifier_price_non_negative CHECK (price_paise >= 0);
ALTER TABLE modifier_groups
  ADD CONSTRAINT modifier_group_select_range CHECK (min_select >= 0 AND max_select >= min_select);
ALTER TABLE dining_tables ADD CONSTRAINT table_seats_positive CHECK (seats >= 1);
-- Order numbers are positive; negative values exist only for an instant inside a renumbering transaction.
ALTER TABLE orders
  ADD CONSTRAINT order_number_not_zero CHECK (order_number <> 0),
  ADD CONSTRAINT order_amounts_non_negative
    CHECK (subtotal_paise >= 0 AND discount_paise >= 0 AND tax_paise >= 0 AND total_paise >= 0);
ALTER TABLE order_items
  ADD CONSTRAINT order_item_quantity_positive CHECK (quantity >= 1),
  ADD CONSTRAINT order_item_kot_quantity_range CHECK (kot_quantity >= 0),
  ADD CONSTRAINT order_item_price_non_negative CHECK (unit_price_paise >= 0);
ALTER TABLE discounts ADD CONSTRAINT discount_value_non_negative CHECK (value >= 0 AND amount_paise >= 0);
ALTER TABLE invoices
  ADD CONSTRAINT invoice_number_positive CHECK (number >= 1),
  ADD CONSTRAINT invoice_amounts_non_negative
    CHECK (gross_paise >= 0 AND discount_paise >= 0 AND taxable_paise >= 0 AND total_paise >= 0),
  ADD CONSTRAINT invoice_refund_within_paid
    CHECK (paid_paise >= 0 AND refunded_paise >= 0 AND refunded_paise <= paid_paise);
ALTER TABLE payments
  ADD CONSTRAINT payment_amount_positive CHECK (amount_paise > 0),
  ADD CONSTRAINT payment_refund_within_amount CHECK (refunded_paise >= 0 AND refunded_paise <= amount_paise);
ALTER TABLE refunds
  ADD CONSTRAINT refund_amount_positive CHECK (amount_paise > 0),
  ADD CONSTRAINT refund_number_positive CHECK (number >= 1);
ALTER TABLE cash_register_sessions
  ADD CONSTRAINT register_opening_non_negative CHECK (opening_cash_paise >= 0);
ALTER TABLE cash_register_transactions
  ADD CONSTRAINT register_txn_non_negative CHECK (amount_paise >= 0);

-- Issued invoices are legal records: their identity and amounts never change, and they are never deleted.
CREATE FUNCTION protect_invoice() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Invoices cannot be deleted (invoice %)', OLD.invoice_number;
  END IF;
  IF (NEW.restaurant_id, NEW.order_id, NEW.series_id, NEW.number, NEW.invoice_number, NEW.doc_type,
      NEW.business_date, NEW.issued_at, NEW.place_of_supply, NEW.is_inter_state, NEW.gross_paise,
      NEW.discount_paise, NEW.taxable_paise, NEW.cgst_paise, NEW.sgst_paise, NEW.igst_paise,
      NEW.cess_paise, NEW.service_charge_paise, NEW.round_off_paise, NEW.total_paise)
     IS DISTINCT FROM
     (OLD.restaurant_id, OLD.order_id, OLD.series_id, OLD.number, OLD.invoice_number, OLD.doc_type,
      OLD.business_date, OLD.issued_at, OLD.place_of_supply, OLD.is_inter_state, OLD.gross_paise,
      OLD.discount_paise, OLD.taxable_paise, OLD.cgst_paise, OLD.sgst_paise, OLD.igst_paise,
      OLD.cess_paise, OLD.service_charge_paise, OLD.round_off_paise, OLD.total_paise) THEN
    RAISE EXCEPTION 'Issued invoice % cannot be modified', OLD.invoice_number;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoices_protect BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION protect_invoice();

-- Rows that are written once and never changed.
CREATE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_items_append_only BEFORE UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER invoice_taxes_append_only BEFORE UPDATE OR DELETE ON invoice_taxes
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER refund_items_append_only BEFORE UPDATE OR DELETE ON refund_items
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER cash_register_transactions_append_only BEFORE UPDATE OR DELETE ON cash_register_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Payments and refunds: status may progress, but amount, method and links are fixed and rows stay.
CREATE FUNCTION protect_payment() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME;
  END IF;
  IF (NEW.restaurant_id, NEW.invoice_id, NEW.method, NEW.amount_paise, NEW.idempotency_key)
     IS DISTINCT FROM
     (OLD.restaurant_id, OLD.invoice_id, OLD.method, OLD.amount_paise, OLD.idempotency_key) THEN
    RAISE EXCEPTION '% amount, method and invoice cannot be modified', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payments_protect BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION protect_payment();
CREATE TRIGGER refunds_protect BEFORE UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION protect_payment();
