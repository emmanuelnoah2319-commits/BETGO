import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017'),
  MONGODB_DATABASE: z.string().min(1).default('betgo'),
  SESSION_COOKIE_NAME: z.string().min(1).default('betgo_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  SESSION_COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  BOOTSTRAP_OWNER_EMAIL: z.string().email().optional().or(z.literal('')),
  BOOTSTRAP_OWNER_PASSWORD: z.string().min(12).optional().or(z.literal('')),
  BOOKMAKER_INTEGRATIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  FCM_PROJECT_ID: z.string().optional().or(z.literal('')),
  FCM_CLIENT_EMAIL: z.string().optional().or(z.literal('')),
  FCM_PRIVATE_KEY: z.string().optional().or(z.literal(''))
});

export function loadConfig(source = process.env) {
  const result = schema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const env = result.data;
  if (env.NODE_ENV === 'production' && env.SESSION_COOKIE_SECURE !== 'true') {
    throw new Error('SESSION_COOKIE_SECURE must be true in production');
  }
  if (env.NODE_ENV === 'production' && env.SESSION_SECRET.includes('replace-with')) {
    throw new Error('Replace the placeholder SESSION_SECRET in production');
  }
  if (Boolean(env.BOOTSTRAP_OWNER_EMAIL) !== Boolean(env.BOOTSTRAP_OWNER_PASSWORD)) {
    throw new Error('BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD must be provided together');
  }
  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    appOrigin: env.APP_ORIGIN,
    mongoUri: env.MONGODB_URI,
    mongoDatabase: env.MONGODB_DATABASE,
    cookieName: env.SESSION_COOKIE_NAME,
    sessionTtlHours: env.SESSION_TTL_HOURS,
    cookieSecure: env.SESSION_COOKIE_SECURE === 'true',
    sessionSecret: env.SESSION_SECRET,
    bootstrapOwnerEmail: env.BOOTSTRAP_OWNER_EMAIL || '',
    bootstrapOwnerPassword: env.BOOTSTRAP_OWNER_PASSWORD || '',
    bookmakerIntegrationsEnabled: env.BOOKMAKER_INTEGRATIONS_ENABLED === 'true',
    fcmProjectId: env.FCM_PROJECT_ID || '',
    fcmClientEmail: env.FCM_CLIENT_EMAIL || '',
    fcmPrivateKey: env.FCM_PRIVATE_KEY || ''
  });
}
