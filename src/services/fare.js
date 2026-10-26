// Pure business rules for fares and the flat platform fee. No I/O here so the
// rules are trivial to test. All money is whole PKR integers.

/**
 * Fare = (base + per-km (scaled by petrol price) + per-minute) x multiplier,
 * rounded UP to the nearest `roundToPkr`, never below the minimum fare
 * (which scales with the multiplier too).
 *
 * `multiplier` is the vehicle category's factor (Bike = 1, so Bike fares are
 * exactly what they were before categories existed).
 *
 * The platform fee is a FLAT amount taken from the driver's side of the fare.
 * It does not depend on the fare, so the rider never pays more because of it.
 */
export function computeFare({ distanceKm, durationMin, petrolPricePkr }, cfg, multiplier = 1) {
  assertPositive('distanceKm', distanceKm);
  assertPositive('durationMin', durationMin);
  assertPositive('petrolPricePkr', petrolPricePkr);
  assertPositive('multiplier', multiplier);

  const fuelFactor = petrolPricePkr / cfg.referencePetrolPricePkr;
  const raw =
    (cfg.baseFarePkr +
      cfg.perKmPkr * fuelFactor * distanceKm +
      cfg.perMinPkr * durationMin) *
    multiplier;

  const totalFarePkr = Math.max(
    roundUpTo(raw, cfg.roundToPkr),
    Math.ceil(cfg.minimumFarePkr * multiplier - 1e-9),
  );
  const platformFeePkr = cfg.platformFeePkr;

  return {
    totalFarePkr,
    platformFeePkr,
    driverEarningsPkr: totalFarePkr - platformFeePkr,
    fuelFactor,
  };
}

/**
 * Prices for every category at once:
 * { bike: {totalFarePkr, platformFeePkr, driverEarningsPkr}, rickshaw: {...}, ... }
 */
export function computeCategoryFares(inputs, cfg, categories) {
  return Object.fromEntries(
    categories.map((c) => {
      const f = computeFare(inputs, cfg, c.multiplier);
      return [
        c.id,
        {
          totalFarePkr: f.totalFarePkr,
          platformFeePkr: f.platformFeePkr,
          driverEarningsPkr: f.driverEarningsPkr,
        },
      ];
    }),
  );
}

/**
 * Splits the flat fee between the Driver Welfare Fund and operations.
 * Whole rupees only; any remainder goes to operations so nothing is lost.
 */
export function splitPlatformFee(platformFeePkr, welfareShareBps) {
  const welfarePkr = Math.floor((platformFeePkr * welfareShareBps) / 10_000);
  return { welfarePkr, operationsPkr: platformFeePkr - welfarePkr };
}

function roundUpTo(value, step) {
  // The epsilon stops float noise (540.0000000000001) rounding up a full step.
  return Math.ceil(value / step - 1e-9) * step;
}

function assertPositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
}
