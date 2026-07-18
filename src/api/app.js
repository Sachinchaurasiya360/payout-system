import express from 'express';
import { usersRouter } from './routes/users.js';
import { brandsRouter } from './routes/brands.js';
import { salesRouter } from './routes/sales.js';
import { payoutsRouter } from './routes/payouts.js';
import { jobsRouter } from './routes/jobs.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use('/users', usersRouter);
  app.use('/brands', brandsRouter);
  app.use('/sales', salesRouter);
  app.use('/payouts', payoutsRouter);
  app.use('/jobs', jobsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
