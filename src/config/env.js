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
  gatewayMode: process.env.GATEWAY_MODE ?? 'auto',
  withdrawalWindowHours: Number(process.env.WITHDRAWAL_WINDOW_HOURS ?? 24),
};
