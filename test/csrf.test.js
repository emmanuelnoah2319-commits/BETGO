import test from 'node:test';
import assert from 'node:assert/strict';
import { createCsrfToken, safeEqual } from '../src/security/csrf.js';

test('CSRF tokens are random-looking and nonempty', () => {
  const a = createCsrfToken();
  const b = createCsrfToken();
  assert.ok(a.length >= 40);
  assert.notEqual(a, b);
});

test('constant-time comparison accepts equal values and rejects mismatches', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
});
