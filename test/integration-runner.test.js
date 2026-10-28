import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMongoIntegrationEnvironment } from '../scripts/run-mongo-integration.js';

const validUri = 'mongodb://localhost:27017/betgo_test';

test('integration runner requires an explicit MongoDB URI', () => {
  const result = validateMongoIntegrationEnvironment({ BETGO_CONFIRM_DISPOSABLE_MONGO: 'true' });
  assert.equal(result.ok, false);
  assert.match(result.error, /MONGO_TEST_URI is required/);
});

test('integration runner rejects non-MongoDB and production-looking URIs', () => {
  assert.equal(validateMongoIntegrationEnvironment({ MONGO_TEST_URI: 'https://example.com', BETGO_CONFIRM_DISPOSABLE_MONGO: 'true' }).ok, false);
  assert.equal(validateMongoIntegrationEnvironment({ MONGO_TEST_URI: 'mongodb://localhost:27017/production', BETGO_CONFIRM_DISPOSABLE_MONGO: 'true' }).ok, false);
});

test('integration runner requires disposable-server confirmation', () => {
  const result = validateMongoIntegrationEnvironment({ MONGO_TEST_URI: validUri });
  assert.equal(result.ok, false);
  assert.match(result.error, /dedicated to disposable tests/);
});

test('integration runner accepts explicitly confirmed test URI', () => {
  assert.deepEqual(validateMongoIntegrationEnvironment({ MONGO_TEST_URI: validUri, BETGO_CONFIRM_DISPOSABLE_MONGO: 'true' }), { ok: true });
});
