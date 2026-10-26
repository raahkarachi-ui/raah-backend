// Normal:     node --env-file=.env src/server.js
// No database: node src/server.js --in-memory      (development only)
const inMemory = process.argv.includes('--in-memory');

if (inMemory) {
  if (process.env.NODE_ENV === 'production') {
    console.error('--in-memory accepts any token and must never run in production.');
    process.exit(1);
  }
  // No .env needed in this mode.
  process.env.JWT_SECRET ??= 'dev-only-not-checked';
  console.warn('*** IN-MEMORY MODE: no database, no Redis, ANY token accepted. Data is lost on restart. ***');
}

// Imported after the env above is set: config.js reads it at load time.
const { config } = await import('./config.js');
const { createApp } = await import('./app.js');

let presence;
if (inMemory) {
  // No Redis: a stand-in with no drivers online.
  presence = {
    setAvailable: async () => {},
    updateLocation: async () => {},
    getLocation: async () => null,
    findNearby: async () => [],
    offerRide: async () => {},
    getOffer: async () => null,
    clearOffer: async () => {},
  };
} else {
  const { createRedis } = await import('./db.js');
  const { bestEffort, createPresence } = await import('./services/presence.js');
  presence = bestEffort(createPresence(createRedis()));
}

createApp({ presence, devInMemory: inMemory }).listen(config.port, () => {
  console.log(`Raah Karachi API listening on :${config.port}${inMemory ? ' (in-memory)' : ''}`);
});

// Log instead of dying silently.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));