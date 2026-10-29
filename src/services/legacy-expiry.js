import { writeAudit } from './audit.js';
import { SUBSCRIPTION_DAYS, latestExpiry, subscriptionsOf } from './subscriptions.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const LEGACY_GRACE_DAYS = 7;

// Members created before the 30-day rule can have a subscription with no expiry. Rather than lock them out the moment
// the rule is enforced, each such subscription gets a normal 30-day period counted from its start (or the account's
// creation), and never less than a short grace window from now so they can renew.
export function legacyBackfillPlan(user, now = new Date()) {
  if (!user || user.role !== 'member') return null;
  const subs = subscriptionsOf(user);
  if (!subs.some((item) => !item.expiresAt)) return null;
  const floor = now.getTime() + LEGACY_GRACE_DAYS * DAY_MS;
  const fixed = subs.map((item) => {
    if (item.expiresAt) return { ...item };
    const start = new Date(item.startedAt || user.createdAt || now);
    const natural = (Number.isNaN(start.getTime()) ? now : start).getTime() + SUBSCRIPTION_DAYS * DAY_MS;
    return { ...item, startedAt: item.startedAt || start, expiresAt: new Date(Math.max(natural, floor)) };
  });
  return { subscriptions: fixed, subscriptionExpiresAt: latestExpiry({ subscriptions: fixed }) };
}

// Idempotent: a user that already has expiry dates is skipped, and the write is guarded by subVersion so it cannot
// overwrite a payment that is being applied at the same moment (that user is simply picked up on the next start).
export async function backfillLegacyExpiry(db, { now = new Date(), requestId } = {}) {
  const members = await db.collection('users').find({ role: 'member' }).toArray();
  let updated = 0; let skipped = 0;
  for (const user of members) {
    const plan = legacyBackfillPlan(user, now);
    if (!plan) continue;
    const result = await db.collection('users').updateOne(
      { _id: user._id, subVersion: user.subVersion ?? null },
      { $set: { subscriptions: plan.subscriptions, subscriptionExpiresAt: plan.subscriptionExpiresAt, updatedAt: now }, $inc: { subVersion: 1 } }
    );
    if (result.matchedCount === 1) {
      updated += 1;
      await writeAudit(db, { action: 'subscription.legacy_expiry_backfill', requestId, details: { userId: user._id.toString(), subscriptionExpiresAt: plan.subscriptionExpiresAt?.toISOString?.() ?? null } });
    } else skipped += 1;
  }
  return { checked: members.length, updated, skipped };
}
