import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret, encryptSecret } from '../src/services/secret-vault.js';

test('secret vault encrypts and decrypts a session without storing plaintext', () => {
  const secret = 'test-session-secret-with-at-least-32-characters';
  const cookie = 'sid=abcdefghijklmnopqrstuvwxyz1234567890';
  const encrypted = encryptSecret(cookie, secret);
  assert.equal(decryptSecret(encrypted, secret), cookie);
  assert.equal(JSON.stringify(encrypted).includes(cookie), false);
  assert.throws(() => decryptSecret(encrypted, 'different-test-secret-that-is-also-long-enough'));
});

test('secret vault rejects malformed or multiline cookies', () => {
  assert.throws(() => encryptSecret('short', 'test-session-secret-with-at-least-32-characters'), /single line/);
  assert.throws(() => encryptSecret('sid=abc\nother=def', 'test-session-secret-with-at-least-32-characters'), /single line/);
});
