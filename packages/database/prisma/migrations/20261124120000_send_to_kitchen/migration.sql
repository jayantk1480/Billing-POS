-- A product with no kitchen station now goes to the restaurant's first active station instead of getting no kitchen
-- ticket at all. Leaving a product out of kitchen tickets (bottled water, say) is its own choice: send_to_kitchen = false.
-- Every existing product starts as true: before this, "no station" was the form's default, so it was rarely meant.
ALTER TABLE "products" ADD COLUMN "send_to_kitchen" BOOLEAN NOT NULL DEFAULT true;
