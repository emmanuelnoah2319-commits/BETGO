import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeRegex, manageBlock, publicUser } from '../src/services/user-admin.js';

test('regex metacharacters in a search are escaped', () => {
  assert.equal(escapeRegex('a.b+c(d)'), 'a\\.b\\+c\\(d\\)');
  assert.ok(new RegExp(escapeRegex('x+y@mail.com')).test('x+y@mail.com'));
  assert.equal(new RegExp(escapeRegex('a.c')).test('abc'), false);
});

test('owners and the acting user are protected', () => {
  const actor = { _id: 'o1', role: 'owner' };
  assert.equal(manageBlock(actor, null).code, 'USER_NOT_FOUND');
  assert.equal(manageBlock(actor, { _id: 'o2', role: 'owner' }).code, 'OWNER_PROTECTED');
  assert.equal(manageBlock({ _id: 'm1', role: 'member' }, { _id: 'm1', role: 'member' }).code, 'SELF_ACTION_BLOCKED');
  assert.equal(manageBlock(actor, { _id: 'm1', role: 'member' }), null);
});

test('the public user view never exposes secrets', () => {
  const view = publicUser({ _id: { toString: () => 'abc' }, email: 'a@b.c', role: 'member', passwordHash: 'x', authVersion: 3, disabledAt: new Date(), subscriptions: [{ bookmaker: 'SportyBet', expiresAt: new Date(Date.now() + 1e6) }] });
  assert.equal(view.disabled, true);
  assert.equal(view.subscriptions[0].active, true);
  assert.equal('passwordHash' in view, false);
  assert.equal('authVersion' in view, false);
});
