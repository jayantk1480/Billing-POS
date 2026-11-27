-- Cash register, thermal printing through the print bridge, and payment reconciliation.

-- Cash is taken only with the cashier's register open, when the owner switches this on.
ALTER TABLE "restaurant_settings" ADD COLUMN "register_required" BOOLEAN NOT NULL DEFAULT false;

-- Who closed a register (the cashier, or a manager closing it for them).
ALTER TABLE "cash_register_sessions"
  ADD CONSTRAINT "cash_register_sessions_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A register's takings are the payments and refunds linked to it.
CREATE INDEX "payments_register_session_id_idx" ON "payments"("register_session_id");
CREATE INDEX "refunds_register_session_id_idx" ON "refunds"("register_session_id");

-- A closed register is a record: its figures never change, and it never opens again.
CREATE FUNCTION protect_register_session() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cash register sessions cannot be deleted';
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'A closed cash register cannot be changed';
  END IF;
  IF (NEW.restaurant_id, NEW.user_id, NEW.opening_cash_paise, NEW.opened_at, NEW.business_date)
     IS DISTINCT FROM
     (OLD.restaurant_id, OLD.user_id, OLD.opening_cash_paise, OLD.opened_at, OLD.business_date) THEN
    RAISE EXCEPTION 'The opening details of a cash register cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER cash_register_sessions_protect BEFORE UPDATE OR DELETE ON cash_register_sessions
  FOR EACH ROW EXECUTE FUNCTION protect_register_session();

ALTER TABLE cash_register_sessions
  ADD CONSTRAINT register_closed_has_count CHECK (
    (status = 'OPEN' AND closed_at IS NULL)
    OR (status = 'CLOSED' AND closed_at IS NOT NULL AND counted_cash_paise IS NOT NULL AND expected_cash_paise IS NOT NULL AND counted_cash_paise >= 0)
  );
ALTER TABLE cash_register_transactions
  DROP CONSTRAINT register_txn_non_negative,
  ADD CONSTRAINT register_txn_positive CHECK (amount_paise > 0);

-- One layout per kind of printout; the paper width comes from the printer it is sent to.
DROP INDEX "print_templates_restaurant_id_type_paper_width_name_key";
ALTER TABLE "print_templates" DROP COLUMN "paper_width";
CREATE UNIQUE INDEX "print_templates_restaurant_id_type_name_key" ON "print_templates"("restaurant_id", "type", "name");

-- The print queue: what a job is, when it may next be tried, and whether the fallback printer was used.
ALTER TABLE "print_jobs"
  ADD COLUMN "title" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "fallback_tried" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "claimed_at" TIMESTAMP(3);
CREATE INDEX "print_jobs_queue_idx" ON "print_jobs"("restaurant_id", "next_attempt_at") WHERE status IN ('QUEUED', 'PRINTING');

-- The print bridge installed at an outlet.
CREATE TABLE "print_bridges" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "version" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "print_bridges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "print_bridges_token_hash_key" ON "print_bridges"("token_hash");
CREATE UNIQUE INDEX "print_bridges_restaurant_id_name_key" ON "print_bridges"("restaurant_id", "name");
ALTER TABLE "print_bridges" ADD CONSTRAINT "print_bridges_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What the bank or payment provider paid out for a day and method, entered by the manager.
CREATE TABLE "payment_reconciliations" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "recorded_paise" INTEGER NOT NULL,
    "settled_paise" INTEGER NOT NULL,
    "note" TEXT,
    "reconciled_by_id" UUID NOT NULL,
    "reconciled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_reconciliations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_reconciliations_restaurant_id_business_date_method_key" ON "payment_reconciliations"("restaurant_id", "business_date", "method");
ALTER TABLE "payment_reconciliations" ADD CONSTRAINT "payment_reconciliations_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_reconciliations" ADD CONSTRAINT "payment_reconciliations_settled_non_negative" CHECK (settled_paise >= 0);
