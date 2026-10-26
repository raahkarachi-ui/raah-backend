-- Raah Karachi schema (PostgreSQL 14+). All money is whole PKR integers.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role       text NOT NULL CHECK (role IN ('passenger', 'driver', 'admin')),
  name       text NOT NULL,
  phone      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE drivers (
  user_id          uuid PRIMARY KEY REFERENCES users(id),
  vehicle_type     text NOT NULL CHECK (vehicle_type IN ('rickshaw', 'bike', 'car')),
  plate_no         text NOT NULL,
  -- Prepaid balance the Rs. 20 fee is drawn from. Mirrors the ledger; both are
  -- updated in the same transaction. Never negative.
  fee_balance_pkr  integer NOT NULL DEFAULT 0 CHECK (fee_balance_pkr >= 0)
);

-- Official petrol price history. The newest row is "current".
CREATE TABLE fuel_prices (
  id              bigserial PRIMARY KEY,
  price_pkr_per_l numeric(8, 2) NOT NULL CHECK (price_pkr_per_l > 0),
  effective_from  timestamptz NOT NULL DEFAULT now(),
  set_by          uuid REFERENCES users(id),
  source          text
);
INSERT INTO fuel_prices (price_pkr_per_l, source)
VALUES (398.96, 'seed: provided by project owner; verify against the official notification');

-- Price-locked fare quotes shown to the passenger before booking.
CREATE TABLE quotes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_id        uuid NOT NULL REFERENCES users(id),
  pickup_lat          double precision NOT NULL,
  pickup_lng          double precision NOT NULL,
  pickup_address      text NOT NULL,
  dropoff_lat         double precision NOT NULL,
  dropoff_lng         double precision NOT NULL,
  dropoff_address     text NOT NULL,
  distance_km         numeric(7, 2) NOT NULL,
  duration_min        numeric(7, 1) NOT NULL,
  route_source        text NOT NULL CHECK (route_source IN ('google', 'estimate')),
  fuel_price_id       bigint NOT NULL REFERENCES fuel_prices(id),
  petrol_price_pkr    numeric(8, 2) NOT NULL,
  total_fare_pkr      integer NOT NULL,
  platform_fee_pkr    integer NOT NULL,
  driver_earnings_pkr integer NOT NULL,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (total_fare_pkr = platform_fee_pkr + driver_earnings_pkr)
);

CREATE TABLE rides (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id            uuid NOT NULL UNIQUE REFERENCES quotes(id),
  passenger_id        uuid NOT NULL REFERENCES users(id),
  driver_id           uuid REFERENCES users(id),
  status              text NOT NULL DEFAULT 'requested' CHECK (status IN
                        ('requested', 'accepted', 'arrived', 'in_progress',
                         'completed', 'cancelled', 'expired')),
  payment_method      text NOT NULL CHECK (payment_method IN ('cash', 'easypaisa', 'jazzcash')),
  payment_status      text NOT NULL DEFAULT 'pending',
  pickup_lat          double precision NOT NULL,
  pickup_lng          double precision NOT NULL,
  pickup_address      text NOT NULL,
  dropoff_lat         double precision NOT NULL,
  dropoff_lng         double precision NOT NULL,
  dropoff_address     text NOT NULL,
  distance_km         numeric(7, 2) NOT NULL,
  petrol_price_pkr    numeric(8, 2) NOT NULL,
  -- Snapshot of the quote so history never changes if rules change later.
  total_fare_pkr      integer NOT NULL,
  platform_fee_pkr    integer NOT NULL,
  driver_earnings_pkr integer NOT NULL,
  cancelled_by        text CHECK (cancelled_by IN ('passenger', 'driver')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  arrived_at          timestamptz,
  started_at          timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  CHECK (total_fare_pkr = platform_fee_pkr + driver_earnings_pkr)
);
-- A driver can only be on one active ride at a time.
CREATE UNIQUE INDEX one_active_ride_per_driver
  ON rides (driver_id) WHERE status IN ('accepted', 'arrived', 'in_progress');
CREATE INDEX rides_driver_completed_idx ON rides (driver_id, completed_at)
  WHERE status = 'completed';

-- Append-only ledger. Per ride the entries sum to zero:
--   driver_fee_balance -20, welfare_fund +12, operations +8.
-- Top-ups (money in from Easypaisa/JazzCash) and welfare payouts (money out
-- to a driver in need) are the only entries not tied to a ride.
CREATE TABLE ledger_entries (
  id          bigserial PRIMARY KEY,
  ride_id     uuid REFERENCES rides(id),
  driver_id   uuid REFERENCES users(id),
  account     text NOT NULL CHECK (account IN ('driver_fee_balance', 'welfare_fund', 'operations')),
  kind        text NOT NULL CHECK (kind IN ('ride_fee', 'topup', 'welfare_payout')),
  amount_pkr  integer NOT NULL CHECK (amount_pkr <> 0),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_account_idx ON ledger_entries (account, created_at DESC);
CREATE UNIQUE INDEX ledger_one_fee_per_ride_account
  ON ledger_entries (ride_id, account) WHERE kind = 'ride_fee';
