import express from 'express';
import { usersRouter } from './routes/users.js';
import { brandsRouter } from './routes/brands.js';
import { salesRouter } from './routes/sales.js';
import { payoutsRouter } from './routes/payouts.js';
import { jobsRouter } from './routes/jobs.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { warmup } from '../db/prisma.js';
import { asyncHandler } from './middleware/asyncHandler.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  // DB-independent liveness probe (must not touch the database).
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Warm the DB connection once per process before serving DB-backed routes.
  // On serverless each cold start is a fresh process, so this rides out Neon's
  // compute wake-up on the first request without penalising later ones.
  let warmed = null;
  app.use(
    asyncHandler(async (_req, _res, next) => {
      try {
        warmed = warmed ?? warmup();
        await warmed;
      } catch (err) {
        warmed = null; // allow a later request to retry the wake-up
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
