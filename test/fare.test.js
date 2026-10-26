import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFare, splitPlatformFee } from '../src/services/fare.js';

const cfg = {
  platformFeePkr: 20,
  baseFarePkr: 80,
  perKmPkr: 35,
  perMinPkr: 3,
  minimumFarePkr: 150,
  roundToPkr: 5,
  referencePetrolPricePkr: 398.96,
};
const trip = { distanceKm: 10, durationMin: 25, petrolPricePkr: 398.96 };

test('fare at the reference petrol price', () => {
  // 80 + 35*10 + 3*25 = 505
  const f = computeFare(trip, cfg);
  assert.equal(f.totalFarePkr, 505);
  assert.equal(f.platformFeePkr, 20);
  assert.equal(f.driverEarningsPkr, 485);
});

test('platform fee is flat: the same Rs. 20 on a short and a long ride', () => {
  const short = computeFare({ ...trip, distanceKm: 3, durationMin: 8 }, cfg);
  const long = computeFare({ ...trip, distanceKm: 40, durationMin: 70 }, cfg);
  assert.equal(short.platformFeePkr, 20);
  assert.equal(long.platformFeePkr, 20);
  assert.ok(long.totalFarePkr > short.totalFarePkr);
  // Driver keeps everything except the flat fee: earnings grow 1:1 with fare.
  assert.equal(long.driverEarningsPkr - short.driverEarningsPkr,
    long.totalFarePkr - short.totalFarePkr);
});

test('fare rises and falls with the petrol price (per-km part only)', () => {
  const up = computeFare({ ...trip, petrolPricePkr: 398.96 * 1.1 }, cfg);
  const down = computeFare({ ...trip, petrolPricePkr: 398.96 * 0.9 }, cfg);
  assert.equal(up.totalFarePkr, 540); // 80 + 385 + 75, not bumped by float noise
  assert.equal(down.totalFarePkr, 470); // 80 + 315 + 75
});

test('minimum fare applies, and always exceeds the platform fee', () => {
  const f = computeFare({ distanceKm: 0.5, durationMin: 2, petrolPricePkr: 398.96 }, cfg);
  assert.equal(f.totalFarePkr, 150);
  assert.ok(f.driverEarningsPkr > 0);
});

test('fares round up to the nearest Rs. 5', () => {
  // 80 + 35*10.1 + 75 = 508.5 -> 510
  assert.equal(computeFare({ ...trip, distanceKm: 10.1 }, cfg).totalFarePkr, 510);
});

test('rejects bad input instead of producing a fare', () => {
  assert.throws(() => computeFare({ ...trip, distanceKm: 0 }, cfg), RangeError);
  assert.throws(() => computeFare({ ...trip, petrolPricePkr: NaN }, cfg), RangeError);
});

test('Rs. 20 fee splits 60/40: Rs. 12 welfare fund, Rs. 8 operations', () => {
  assert.deepEqual(splitPlatformFee(20, 6000), { welfarePkr: 12, operationsPkr: 8 });
});

test('fee split never loses a rupee', () => {
  for (const fee of [1, 7, 19, 20, 33]) {
    const { welfarePkr, operationsPkr } = splitPlatformFee(fee, 6000);
    assert.equal(welfarePkr + operationsPkr, fee);
  }
});
