import { dueReminders } from './subscriptions.js';
import { writeAudit } from './audit.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildReminderEmail({ fullName, bookmaker, key, expiresAt, appOrigin, now = new Date() }) {
  const name = fullName || 'there';
  const date = new Date(expiresAt).toUTCString();
  if (key === 'expired') {
    return {
      subject: `Your BETGO ${bookmaker} subscription has expired`,
      text: `Hello ${name},\n\nYour BETGO ${bookmaker} subscription expired on ${date}.\n\nTo continue, sign in at ${appOrigin} and press "Renew ${bookmaker}" on your dashboard. If you can no longer sign in, submit a new application for ${bookmaker} from the sign-in page using this same email address.`
    };
  }
  const daysLeft = Math.max(1, Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS));
  return {
    subject: `Your BETGO ${bookmaker} subscription ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    text: `Hello ${name},\n\nYour BETGO ${bookmaker} subscription ends on ${date}.\n\nRenew any time before then: sign in at ${appOrigin} and press "Renew ${bookmaker}". Renewing early adds 30 days on top of the time you have left, so nothing is lost.`
  };
}

// Sends at most one reminder per subscription per stage. Each reminder is claimed in the database first, tied to the
// exact expiry it was claimed for, so overlapping runs and a renewal landing mid-run cannot cause duplicates or stale marks.
export async function runExpiryReminders(db, { appOrigin, sendEmail, now = new Date(), batchSize = 200 }) {
  const horizon = new Date(now.getTime() + 7 * DAY_MS);
  const earliest = new Date(now.getTime() - 3 * DAY_MS);
  const users = await db.collection('users').find({
    role: { $ne: 'owner' },
    subscriptions: { $elemMatch: { expiresAt: { $gt: earliest, $lte: horizon } } }
  }).limit(batchSize).toArray();
  const result = { checked: users.length, sent: 0, failed: 0, skipped: 0 };
  for (const user of users) {
    for (const reminder of dueReminders(user, now)) {
      const marks = Object.fromEntries(reminder.covers.map((key) => [`subscriptions.$.reminders.${key}`, now]));
      const claim = await db.collection('users').updateOne(
        { _id: user._id, subscriptions: { $elemMatch: { bookmaker: reminder.bookmaker, expiresAt: reminder.expiresAt, [`reminders.${reminder.key}`]: { $exists: false } } } },
        { $set: marks }
      );
      if (claim.modifiedCount !== 1) { result.skipped += 1; continue; }
      try {
        await sendEmail({ to: user.email, ...buildReminderEmail({ fullName: user.fullName, bookmaker: reminder.bookmaker, key: reminder.key, expiresAt: reminder.expiresAt, appOrigin, now }) });
        result.sent += 1;
        await writeAudit(db, { actorUserId: user._id, action: 'subscription.reminder_sent', requestId: 'expiry-reminders', details: { bookmaker: reminder.bookmaker, stage: reminder.key } });
      } catch (error) {
        // Release the claim so the next run retries.
        await db.collection('users').updateOne(
          { _id: user._id, 'subscriptions.bookmaker': reminder.bookmaker },
          { $unset: Object.fromEntries(reminder.covers.map((key) => [`subscriptions.$.reminders.${key}`, ''])) }
        );
        result.failed += 1;
        await writeAudit(db, { actorUserId: user._id, action: 'subscription.reminder_sent', outcome: 'email_failed', requestId: 'expiry-reminders', details: { bookmaker: reminder.bookmaker, stage: reminder.key, errorCode: error?.code || null } });
      }
    }
  }
  return result;
}

export function startExpiryReminderWorker(db, { appOrigin, sendEmail, intervalMs = 60 * 60 * 1000, logger = console, now = () => new Date() }) {
  if (!Number.isInteger(intervalMs) || intervalMs < 60_000) throw new TypeError('intervalMs must be at least 60000 milliseconds');
  let stopped = false; let running = false;
  const health = { worker: 'expiry-reminders', state: 'starting', lastRunAt: null, lastResult: null, lastError: null };
  async function tick() {
    if (stopped || running) return;
    running = true; health.state = 'running';
    try {
      health.lastResult = await runExpiryReminders(db, { appOrigin, sendEmail, now: now() });
      health.lastError = null;
      if (health.lastResult.sent || health.lastResult.failed) logger.info?.(JSON.stringify({ level: 'info', event: 'expiry_reminder_sweep', ...health.lastResult }));
    } catch (error) {
      health.lastError = error?.name || 'Error';
      logger.error?.(JSON.stringify({ level: 'error', event: 'expiry_reminder_failed', errorName: health.lastError }));
    } finally { health.lastRunAt = now(); health.state = stopped ? 'stopped' : 'idle'; running = false; }
  }
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  function stop() { stopped = true; clearInterval(timer); if (!running) health.state = 'stopped'; }
  stop.getStatus = () => ({ ...health, lastResult: health.lastResult ? { ...health.lastResult } : null });
  stop.runNow = tick;
  return stop;
}
