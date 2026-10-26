BEGIN;

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_category text;
UPDATE drivers
   SET vehicle_category = CASE vehicle_type
         WHEN 'bike' THEN 'bike'
         WHEN 'rickshaw' THEN 'rickshaw'
         ELSE 'car_non_ac' END
 WHERE vehicle_category IS NULL;
ALTER TABLE drivers
  ALTER COLUMN vehicle_category SET NOT NULL,
  ADD CONSTRAINT drivers_vehicle_category_chk
    CHECK (vehicle_category IN ('bike','rickshaw','car_non_ac','car_ac'));

-- Existing rides were all priced at the base rate, so 'bike' (1.0x) is accurate.
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS vehicle_category text NOT NULL DEFAULT 'bike',
  ADD CONSTRAINT rides_vehicle_category_chk
    CHECK (vehicle_category IN ('bike','rickshaw','car_non_ac','car_ac'));

CREATE INDEX IF NOT EXISTS rides_open_by_category_idx
  ON rides (vehicle_category, created_at) WHERE status = 'requested';

COMMIT;