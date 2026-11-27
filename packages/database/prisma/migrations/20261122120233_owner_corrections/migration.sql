-- The owner may correct the payment method of a settled bill, and permanently delete a
-- billed order together with its bills, payments and refunds.
--
-- Bills, payments and refunds stay protected against every other change. The API switches
-- the protection off only inside the one transaction that performs such a correction, by
-- setting app.owner_override for that transaction, and writes what it removed to the audit
-- log. Audit log rows themselves can never be changed or deleted.

CREATE FUNCTION owner_override() RETURNS boolean AS $$
  SELECT current_setting('app.owner_override', true) = 'on';
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION protect_invoice() RETURNS trigger AS $$
BEGIN
  IF owner_override() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
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

CREATE OR REPLACE FUNCTION protect_payment() RETURNS trigger AS $$
BEGIN
  IF owner_override() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
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

-- The lines of a bill and of a credit note go with their parent, and only with it.
-- forbid_change() itself is left alone: it still guards the audit log and the cash register, with no override.
CREATE FUNCTION forbid_change_without_override() RETURNS trigger AS $$
BEGIN
  IF owner_override() AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER invoice_items_append_only ON invoice_items;
CREATE TRIGGER invoice_items_append_only BEFORE UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION forbid_change_without_override();
DROP TRIGGER invoice_taxes_append_only ON invoice_taxes;
CREATE TRIGGER invoice_taxes_append_only BEFORE UPDATE OR DELETE ON invoice_taxes
  FOR EACH ROW EXECUTE FUNCTION forbid_change_without_override();
DROP TRIGGER refund_items_append_only ON refund_items;
CREATE TRIGGER refund_items_append_only BEFORE UPDATE OR DELETE ON refund_items
  FOR EACH ROW EXECUTE FUNCTION forbid_change_without_override();

-- The two permissions, for restaurants that already exist.
INSERT INTO permissions (id, key, "group", description) VALUES
  (gen_random_uuid(), 'payment.change_method', 'Payments', 'Change the payment method of a settled bill'),
  (gen_random_uuid(), 'invoice.delete', 'Billing', 'Permanently delete a billed order with its bills and payments, or reopen it for changes')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE (p.key = 'payment.change_method' AND r.is_system AND r.key IN ('owner', 'manager'))
   OR (p.key = 'invoice.delete' AND r.is_system AND r.key = 'owner')
ON CONFLICT DO NOTHING;
