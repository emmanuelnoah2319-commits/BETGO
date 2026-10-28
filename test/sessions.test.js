import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken, hashToken } from '../src/security/sessions.js';

test('session tokens are unique and only hashes are stored', () => {
  const first = createSessionToken();
  const second = createSessionToken();
  assert.notEqual(first, second);
  assert.equal(hashToken(first).length, 64);
  assert.notEqual(hashToken(first), first);
});
