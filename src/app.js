import cors from 'cors';
import express from 'express';
import { ZodError } from 'zod';
import { authMemoryRouter } from './dev/auth.memory.js';
import { adminMemoryRouter, createDriverStore, driversMemoryRouter } from './dev/drivers.memory.js';
import { adminKey } from './dev/identity.js';
import { ridesMemoryRouter } from './dev/rides.memory.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { driversRouter } from './routes/drivers.js';
import { fundRouter } from './routes/fund.js';
import { ridesRouter } from './routes/rides.js';

export function createApp({ presence, devInMemory = false }) {
  const app = express();
  app.use(cors());

  if (devInMemory) {
    app.use((req, res, next) => {
      const startedAt = Date.now();
      res.on('finish', () => {
        console.log(
          `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startedAt}ms)`,
        );
      });
      next();
    });
  }

  const smallJson = express.json({ limit: '50kb' });
  app.use((req, res, next) =>
    req.path === '/api/v1/drivers/register' ? next() : smallJson(req, res, next),
  );

  app.get('/health', (_req, res) => res.json({ ok: true, mode: devInMemory ? 'in-memory' : 'database' }));

  if (devInMemory) {
    const driverStore = createDriverStore();
    app.use('/api/v1/auth', authMemoryRouter());
    app.use('/api/v1/rides', ridesMemoryRouter({ isApprovedDriver: driverStore.isApproved }));
    app.use('/api/v1/drivers', driversMemoryRouter(driverStore));
    app.use('/api/v1/admin', adminMemoryRouter(driverStore));
    app.use('/api/v1/fund', (_req, res) =>
      res.status(501).json({ error: 'NOT_AVAILABLE_IN_MEMORY_MODE' }),
    );
    console.warn(
      process.env.ADMIN_KEY
        ? 'Admin routes need the x-admin-key header (value from ADMIN_KEY).'
        : `Admin routes need the header  x-admin-key: ${adminKey()}  (dev default; set ADMIN_KEY to change).`,
    );
  } else {
    app.use('/api/v1/auth', authRouter());
    app.use('/api/v1/rides', ridesRouter({ presence }));
    app.use('/api/v1/drivers', driversRouter({ presence }));
    app.use('/api/v1/fund', fundRouter());
    app.use('/api/v1/admin', adminRouter());
  }

  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: err.issues });
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.code ?? err.type ?? 'ERROR', message: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  return app;
}