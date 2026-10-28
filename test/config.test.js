import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/env.js';

const base = {
  NODE_ENV: 'test',
  PORT: '3000',
  APP_ORIGIN: 'http://localhost:3000',
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  MONGODB_DATABASE: 'betgo_test',
  SESSION_SECRET: 'test-secret-that-is-long-enough-123456',
  SESSION_COOKIE_SECURE: 'false'
};

test('loads valid config and leaves betting integration disabled', () => {
  const config = loadConfig(base);
  assert.equal(config.port, 3000);
  assert.equal(config.bookmakerIntegrationsEnabled, false);
  assert.equal(config.flutterwaveSecretKey, '');
  assert.equal(config.flutterwaveSecretHash, '');
});

test('rejects a short session secret', () => {
  assert.throws(() => loadConfig({ ...base, SESSION_SECRET: 'short' }), /SESSION_SECRET/);
});

test('requires secure cookies in production', () => {
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'false' }), /SESSION_COOKIE_SECURE/);
});

test('requires bootstrap email and password together', () => {
  assert.throws(() => loadConfig({ ...base, BOOTSTRAP_OWNER_EMAIL: 'owner@example.com' }), /must be provided together/);
});

test('provides per-bookmaker prices and a 30-day membership default', () => {
  const config = loadConfig(base);
  assert.equal(config.bookmakerPricesNgn.SportyBet, 5000);
  assert.equal(config.bookmakerPricesNgn.BetWinner, 6000);
});
