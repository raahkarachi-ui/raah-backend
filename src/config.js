const env = process.env;

function number(name, fallback, { integer = false } = {}) {
  const raw = env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'}`);
  }
  return value;
}

if (!env.JWT_SECRET) throw new Error('JWT_SECRET is required');

export const config = {
  port: number('PORT', 3000, { integer: true }),
  databaseUrl: env.DATABASE_URL ?? 'postgres://raah:raah@localhost:5432/raah',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: env.JWT_SECRET,
  googleMapsApiKey: env.GOOGLE_MAPS_API_KEY ?? '',

  // Flat fee charged to the driver per ride. Never a percentage.
  fare: {
    platformFeePkr: number('PLATFORM_FEE_PKR', 20, { integer: true }),
    // Placeholders: calibrate against real Karachi trip costs.
    baseFarePkr: number('BASE_FARE_PKR', 80),
    perKmPkr: number('PER_KM_PKR', 35),
    perMinPkr: number('PER_MIN_PKR', 3),
    minimumFarePkr: number('MINIMUM_FARE_PKR', 150, { integer: true }),
    roundToPkr: number('ROUND_FARE_TO_PKR', 5, { integer: true }),
    referencePetrolPricePkr: number('REFERENCE_PETROL_PKR', 398.96),
  },

  fund: {
    welfareShareBps: number('WELFARE_SHARE_BPS', 6000, { integer: true }),
  },

  quoteTtlSeconds: 300,
  offerTtlSeconds: 15,
  dispatchRadiusKm: 3,
};

if (config.fare.minimumFarePkr <= config.fare.platformFeePkr) {
  throw new Error('MINIMUM_FARE_PKR must be greater than PLATFORM_FEE_PKR');
}
if (config.fund.welfareShareBps < 0 || config.fund.welfareShareBps > 10_000) {
  throw new Error('WELFARE_SHARE_BPS must be between 0 and 10000');
}