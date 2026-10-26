// The four ride categories. `multiplier` scales the whole fare computed by
// services/fare.js; Bike (1.0x) is the base rate.
// `vehicleType` is what gets stored in drivers.vehicle_type.
export const VEHICLE_CATEGORIES = [
  { id: 'bike',       label: 'Bike',         multiplier: 1.0, vehicleType: 'bike' },
  { id: 'rickshaw',   label: 'Rickshaw',     multiplier: 1.5, vehicleType: 'rickshaw' },
  { id: 'car_non_ac', label: 'Car (Non-AC)', multiplier: 2.0, vehicleType: 'car' },
  { id: 'car_ac',     label: 'Car (AC)',     multiplier: 2.5, vehicleType: 'car' },
];

export const CATEGORY_IDS = VEHICLE_CATEGORIES.map((c) => c.id);
export const categoryById = (id) => VEHICLE_CATEGORIES.find((c) => c.id === id);
