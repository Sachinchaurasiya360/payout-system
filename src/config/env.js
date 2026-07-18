import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 3000),
  // See .env.example for the meaning of "auto" vs "always".
  gatewayMode: process.env.GATEWAY_MODE ?? 'auto',
  // The one-withdrawal-per-N-hours window. 24h per the business rules; kept
  // configurable so tests/demos can shrink it.
  withdrawalWindowHours: Number(process.env.WITHDRAWAL_WINDOW_HOURS ?? 24),
};
