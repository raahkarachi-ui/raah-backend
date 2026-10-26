import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { currentFuelPrice, pool, withTransaction } from '../db.js';
import { httpError } from '../http.js';
import { requireDriver, requireRole } from '../middleware/auth.js';
import { computeCategoryFares } from '../services/fare.js';
import { settleRideFee } from '../services/ledger.js';
import { estimateRoute } from '../services/routing.js';
import { CATEGORY_IDS, VEHICLE_CATEGORIES } from '../services/vehicleCategories.js';

const Point = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().trim().min(1).max(300),
});
const QuoteBody = z.object({ pickup: Point, dropoff: Point });
const BookBody = z.object({
  quote_id: z.string().uuid(),
  payment_method: z.enum(['cash', 'easypaisa', 'jazzcash']).default('cash'),
  // Defaults to bike so older app builds keep working.
  vehicle_category: z.enum(CATEGORY_IDS).default('bike'),
});

const ACTIVE = ['accepted', 'arrived', 'in_progress'];

export function ridesRouter({ presence }) {
  const router = Router();

  // 1) Show the fare BEFORE booking. Distance comes from the server, and the
  //    prices (one per vehicle category) are locked to the petrol price in
  //    force right now.
  router.post('/quote', requireRole('passenger', 'driver', 'admin'), async (req, res) => {
    const { pickup, dropoff } = QuoteBody.parse(req.body);

    const fuel = await currentFuelPrice();
    const route = await estimateRoute(pickup, dropoff, {
      apiKey: config.googleMapsApiKey,
    });
    const categoryFares = computeCategoryFares(
      {
        distanceKm: route.distanceKm,
        durationMin: route.durationMin,
        petrolPricePkr: Number(fuel.price_pkr_per_l),
      },
      config.fare,
      VEHICLE_CATEGORIES,
    );
    const base = categoryFares.bike; // the quote's own fare columns stay the Bike rate

    const { rows } = await pool.query(
      `INSERT INTO quotes
         (passenger_id, pickup_lat, pickup_lng, pickup_address,
          dropoff_lat, dropoff_lng, dropoff_address,
          distance_km, duration_min, route_source, fuel_price_id, petrol_price_pkr,
          total_fare_pkr, platform_fee_pkr, driver_earnings_pkr, category_fares, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
               now() + make_interval(secs => $17))
       RETURNING id, expires_at`,
      [
        req.user.id, pickup.lat, pickup.lng, pickup.address,
        dropoff.lat, dropoff.lng, dropoff.address,
        route.distanceKm.toFixed(2), route.durationMin.toFixed(1), route.source,
        fuel.id, fuel.price_pkr_per_l,
        base.totalFarePkr, base.platformFeePkr, base.driverEarningsPkr,
        JSON.stringify(categoryFares),
        config.quoteTtlSeconds,
      ],
    );

    res.status(201).json({
      quote_id: rows[0].id,
      expires_at: rows[0].expires_at,
      fare_pkr: base.totalFarePkr, // Bike rate; kept for older app builds
      options: VEHICLE_CATEGORIES.map((c) => ({
        category: c.id,
        label: c.label,
        multiplier: c.multiplier,
        fare_pkr: categoryFares[c.id].totalFarePkr,
      })),
      distance_km: Number(route.distanceKm.toFixed(1)),
      duration_min: Math.round(route.durationMin),
      petrol_price_pkr_per_l: Number(fuel.price_pkr_per_l),
      is_approximate: route.source === 'estimate',
    });
  });

  // 2) Book from a quote. The fare the rider saw is the fare they get; if the
  //    petrol price moved in between, we refuse and ask for a fresh quote.
  //    The price comes from the stored quote, never from the client.
  router.post('/', requireRole('passenger', 'driver', 'admin'), async (req, res) => {
    const { quote_id, payment_method, vehicle_category } = BookBody.parse(req.body);

    const ride = await withTransaction(async (db) => {
      const { rows } = await db.query(
        'SELECT * FROM quotes WHERE id = $1 AND passenger_id = $2 FOR UPDATE',
        [quote_id, req.user.id],
      );
      const q = rows[0];
      if (!q) throw httpError(404, 'QUOTE_NOT_FOUND');
      if (new Date(q.expires_at) < new Date()) throw httpError(410, 'QUOTE_EXPIRED');

      const fuel = await currentFuelPrice(db);
      if (String(fuel.id) !== String(q.fuel_price_id)) {
        throw httpError(409, 'PRICE_CHANGED', 'Petrol price changed. Request a new quote.');
      }

      // Quotes made before categories existed only carry the Bike price.
      const fares = q.category_fares ?? {
        bike: {
          totalFarePkr: q.total_fare_pkr,
          platformFeePkr: q.platform_fee_pkr,
          driverEarningsPkr: q.driver_earnings_pkr,
        },
      };
      const f = fares[vehicle_category];
      if (!f) throw httpError(410, 'QUOTE_EXPIRED', 'Request a new quote.');

      try {
        const inserted = await db.query(
          `INSERT INTO rides
             (quote_id, passenger_id, payment_method, vehicle_category,
              pickup_lat, pickup_lng, pickup_address,
              dropoff_lat, dropoff_lng, dropoff_address,
              distance_km, petrol_price_pkr,
              total_fare_pkr, platform_fee_pkr, driver_earnings_pkr)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING *`,
          [
            q.id, req.user.id, payment_method, vehicle_category,
            q.pickup_lat, q.pickup_lng, q.pickup_address,
            q.dropoff_lat, q.dropoff_lng, q.dropoff_address,
            q.distance_km, q.petrol_price_pkr,
            f.totalFarePkr, f.platformFeePkr, f.driverEarningsPkr,
          ],
        );
        return inserted.rows[0];
      } catch (err) {
        if (err.code === '23505') throw httpError(409, 'ALREADY_BOOKED');
        throw err;
      }
    });

    // Offer the ride to the nearest available drivers of the SAME category.
    const nearbyIds = await presence.findNearby(
      { lat: ride.pickup_lat, lng: ride.pickup_lng },
      { radiusKm: config.dispatchRadiusKm },
    );
    const { rows: eligible } =
      nearbyIds.length === 0
        ? { rows: [] }
        : await pool.query(
            `SELECT user_id FROM drivers
              WHERE user_id = ANY($1::uuid[]) AND vehicle_category = $2 AND status = 'approved'`,
            [nearbyIds, ride.vehicle_category],
          );
    const driverIds = eligible.map((r) => r.user_id);

    const { rows: [passenger] } = await pool.query(
      'SELECT name FROM users WHERE id = $1',
      [req.user.id],
    );
    await presence.offerRide(
      driverIds,
      {
        ride_id: ride.id,
        vehicle_category: ride.vehicle_category,
        passenger_name: passenger?.name || 'Passenger',
        pickup_address: ride.pickup_address,
        dropoff_address: ride.dropoff_address,
        trip_distance_km: Number(ride.distance_km),
        total_fare_pkr: ride.total_fare_pkr,
        platform_fee_pkr: ride.platform_fee_pkr,
        driver_earnings_pkr: ride.driver_earnings_pkr,
        expires_in_seconds: config.offerTtlSeconds,
      },
      config.offerTtlSeconds,
    );

    res.status(201).json({ ride: toRide(ride), drivers_notified: driverIds.length });
  });

  // Rides still waiting for a driver, oldest first (what the driver app polls).
  // A driver only sees rides of their own vehicle category.
  // Straight from the database, so it works with or without Redis.
  router.get('/pending', requireDriver, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT r.*, COALESCE(NULLIF(u.name, ''), 'Passenger') AS passenger_name
         FROM rides r JOIN users u ON u.id = r.passenger_id
        WHERE r.status = 'requested' AND r.created_at > now() - interval '10 minutes'
          AND r.vehicle_category = (SELECT vehicle_category FROM drivers WHERE user_id = $1)
        ORDER BY r.created_at ASC LIMIT 20`,
      [req.user.id],
    );
    res.json({ rides: rows.map((r) => ({ ...toRide(r), passenger_name: r.passenger_name })) });
  });

  router.get('/:id', requireRole('passenger', 'driver', 'admin'), async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM rides WHERE id = $1', [req.params.id]);
    const ride = rows[0];
    const isParty = ride && (ride.passenger_id === req.user.id || ride.driver_id === req.user.id);
    if (!ride || (!isParty && req.user.role !== 'admin')) throw httpError(404, 'RIDE_NOT_FOUND');

    const driver_location =
      ride.driver_id && ACTIVE.includes(ride.status)
        ? await presence.getLocation(ride.driver_id)
        : null;
    res.json({ ride: toRide(ride), driver_location });
  });

  // 3) Driver accepts. Must hold at least one fee's worth of prepaid balance,
  //    and must drive the vehicle category the passenger asked for.
  router.post('/:id/accept', requireDriver, async (req, res) => {
    const ride = await withTransaction(async (db) => {
      const { rows: [driver] } = await db.query(
        'SELECT fee_balance_pkr, vehicle_category FROM drivers WHERE user_id = $1 FOR UPDATE',
        [req.user.id],
      );
      if (!driver) throw httpError(403, 'NOT_A_DRIVER');

      const { rows: [current] } = await db.query('SELECT * FROM rides WHERE id = $1', [req.params.id]);
      if (!current) throw httpError(404, 'RIDE_NOT_FOUND');
      if (current.status !== 'requested') throw httpError(409, 'RIDE_UNAVAILABLE');
      if (current.vehicle_category !== driver.vehicle_category) {
        throw httpError(403, 'WRONG_VEHICLE_CATEGORY', 'This ride needs a different vehicle type.');
      }
      if (driver.fee_balance_pkr < current.platform_fee_pkr) {
        throw httpError(402, 'INSUFFICIENT_FEE_BALANCE', 'Top up your fee balance to accept rides.');
      }

      try {
        // Guarded update: only one driver can win a ride.
        const { rows } = await db.query(
          `UPDATE rides SET status = 'accepted', driver_id = $2, accepted_at = now()
           WHERE id = $1 AND status = 'requested' AND vehicle_category = $3 RETURNING *`,
          [req.params.id, req.user.id, driver.vehicle_category],
        );
        if (!rows[0]) throw httpError(409, 'RIDE_UNAVAILABLE');
        return rows[0];
      } catch (err) {
        if (err.code === '23505') throw httpError(409, 'DRIVER_BUSY');
        throw err;
      }
    });

    await presence.setAvailable(req.user.id, false); // busy: out of dispatch
    await presence.clearOffer(req.user.id);
    res.json({ ride: toRide(ride) });
  });

  // 4) Driver progress: arrived, then started.
  router.post('/:id/arrived', requireDriver, (req, res) =>
    driverStep(req, res, { from: 'accepted', to: 'arrived', stamp: 'arrived_at' }));
  router.post('/:id/start', requireDriver, (req, res) =>
    driverStep(req, res, { from: ['accepted', 'arrived'], to: 'in_progress', stamp: 'started_at' }));

  // 5) Complete: flat Rs. 20 leaves the driver's prepaid balance and is split
  //    60/40 between the Welfare Fund and operations, atomically.
  router.post('/:id/complete', requireDriver, async (req, res) => {
    const ride = await withTransaction(async (db) => {
      const { rows } = await db.query(
        `UPDATE rides
           SET status = 'completed', completed_at = now(),
               payment_status = CASE WHEN payment_method = 'cash'
                                     THEN 'cash_collected_by_driver'
                                     ELSE 'paid_direct_to_driver_pending' END
         WHERE id = $1 AND driver_id = $2 AND status = 'in_progress'
         RETURNING *`,
        [req.params.id, req.user.id],
      );
      if (!rows[0]) throw httpError(409, 'INVALID_STATE');
      await settleRideFee(db, rows[0]);
      return rows[0];
    });

    await presence.setAvailable(req.user.id, true);
    res.json({
      ride: toRide(ride),
      settlement: {
        total_fare_pkr: ride.total_fare_pkr,
        platform_fee_pkr: ride.platform_fee_pkr,
        driver_earnings_pkr: ride.driver_earnings_pkr,
      },
    });
  });

  router.post('/:id/cancel', requireRole('passenger', 'driver', 'admin'), async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE rides SET status = 'cancelled', cancelled_at = now(), cancelled_by = CASE WHEN passenger_id = $2 THEN 'passenger' ELSE 'driver' END
       WHERE id = $1 AND status IN ('requested', 'accepted', 'arrived')
         AND (passenger_id = $2 OR driver_id = $2)
       RETURNING *`,
      [req.params.id, req.user.id],
    );
    if (!rows[0]) throw httpError(409, 'INVALID_STATE');
    // No fee is charged for a ride that did not complete.
    if (rows[0].driver_id) await presence.setAvailable(rows[0].driver_id, true);
    res.json({ ride: toRide(rows[0]) });
  });

  async function driverStep(req, res, { from, to, stamp }) {
    const { rows } = await pool.query(
      `UPDATE rides SET status = $3, ${stamp} = now()
       WHERE id = $1 AND driver_id = $2 AND status = ANY($4::text[]) RETURNING *`,
      [req.params.id, req.user.id, to, [].concat(from)],
    );
    if (!rows[0]) throw httpError(409, 'INVALID_STATE');
    res.json({ ride: toRide(rows[0]) });
  }

  return router;
}

function toRide(r) {
  return {
    id: r.id,
    status: r.status,
    payment_method: r.payment_method,
    payment_status: r.payment_status,
    vehicle_category: r.vehicle_category,
    pickup: { lat: r.pickup_lat, lng: r.pickup_lng, address: r.pickup_address },
    dropoff: { lat: r.dropoff_lat, lng: r.dropoff_lng, address: r.dropoff_address },
    distance_km: Number(r.distance_km ?? 0),
    total_fare_pkr: r.total_fare_pkr,
    platform_fee_pkr: r.platform_fee_pkr,
    driver_earnings_pkr: r.driver_earnings_pkr,
    driver_id: r.driver_id,
    created_at: r.created_at,
  };
}
