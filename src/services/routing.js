// Distance and duration come from the SERVER, never from the client, so a
// rider cannot lower their own fare by sending a short distance.

/**
 * Uses the Google Routes API when a key is configured; otherwise (or on any
 * failure) falls back to a straight-line estimate and says so, so the fare can
 * be labelled "approximate".
 */
export async function estimateRoute(pickup, dropoff, { apiKey }) {
  if (apiKey) {
    try {
      return await googleRoute(pickup, dropoff, apiKey);
    } catch (err) {
      console.warn('Google Routes failed, using estimate:', err.message);
    }
  }
  return straightLineEstimate(pickup, dropoff);
}

async function googleRoute(pickup, dropoff, apiKey) {
  const point = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
    },
    body: JSON.stringify({
      origin: point(pickup),
      destination: point(dropoff),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Routes API HTTP ${res.status}`);

  const route = (await res.json()).routes?.[0];
  if (!route?.distanceMeters || !route.duration) throw new Error('No route found');

  return {
    distanceKm: route.distanceMeters / 1000,
    durationMin: parseInt(route.duration, 10) / 60, // "1234s" -> 1234
    source: 'google',
  };
}

function straightLineEstimate(a, b) {
  const distanceKm = Math.max(haversineKm(a, b) * 1.35, 0.5); // roads wind
  const durationMin = Math.max((distanceKm / 20) * 60, 3); // ~20 km/h city pace
  return { distanceKm, durationMin, source: 'estimate' };
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
