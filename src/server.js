import { createApp } from './api/app.js';
import { config } from './config/env.js';
import { prisma } from './db/prisma.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`Payout API listening on http://localhost:${config.port}`);
  console.log(`Gateway mode: ${config.gatewayMode}`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
