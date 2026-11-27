-- A customer is identified by mobile number: one number is one customer, and every customer has one.
-- Numbers already on record are kept as their 10 digits (spaces and dashes dropped, a leading +91, 91 or 0 removed).
UPDATE customers SET phone = regexp_replace(phone, '\D', '', 'g') WHERE phone IS NOT NULL;
UPDATE customers SET phone = right(phone, 10) WHERE length(phone) = 12 AND phone LIKE '91%';
UPDATE customers SET phone = right(phone, 10) WHERE length(phone) = 11 AND phone LIKE '0%';
UPDATE customers SET phone = NULL WHERE phone = '';

-- Two records with one number become one: the oldest is kept, and the other's orders move to it.
UPDATE orders o SET customer_id = keep.id
  FROM customers dup
  JOIN LATERAL (
    SELECT id FROM customers k WHERE k.restaurant_id = dup.restaurant_id AND k.phone = dup.phone ORDER BY k.created_at, k.id LIMIT 1
  ) keep ON TRUE
  WHERE o.customer_id = dup.id AND dup.phone IS NOT NULL AND dup.id <> keep.id;
DELETE FROM customers dup
  WHERE dup.phone IS NOT NULL AND dup.id <> (
    SELECT id FROM customers k WHERE k.restaurant_id = dup.restaurant_id AND k.phone = dup.phone ORDER BY k.created_at, k.id LIMIT 1
  );

-- A record without a number cannot be identified, so it goes. Its orders lose the link (the foreign key sets it to
-- nothing); the bills keep the name they were issued with.
DELETE FROM customers WHERE phone IS NULL;

ALTER TABLE customers ALTER COLUMN phone SET NOT NULL, ALTER COLUMN name DROP NOT NULL;
DROP INDEX IF EXISTS "customers_restaurant_id_phone_idx";
CREATE UNIQUE INDEX "customers_restaurant_id_phone_key" ON "customers"("restaurant_id", "phone");
