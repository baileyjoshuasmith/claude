import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');

function required(name, { optional = false } = {}) {
  const value = process.env[name];
  if (!value && !optional) {
    console.warn(`[config] ${name} is not set yet (fine until you run the sync that needs it)`);
  }
  return value ?? '';
}

export const config = {
  dbPath: path.resolve(backendRoot, process.env.DB_PATH || './data/life-dashboard.sqlite'),
  google: {
    clientId: required('GOOGLE_CLIENT_ID', { optional: true }),
    clientSecret: required('GOOGLE_CLIENT_SECRET', { optional: true }),
    refreshToken: required('GOOGLE_REFRESH_TOKEN', { optional: true }),
  },
  apple: {
    email: required('APPLE_ID_EMAIL', { optional: true }),
    appSpecificPassword: required('APPLE_APP_SPECIFIC_PASSWORD', { optional: true }),
  },
  learnuq: {
    icsUrl: required('LEARNUQ_ICS_URL', { optional: true }),
  },
};
