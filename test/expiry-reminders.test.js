import test from 'node:test';
import assert from 'node:assert/strict';
import { dueReminders, grantSubscription } from '../src/services/subscriptions.js';
import { buildReminderEmail, runExpiryReminders } from '../src/services/expiry-reminders.js';

const DAY = 86400000;
const now = new Date('2026-10-29T12:00:00Z');
const at = (days) => new Date(now.getTime() + days * DAY);
const member = (subscriptions, extra = {}) => ({ _id: 'u1', role: 'member', email: 'm@example.com', fullName: 'Ada', subscriptions, ...extra });

test('nothing is due outside the 7-day window or for owners and no-expiry subscriptions', () => {
  assert.deepEqual(dueReminders(member([{ bookmaker: 'SportyBet', expiresAt: at(20) }]), now), []);
  assert.deepEqual(dueReminders({ role: 'owner', subscriptions: [{ bookmaker: 'SportyBet', expiresAt: at(1) }] }, now), []);
  assert.deepEqual(dueReminders(member([{ bookmaker: 'SportyBet', expiresAt: null }]), now), []);
});

test('the most urgent stage is chosen and supersedes the earlier ones', () => {
  assert.equal(dueReminders(member([{ bookmaker: 'SportyBet', expiresAt: at(6) }]), now)[0].key, 'd7');
  const two = dueReminders(member([{ bookmaker: 'SportyBet', expiresAt: at(2.5) }]), now)[0];
  assert.equal(two.key, 'd3'); assert.deepEqual(two.covers, ['d7', 'd3']);
  const one = dueReminders(member([{ bookmaker: 'SportyBet', expiresAt: at(0.5) }]), now)[0];
  assert.equal(one.key, 'd1'); assert.deepEqual(one.covers, ['d7', 'd3', 'd1']);
});

test('a stage already sent is not repeated, and each bookmaker is tracked separately', () => {
  const user = member([{ bookmaker: 'SportyBet', expiresAt: at(2), reminders: { d3: now } }, { bookmaker: 'MSport', expiresAt: at(2) }]);
  const due = dueReminders(user, now);
  assert.deepEqual(due.map((item) => item.bookmaker), ['MSport']);
});

test('an expiry notice goes out only shortly after expiry, once', () => {
  assert.equal(dueReminders(member([{ bookmaker: 'SportyBet', expiresAt: at(-1) }]), now)[0].key, 'expired');
  assert.deepEqual(dueReminders(member([{ bookmaker: 'SportyBet', expiresAt: at(-10) }]), now), []);
  assert.deepEqual(dueReminders(member([{ bookmaker: 'SportyBet', expiresAt: at(-1), reminders: { expired: now } }]), now), []);
});

test('renewing starts a fresh reminder cycle', () => {
  const user = member([{ bookmaker: 'SportyBet', expiresAt: at(2), reminders: { d3: now } }]);
  const grant = grantSubscription(user, 'SportyBet', now);
  assert.deepEqual(grant.subscriptions[0].reminders, {});
});

test('email wording', () => {
  const soon = buildReminderEmail({ fullName: 'Ada', bookmaker: 'SportyBet', key: 'd1', expiresAt: at(0.5), appOrigin: 'https://x', now });
  assert.match(soon.subject, /ends in 1 day$/); assert.match(soon.text, /Renew SportyBet/);
  const gone = buildReminderEmail({ fullName: 'Ada', bookmaker: 'SportyBet', key: 'expired', expiresAt: at(-1), appOrigin: 'https://x', now });
  assert.match(gone.subject, /has expired/); assert.match(gone.text, /new application/);
});

// Fake that mirrors the claim semantics of the real filters: match one subscription element by bookmaker, exact expiry and absent marker.
function fakeDb(users) {
  const audits = [];
  return {
    users, audits,
    collection: (name) => name === 'auditEvents'
      ? { insertOne: async (doc) => { audits.push(doc); } }
      : {
        find: () => ({ limit: () => ({ toArray: async () => users.filter((u) => u.role !== 'owner') }) }),
        updateOne: async (filter, update) => {
          const user = users.find((u) => u._id === filter._id); if (!user) return { modifiedCount: 0 };
          const cond = filter.subscriptions?.$elemMatch;
          const element = cond
            ? user.subscriptions.find((s) => s.bookmaker === cond.bookmaker && new Date(s.expiresAt).getTime() === new Date(cond.expiresAt).getTime() && Object.entries(cond).filter(([k]) => k.startsWith('reminders.')).every(([k]) => !(s.reminders || {})[k.split('.')[1]]))
            : user.subscriptions.find((s) => s.bookmaker === filter['subscriptions.bookmaker']);
          if (!element) return { modifiedCount: 0 };
          for (const [path, value] of Object.entries(update.$set || {})) { element.reminders = element.reminders || {}; element.reminders[path.split('.').pop()] = value; }
          for (const path of Object.keys(update.$unset || {})) delete (element.reminders || {})[path.split('.').pop()];
          return { modifiedCount: 1 };
        }
      }
  };
}

test('a run sends one email per due stage and a second run sends nothing', async () => {
  const db = fakeDb([member([{ bookmaker: 'SportyBet', expiresAt: at(2) }, { bookmaker: 'MSport', expiresAt: at(20) }])]);
  const sent = [];
  const sendEmail = async (message) => { sent.push(message); };
  const first = await runExpiryReminders(db, { appOrigin: 'https://x', sendEmail, now });
  assert.equal(first.sent, 1); assert.equal(sent.length, 1); assert.match(sent[0].subject, /SportyBet/);
  const second = await runExpiryReminders(db, { appOrigin: 'https://x', sendEmail, now: new Date(now.getTime() + 3600_000) });
  assert.equal(second.sent, 0); assert.equal(sent.length, 1);
});

test('a failed send releases the claim so the next run retries', async () => {
  const db = fakeDb([member([{ bookmaker: 'SportyBet', expiresAt: at(2) }])]);
  const failed = await runExpiryReminders(db, { appOrigin: 'https://x', sendEmail: async () => { throw new Error('down'); }, now });
  assert.equal(failed.failed, 1);
  const sent = [];
  const retry = await runExpiryReminders(db, { appOrigin: 'https://x', sendEmail: async (m) => { sent.push(m); }, now: new Date(now.getTime() + 3600_000) });
  assert.equal(retry.sent, 1); assert.equal(sent.length, 1);
});
