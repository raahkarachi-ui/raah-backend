// DEVELOPMENT ONLY. In-memory quote, booking and driver-flow endpoints: no
// Postgres, no Redis. Data is lost when the server stops.
//
// Passenger endpoints (quote, book) accept any token. Driver endpoints
// (pending, accept, start, complete) need a valid login token AND an APPROVED
// driver account, and only the driver who accepted a ride can start or
// complete it.
//
// Response keys are snake_case and booking takes `quote_id`, matching
// app/lib/data/http_repository.dart.
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { httpError } from '../http.js';
import { computeFare } from '../services/fare.js';
import { requireUser } from './identity.js';

const cfg = {
  baseFarePkr: 80,
  perKmPkr: 35,
  perMinPkr: 3,
  minimumFarePkr: 150,
  roundToPkr: 5,
  platformFeePkr: 20,
  referencePetrolPricePkr: 398.96,
};
const PETROL_PKR = cfg.referencePetrolPricePkr;
const QUOTE_TTL_MS = 5 * 60 * 1000;
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

/** `isApprovedDriver(userId)` comes from the driver store. */
export function ridesMemoryRouter({ isApprovedDriver }) {
  const router = Router();
  const quotes = new Map();
  const rides = new Map();

  const requireApprovedDriver = (req, _res, next) =>
    isApprovedDriver(req.user.id)
      ? next()
      : next(httpError(403, 'DRIVER_NOT_APPROVED', 'Your driver account is not approved yet'));
  const driverOnly = [requireUser, requireApprovedDriver];

  // ---- Passenger -------------------------------------------------------------

  router.post('/quote', (req, res) => {
    const { pickup, dropoff } = req.body ?? {};
    if (!validPoint(pickup) || !validPoint(dropoff)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'pickup and dropoff need numeric lat and lng',
      });
    }

    // Straight-line estimate x 1.35 for winding roads, ~20 km/h city pace.
    const distanceKm = Math.max(haversineKm(pickup, dropoff) * 1.35, 0.5);
    const durationMin = Math.max((distanceKm / 20) * 60, 3);
    const fare = computeFare(
      { distanceKm, durationMin, petrolPricePkr: PETROL_PKR },
      cfg,
    );

    const now = Date.now();
    for (const [id, q] of quotes) if (q.expiresAt < now) quotes.delete(id);

    const quote = {
      id: randomUUID(),
      pickup,
      dropoff,
      fare,
      distanceKm,
      expiresAt: now + QUOTE_TTL_MS,
    };
    quotes.set(quote.id, quote);

    res.status(201).json({
      quote_id: quote.id,
      expires_at: new Date(quote.expiresAt).toISOString(),
      fare_pkr: fare.totalFarePkr,
      distance_km: Number(distanceKm.toFixed(1)),
      duration_min: Math.round(durationMin),
      petrol_price_pkr_per_l: PETROL_PKR,
      is_approximate: true,
    });
  });

  router.post('/', (req, res) => {
    const { quote_id } = req.body ?? {};
    const quote = quotes.get(quote_id);
    if (!quote) return res.status(404).json({ error: 'QUOTE_NOT_FOUND' });
    if (quote.expiresAt < Date.now()) return res.status(410).json({ error: 'QUOTE_EXPIRED' });
    if (quote.booked) return res.status(409).json({ error: 'ALREADY_BOOKED' });

    quote.booked = true;
    const ride = {
      id: randomUUID(),
      status: 'requested',
      payment_method: req.body.payment_method ?? 'cash',
      // No passenger profiles in memory mode, so every rider is "Passenger".
      passenger_name: 'Passenger',
      pickup: quote.pickup,
      dropoff: quote.dropoff,
      distance_km: Number(quote.distanceKm.toFixed(1)),
      total_fare_pkr: quote.fare.totalFarePkr,
      platform_fee_pkr: quote.fare.platformFeePkr,
      driver_earnings_pkr: quote.fare.driverEarningsPkr,
      driver_id: null,
      created_at: new Date().toISOString(),
      accepted_at: null,
      started_at: null,
      completed_at: null,
    };
    rides.set(ride.id, ride);

    // The Flutter app reads json['ride']['id'].
    res.status(201).json({ ride, drivers_notified: 0 });
  });

  // NEW: Passenger ride history
  router.get('/history', (req, res) => {
    const completed = [...rides.values()]
      .filter((r) => r.status === 'completed')
      .sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at));
    res.json({ rides: completed });
  });

  // ---- Driver (approved drivers only) -----------------------------------------

  // Rides still waiting for a driver, oldest first. Rides older than
  // PENDING_MAX_AGE_MS are hidden (the rider has probably given up).
  router.get('/pending', ...driverOnly, (_req, res) => {
    const cutoff = Date.now() - PENDING_MAX_AGE_MS;
    const pending = [...rides.values()]
      .filter((r) => r.status === 'requested' && Date.parse(r.created_at) >= cutoff)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    res.json({ rides: pending });
  });

  // Node runs this on one thread, so two drivers cannot both win the same
  // ride: the second one gets 409.
  router.post('/:id/accept', ...driverOnly, (req, res) => {
    const ride = rides.get(req.params.id);
    if (!ride) return res.status(404).json({ error: 'RIDE_NOT_FOUND' });
    if (ride.status !== 'requested') {
      return res.status(409).json({ error: 'RIDE_UNAVAILABLE' });
    }

    ride.status = 'accepted';
    ride.driver_id = req.user.id;
    ride.accepted_at = new Date().toISOString();
    res.json({ ride });
  });

  // Driver has reached the passenger and starts the trip:
  // accepted -> in_progress.
  router.post('/:id/start', ...driverOnly, (req, res) => {
    const ride = ownRide(req, res);
    if (!ride) return;
    if (ride.status !== 'accepted') {
      return res.status(409).json({ error: 'INVALID_STATE' });
    }

    ride.status = 'in_progress';
    ride.started_at = new Date().toISOString();
    res.json({ ride });
  });

  // Driver finishes the trip: in_progress -> completed. A ride must be
  // started first. (Real mode will also settle the flat Rs. 20 fee here;
  // memory mode has no ledger.)
  router.post('/:id/complete', ...driverOnly, (req, res) => {
    const ride = ownRide(req, res);
    if (!ride) return;
    if (ride.status !== 'in_progress') {
      return res.status(409).json({ error: 'INVALID_STATE' });
    }

    ride.status = 'completed';
    ride.completed_at = new Date().toISOString();
    res.json({ ride });
  });

  /** The ride, if it exists and belongs to this driver. Otherwise replies. */
  function ownRide(req, res) {
    const ride = rides.get(req.params.id);
    if (!ride) {
      res.status(404).json({ error: 'RIDE_NOT_FOUND' });
      return null;
    }
    if (ride.driver_id !== req.user.id) {
      res.status(403).json({ error: 'NOT_YOUR_RIDE' });
      return null;
    }
    return ride;
  }

  return router;
}

function validPoint(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}