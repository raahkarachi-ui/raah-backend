-- Driver verification + admin. Safe to run more than once.
BEGIN;

-- Existing drivers keep working: they become 'approved'. New rows default to 'pending'.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved';
ALTER TABLE drivers ALTER COLUMN status SET DEFAULT 'pending';
DO $$ BEGIN
  ALTER TABLE drivers ADD CONSTRAINT drivers_status_check
    CHECK (status IN ('pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cnic             text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS license_number   text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_reg_no   text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS applied_at       timestamptz NOT NULL DEFAULT now();
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS reviewed_at      timestamptz;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS reviewed_by      uuid REFERENCES users(id);

CREATE TABLE IF NOT EXISTS driver_documents (
  driver_id   uuid NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('cnic_front','cnic_back','license','vehicle_registration')),
  mime_type   text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  data        bytea NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (driver_id, kind)
);

CREATE INDEX IF NOT EXISTS rides_created_idx ON rides (created_at DESC);
COMMIT;
