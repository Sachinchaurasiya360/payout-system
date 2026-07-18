/**
 * Vercel serverless entrypoint.
 *
 * An Express app is itself a `(req, res)` handler, so exporting the app makes it
 * a Vercel Node function. `vercel.json` rewrites every path to this function,
 * and Express does the routing. No `app.listen()` here — Vercel manages the
 * server. Env vars (DATABASE_URL, GATEWAY_MODE, ...) are set in the Vercel
 * project settings, not from a .env file.
 */
import { createApp } from '../src/api/app.js';

const app = createApp();

export default app;
