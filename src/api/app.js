import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { usersRouter } from './routes/users.js';
import { brandsRouter } from './routes/brands.js';
import { salesRouter } from './routes/sales.js';
import { payoutsRouter } from './routes/payouts.js';
import { jobsRouter } from './routes/jobs.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { warmup } from '../db/prisma.js';
import { config } from '../config/env.js';
import { asyncHandler } from './middleware/asyncHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', '..', 'public');

export function createApp() {
  const app = express();
  app.use(express.json());

  // Web console (static UI). Served before the DB-warmup gate so the page loads
  // even while Neon's compute is cold; its own API calls trigger the warm-up.
  app.use(express.static(publicDir));

  // DB-independent liveness probe (must not touch the database). Also surfaces
  // a little config the UI displays.
  app.get('/health', (_req, res) =>
    res.json({
      status: 'ok',
      gatewayMode: config.gatewayMode,
      withdrawalWindowHours: config.withdrawalWindowHours,
    }),
  );

  
  let warmed = null;
  app.use(
    asyncHandler(async (_req, _res, next) => {
      try {
        warmed = warmed ?? warmup();
        await warmed;
      } catch (err) {
        warmed = null; 
        throw err;
      }
      next();
    }),
  );

  app.use('/users', usersRouter);
  app.use('/brands', brandsRouter);
  app.use('/sales', salesRouter);
  app.use('/payouts', payoutsRouter);
  app.use('/jobs', jobsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
