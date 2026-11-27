-- Closing gaps in bill numbers. When a billed order is deleted, the bills after it in the same
-- series move up, so the sequence has no missing number. Credit-note series work the same way.
--
-- compact_series renumbers the documents of one series from p_from upwards, in order, and sets the
-- series counter to follow the last one. It returns each number that changed. Bills are protected
-- by trigger, so the caller must have switched app.owner_override on for the transaction, and
-- writes the returned mapping to the audit log: a printed copy still carries the old number.
CREATE FUNCTION compact_series(p_series uuid, p_from integer)
RETURNS TABLE (old_number integer, new_number integer) AS $$
DECLARE
  s number_series%ROWTYPE;
  head text;
  width integer;
  n integer;
  r record;
BEGIN
  SELECT * INTO s FROM number_series WHERE id = p_series FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  -- The same format the application uses: "A1/2627/000123", at most 16 characters.
  head := s.prefix || '/' || s.financial_year || '/';
  width := greatest(1, least(6, 16 - length(head)));
  n := greatest(
    coalesce((SELECT max(i.number) FROM invoices i WHERE i.series_id = p_series AND i.number < p_from), 0),
    coalesce((SELECT max(f.number) FROM refunds f WHERE f.series_id = p_series AND f.number < p_from), 0));

  FOR r IN SELECT i.id, i.number FROM invoices i WHERE i.series_id = p_series AND i.number >= p_from ORDER BY i.number LOOP
    n := n + 1;
    IF r.number <> n THEN
      UPDATE invoices SET number = n, invoice_number = head || CASE WHEN length(n::text) >= width THEN n::text ELSE lpad(n::text, width, '0') END
      WHERE id = r.id;
      old_number := r.number; new_number := n;
      RETURN NEXT;
    END IF;
  END LOOP;

  FOR r IN SELECT f.id, f.number FROM refunds f WHERE f.series_id = p_series AND f.number >= p_from ORDER BY f.number LOOP
    n := n + 1;
    IF r.number <> n THEN
      UPDATE refunds SET number = n, credit_note_number = head || CASE WHEN length(n::text) >= width THEN n::text ELSE lpad(n::text, width, '0') END
      WHERE id = r.id;
      old_number := r.number; new_number := n;
      RETURN NEXT;
    END IF;
  END LOOP;

  UPDATE number_series SET next_number = n + 1, updated_at = now() WHERE id = p_series;
END;
$$ LANGUAGE plpgsql;
