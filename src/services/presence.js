// Live driver state in Redis (needs Redis 6.2+ for GEOSEARCH).
//   driver:{id}:available  present while the driver is online AND free
//   driver:{id}:loc        latest location, expires so stale drivers drop out
//   drivers:geo            geo index of AVAILABLE drivers, used for dispatch
//   offer:{id}             the ride offer currently shown to a driver (short TTL)

const GEO = 'drivers:geo';
const LOC_TTL_SECONDS = 30;

const availableKey = (id) => `driver:${id}:available`;
const locKey = (id) => `driver:${id}:loc`;
const offerKey = (id) => `offer:${id}`;

export function createPresence(redis) {
  return {
    /** Online and free to take a ride (or free again after a ride). */
    async setAvailable(driverId, available) {
      if (available) {
        await redis.set(availableKey(driverId), '1');
      } else {
        await redis.multi().del(availableKey(driverId)).zrem(GEO, driverId).exec();
      }
    },

    async updateLocation(driverId, { lat, lng }) {
      const pipe = redis.multi();
      pipe.set(locKey(driverId), JSON.stringify({ lat, lng, at: Date.now() }), 'EX', LOC_TTL_SECONDS);
      if (await redis.exists(availableKey(driverId))) {
        pipe.geoadd(GEO, lng, lat, driverId);
      }
      await pipe.exec();
    },

    async getLocation(driverId) {
      const raw = await redis.get(locKey(driverId));
      return raw ? JSON.parse(raw) : null;
    },

    /** Closest available drivers with a fresh location, nearest first. */
    async findNearby({ lat, lng }, { radiusKm, count = 10 }) {
      const ids = await redis.geosearch(
        GEO, 'FROMLONLAT', lng, lat, 'BYRADIUS', radiusKm, 'km', 'ASC', 'COUNT', count,
      );
      if (ids.length === 0) return [];
      const fresh = await redis.mget(ids.map(locKey));
      return ids.filter((_, i) => fresh[i] !== null);
    },

    async offerRide(driverIds, offer, ttlSeconds) {
      if (driverIds.length === 0) return;
      const pipe = redis.multi();
      const payload = JSON.stringify(offer);
      for (const id of driverIds) pipe.set(offerKey(id), payload, 'EX', ttlSeconds);
      await pipe.exec();
      // TODO: send an FCM push too, so the offer pops up with the app closed.
    },

    async getOffer(driverId) {
      const raw = await redis.get(offerKey(driverId));
      return raw ? JSON.parse(raw) : null;
    },

    async clearOffer(driverId) {
      await redis.del(offerKey(driverId));
    },
  };
}

const FALLBACKS = {
  setAvailable: undefined,
  updateLocation: undefined,
  getLocation: null,
  findNearby: [],
  offerRide: undefined,
  getOffer: null,
  clearOffer: undefined,
};

/**
 * Redis only powers live dispatch. If it is down or slow, a ride must still
 * be booked and the driver app (which reads rides from Postgres) must still
 * work. Each call gets at most `timeoutMs`; on error or timeout it logs once
 * per outage and returns a harmless empty value instead of throwing.
 */
export function bestEffort(presence, { timeoutMs = 1500 } = {}) {
  let warned = false;
  const wrapped = {};
  for (const [name, fallback] of Object.entries(FALLBACKS)) {
    wrapped[name] = async (...args) => {
      let timer;
      try {
        const result = await Promise.race([
          presence[name](...args),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Redis timed out')), timeoutMs);
          }),
        ]);
        warned = false;
        return result;
      } catch (err) {
        if (!warned) {
          console.warn(`[presence] Redis unavailable (${name}): ${err.message}. Continuing without live dispatch.`);
          warned = true;
        }
        return fallback;
      } finally {
        clearTimeout(timer);
      }
    };
  }
  return wrapped;
}