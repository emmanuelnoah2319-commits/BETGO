import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { randomUUID, timingSafeEqual, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { z } from 'zod';
import { ObjectId } from 'mongodb';
import { createCsrfToken, csrfProtection } from './security/csrf.js';
import { login, revokeSession } from './services/auth.js';
import { requireAuth, requireOwner } from './middleware/auth.js';
import { writeAudit } from './services/audit.js';
import { listBookmakerIntegrations } from './integrations/bookmakers.js';
import { sportyBetDataClient } from './integrations/sportybet-data.js';
import { CANCELLABLE_INSTRUCTION_STATUSES, transitionInstructionStatus } from './services/instruction-lifecycle.js';
import { recoverPendingReservationReleases, releaseInstructionReservation } from './services/instruction-reservations.js';
import { getOperationalControl, setEmergencyStop } from './services/operational-control.js';
import { sendEmail } from './services/notifications.js';
import { initializeFlutterwavePayment, verifyFlutterwavePayment } from './services/payments.js';

const supportedPlatforms = ['SportyBet', 'Football.com Nigeria', 'BetWinner', 'Sokabet', 'MSport'];
const accountCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  platform: z.enum(supportedPlatforms),
  notes: z.string().trim().max(300).optional().default('')
}).strict();
const accountUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  notes: z.string().trim().max(300).optional(),
  enabledForNewActivity: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0);

const safetyPolicySchema = z.object({
  maxStakeMinor: z.number().int().min(100).max(100_000_000).optional(),
  dailyStakeLimitMinor: z.number().int().min(100).max(1_000_000_000).optional(),
  dailyLossLimitMinor: z.number().int().min(100).max(1_000_000_000).optional(),
  perAccountDailyStakeLimitMinor: z.number().int().min(100).max(1_000_000_000).optional(),
  maxOpenInstructions: z.number().int().min(1).max(100).optional()
}).strict().refine((value) => Object.keys(value).length > 0);
const emergencyStopSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(300),
  confirmation: z.string().optional()
}).strict().superRefine((value, ctx) => {
  if (value.enabled === false && value.confirmation !== 'I CONFIRM BETGO REMAINS NON-EXECUTING') {
    ctx.addIssue({ code: 'custom', path: ['confirmation'], message: 'Exact confirmation is required to clear the stop.' });
  }
});

const instructionCreateSchema = z.object({
  accountId: z.string().regex(/^[a-fA-F0-9]{24}$/),
  stakeMinor: z.number().int().min(100).max(100_000_000),
  selectionLabel: z.string().trim().min(1).max(160),
  eventLabel: z.string().trim().min(1).max(160),
  notes: z.string().trim().max(300).optional().default(''),
  idempotencyKey: z.string().uuid()
}).strict();

const DEFAULT_SAFETY_POLICY = Object.freeze({
  maxStakeMinor: 500_000,
  dailyStakeLimitMinor: 2_000_000,
  dailyLossLimitMinor: 1_000_000,
  perAccountDailyStakeLimitMinor: 750_000,
  maxOpenInstructions: 5
});


const applicationSchema = z.object({
  email: z.string().trim().email().max(254),
  bookmaker: z.enum(supportedPlatforms),
  fullName: z.string().trim().min(2).max(100)
}).strict();
const reviewSchema = z.object({ reason: z.string().trim().min(3).max(500).optional() }).strict();

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024)
}).strict();

const app = express();

app.disable('x-powered-by');
app.use((req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use('/api/payments/flutterwave/webhook', express.raw({ type: 'application/json', limit: '64kb' }));
app.use(express.json({ limit: '32kb', strict: true }));
app.use(cookieParser());
app.use(express.static(new URL('../public', import.meta.url).pathname, { index: 'index.html', fallthrough: true }));

app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));

app.get('/health/ready', async (req, res) => {
  try {
    await req.app.locals.db.command({ ping: 1 });
    res.json({ status: 'ready', database: 'connected', bettingEnabled: false });
  } catch {
    res.status(503).json({ status: 'not_ready', database: 'unavailable', bettingEnabled: false });
  }
});

app.get('/api/csrf', (_req, res) => {
  const token = createCsrfToken();
  res.cookie('betgo_csrf', token, {
    httpOnly: false,
    secure: reqSecureCookie(res),
    sameSite: 'strict',
    path: '/'
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ csrfToken: token });
});

function reqSecureCookie(res) {
  return Boolean(res.req.app.locals.config.cookieSecure);
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts; try again later.' } }
});

app.post('/api/auth/login', authLimiter, csrfProtection, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Provide a valid email and password.' } });
    const result = await login(req.app.locals.db, req.app.locals.config, { ...parsed.data, requestId: req.requestId });
    if (!result) return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' } });
    res.cookie(req.app.locals.config.cookieName, result.token, {
      httpOnly: true,
      secure: req.app.locals.config.cookieSecure,
      sameSite: 'strict',
      path: '/',
      expires: result.expiresAt
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ user: result.user, expiresAt: result.expiresAt });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', csrfProtection, requireAuthLazy, async (req, res, next) => {
  try {
    await revokeSession(req.app.locals.db, req.sessionId, req.user._id, req.requestId);
    res.clearCookie(req.app.locals.config.cookieName, {
      httpOnly: true, secure: req.app.locals.config.cookieSecure, sameSite: 'strict', path: '/'
    });
    res.status(204).end();
  } catch (error) { next(error); }
});

function requireAuthLazy(req, res, next) {
  return requireAuth(req.app.locals.db)(req, res, next);
}

app.get('/api/plans', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ plans: Object.entries(req.app.locals.config.bookmakerPricesNgn).map(([bookmaker, priceNgn]) => ({ bookmaker, priceNgn, durationDays: 30 })) });
});

app.post('/api/applications', authLimiter, csrfProtection, async (req, res, next) => {
  try {
    const parsed = applicationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Provide your name, a valid email and one bookmaker.' } });
    const db = req.app.locals.db;
    const email = parsed.data.email.trim();
    const emailNormalized = email.toLowerCase();
    const existingUser = await db.collection('users').findOne({ emailNormalized });
    if (existingUser) return res.status(409).json({ error: { code: 'ACCOUNT_EXISTS', message: 'An account already exists for this email.' } });
    const pending = await db.collection('applications').findOne({ emailNormalized, status: { $in: ['pending', 'approved_awaiting_payment'] } });
    if (pending) return res.status(409).json({ error: { code: 'APPLICATION_EXISTS', message: 'An application for this email is already being processed.' } });
    const now = new Date();
    const application = {
      fullName: parsed.data.fullName.trim(), email, emailNormalized, bookmaker: parsed.data.bookmaker,
      priceNgn: req.app.locals.config.bookmakerPricesNgn[parsed.data.bookmaker], status: 'pending',
      createdAt: now, updatedAt: now, reviewedAt: null, reviewedByUserId: null, rejectionReason: null
    };
    const result = await db.collection('applications').insertOne(application);
    await writeAudit(db, { action: 'application.submit', requestId: req.requestId, details: { applicationId: result.insertedId.toString(), bookmaker: application.bookmaker } });
    res.status(201).json({ message: 'Application received. BETGO will email you after review.', application: { id: result.insertedId.toString(), status: application.status } });
  } catch (error) { next(error); }
});

app.get('/api/admin/applications', requireAuthLazy, requireOwner, async (req, res) => {
  const applications = await req.app.locals.db.collection('applications').find({}).sort({ createdAt: -1 }).limit(200).toArray();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ applications: applications.map((item) => ({ id: item._id.toString(), fullName: item.fullName, email: item.email, bookmaker: item.bookmaker, priceNgn: item.priceNgn, status: item.status, createdAt: item.createdAt, rejectionReason: item.rejectionReason || null })) });
});

app.post('/api/admin/applications/:applicationId/reject', csrfProtection, requireAuthLazy, requireOwner, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.applicationId)) return res.status(400).json({ error: { code: 'INVALID_APPLICATION_ID', message: 'Application ID is invalid.' } });
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success || !parsed.data.reason) return res.status(400).json({ error: { code: 'REJECTION_REASON_REQUIRED', message: 'A clear rejection reason is required.' } });
    if (!req.app.locals.config.resendApiKey || !req.app.locals.config.emailFrom) return res.status(503).json({ error: { code: 'EMAIL_NOT_CONFIGURED', message: 'Customer email is not configured. Application was not changed.' } });
    const db = req.app.locals.db;
    const application = await db.collection('applications').findOneAndUpdate(
      { _id: new ObjectId(req.params.applicationId), status: 'pending' },
      { $set: { status: 'rejected', rejectionReason: parsed.data.reason, reviewedAt: new Date(), reviewedByUserId: req.user._id, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!application) return res.status(409).json({ error: { code: 'APPLICATION_NOT_PENDING', message: 'Application not found or already reviewed.' } });
    await sendEmail(req.app.locals.config, { to: application.email, subject: 'BETGO application update', text: `Hello ${application.fullName},\n\nYour BETGO application for ${application.bookmaker} was not approved.\n\nReason: ${parsed.data.reason}\n\nYou may contact BETGO support if you need clarification.` });
    await writeAudit(db, { actorUserId: req.user._id, action: 'application.reject', requestId: req.requestId, details: { applicationId: application._id.toString(), bookmaker: application.bookmaker } });
    res.json({ message: 'Application rejected and notification email sent.' });
  } catch (error) { next(error); }
});

app.post('/api/admin/applications/:applicationId/approve', csrfProtection, requireAuthLazy, requireOwner, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.applicationId)) return res.status(400).json({ error: { code: 'INVALID_APPLICATION_ID', message: 'Application ID is invalid.' } });
    if (!req.app.locals.config.resendApiKey || !req.app.locals.config.emailFrom) return res.status(503).json({ error: { code: 'EMAIL_NOT_CONFIGURED', message: 'Customer email is not configured. Application was not changed.' } });
    if (!req.app.locals.config.flutterwaveSecretKey) return res.status(503).json({ error: { code: 'PAYMENTS_NOT_CONFIGURED', message: 'Flutterwave is not configured. Application was not changed.' } });
    const db = req.app.locals.db;
    const application = await db.collection('applications').findOne({ _id: new ObjectId(req.params.applicationId), status: 'pending' });
    if (!application) return res.status(409).json({ error: { code: 'APPLICATION_NOT_PENDING', message: 'Application not found or already reviewed.' } });
    const reference = `betgo_${application._id.toString()}_${randomUUID().replaceAll('-', '')}`;
    const payment = await initializeFlutterwavePayment(req.app.locals.config, {
      email: application.email, fullName: application.fullName, amountNgn: application.priceNgn, reference,
      callbackUrl: req.app.locals.config.flutterwaveCallbackUrl,
      metadata: { applicationId: application._id.toString(), bookmaker: application.bookmaker, subscriptionDays: 30 }
    });
    const now = new Date();
    const updated = await db.collection('applications').findOneAndUpdate(
      { _id: application._id, status: 'pending' },
      { $set: { status: 'approved_awaiting_payment', reviewedAt: now, reviewedByUserId: req.user._id, paymentReference: reference, paymentUrl: payment.link, updatedAt: now } },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(409).json({ error: { code: 'APPLICATION_NOT_PENDING', message: 'Application was reviewed concurrently.' } });
    await db.collection('payments').insertOne({ applicationId: application._id, reference, amountNgn: application.priceNgn, status: 'pending', provider: 'flutterwave', createdAt: now, updatedAt: now });
    await sendEmail(req.app.locals.config, { to: application.email, subject: 'Your BETGO application is approved', text: `Hello ${application.fullName},\n\nYour application for ${application.bookmaker} has been approved.\n\nSubscription price: NGN ${application.priceNgn.toLocaleString('en-NG')} for 30 days.\nComplete payment securely using this Flutterwave link: ${payment.link}\n\nYour 30-day subscription starts only after Flutterwave confirms successful payment. Do not share your payment details with anyone.` });
    await writeAudit(db, { actorUserId: req.user._id, action: 'application.approve', requestId: req.requestId, details: { applicationId: application._id.toString(), bookmaker: application.bookmaker, amountNgn: application.priceNgn } });
    res.json({ message: 'Application approved; payment link created and email sent.', paymentUrl: payment.link });
  } catch (error) { next(error); }
});

app.post('/api/payments/flutterwave/webhook', async (req, res, next) => {
  try {
    const secret = req.app.locals.config.flutterwaveSecretHash;
    const signature = req.get('verif-hash') || '';
    if (!secret || !signature || !Buffer.isBuffer(req.body)) return res.status(401).json({ error: { code: 'INVALID_WEBHOOK', message: 'Webhook signature is required.' } });
    const expected = secret;
    const suppliedBuffer = Buffer.from(signature); const expectedBuffer = Buffer.from(expected);
    if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) return res.status(401).json({ error: { code: 'INVALID_WEBHOOK', message: 'Webhook signature is invalid.' } });
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event !== 'charge.completed' || event.data?.status !== 'successful' || !event.data?.id || !event.data?.tx_ref) return res.status(200).json({ received: true });
    const verified = await verifyFlutterwavePayment(req.app.locals.config, event.data.id);
    if (!verified) return res.status(200).json({ received: true, verified: false });
    const db = req.app.locals.db;
    const payment = await db.collection('payments').findOne({ reference: verified.tx_ref });
    if (!payment) return res.status(200).json({ received: true, alreadyProcessed: true });
    const application = await db.collection('applications').findOne({ _id: payment.applicationId });
    if (!application || Number(verified.amount) !== Number(payment.amountNgn) || verified.currency !== 'NGN' || verified.customer?.email?.trim().toLowerCase() !== application.emailNormalized) return res.status(200).json({ received: true, verified: false });
    const emailNormalized = application.emailNormalized;
    let user = await db.collection('users').findOne({ emailNormalized });
    let now = new Date();
    let subscriptionExpiresAt;
    if (payment.status === 'paid') {
      if (!user || user.mustChangePassword !== true) return res.status(200).json({ received: true, alreadyProcessed: true });
      // Retry delivery after a transient email-provider failure without extending the paid subscription.
      const temporaryPassword = randomBytes(18).toString('base64url');
      await db.collection('users').updateOne({ _id: user._id, mustChangePassword: true }, { $set: { passwordHash: await argon2.hash(temporaryPassword, { type: argon2.argon2id }), temporaryPasswordIssuedAt: now } });
      subscriptionExpiresAt = user.subscriptionExpiresAt;
      await sendEmail(req.app.locals.config, { to: application.email, subject: 'BETGO temporary login details', text: `Hello ${application.fullName},\n\nUsername: ${application.email}\nTemporary password: ${temporaryPassword}\nSubscription expires: ${new Date(subscriptionExpiresAt).toISOString()}\n\nSign in at ${req.app.locals.config.appOrigin} and change this temporary password immediately.` });
      return res.status(200).json({ received: true, credentialEmailRetried: true });
    }
    if (payment.status !== 'pending' || application.status !== 'approved_awaiting_payment') return res.status(200).json({ received: true, alreadyProcessed: true });
    if (user) return res.status(200).json({ received: true, accountExists: true });
    const temporaryPassword = randomBytes(18).toString('base64url');
    subscriptionExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const passwordHash = await argon2.hash(temporaryPassword, { type: argon2.argon2id });
    const userResult = await db.collection('users').insertOne({ email: application.email, emailNormalized, fullName: application.fullName, passwordHash, role: 'member', bookmaker: application.bookmaker, createdAt: now, disabledAt: null, authVersion: 1, subscriptionStartedAt: now, subscriptionExpiresAt, mustChangePassword: true, temporaryPasswordIssuedAt: now, applicationId: application._id });
    await db.collection('payments').updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'paid', paidAt: now, flutterwaveTransactionId: verified.id, updatedAt: now, userId: userResult.insertedId } });
    await db.collection('applications').updateOne({ _id: application._id, status: 'approved_awaiting_payment' }, { $set: { status: 'active', paidAt: now, subscriptionExpiresAt, userId: userResult.insertedId, updatedAt: now } });
    await sendEmail(req.app.locals.config, { to: application.email, subject: 'BETGO payment confirmed — temporary login', text: `Hello ${application.fullName},\n\nYour payment of NGN ${payment.amountNgn.toLocaleString('en-NG')} is confirmed. Your ${application.bookmaker} subscription is active until ${subscriptionExpiresAt.toISOString()}.\n\nUsername: ${application.email}\nTemporary password: ${temporaryPassword}\n\nSign in at ${req.app.locals.config.appOrigin}. Change this temporary password immediately and do not share it. Your subscription expires 30 days after payment confirmation.` });
    await writeAudit(db, { action: 'payment.activate_subscription', requestId: req.requestId, details: { applicationId: application._id.toString(), userId: userResult.insertedId.toString(), amountNgn: payment.amountNgn } });
    res.json({ received: true, activated: true });
  } catch (error) { next(error); }
});

app.post('/api/me/password', csrfProtection, requireAuthLazy, async (req, res, next) => {
  try {
    const parsed = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(12).max(1024) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Provide your temporary password and a new password of at least 12 characters.' } });
    const db = req.app.locals.db;
    const user = await db.collection('users').findOne({ _id: req.user._id });
    if (!user || !(await argon2.verify(user.passwordHash, parsed.data.currentPassword).catch(() => false))) return res.status(401).json({ error: { code: 'INVALID_PASSWORD', message: 'Current password is incorrect.' } });
    await db.collection('users').updateOne({ _id: user._id }, { $set: { passwordHash: await argon2.hash(parsed.data.newPassword, { type: argon2.argon2id }), mustChangePassword: false, passwordChangedAt: new Date() }, $inc: { authVersion: 1 } });
    await db.collection('sessions').updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    res.clearCookie(req.app.locals.config.cookieName, { httpOnly: true, secure: req.app.locals.config.cookieSecure, sameSite: 'strict', path: '/' });
    await writeAudit(db, { actorUserId: user._id, action: 'auth.password_change', requestId: req.requestId });
    res.json({ message: 'Password changed. Sign in again.' });
  } catch (error) { next(error); }
});

app.get('/api/me', requireAuthLazy, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ user: { id: req.user._id.toString(), email: req.user.email, fullName: req.user.fullName || '', role: req.user.role, bookmaker: req.user.bookmaker || null, mustChangePassword: req.user.mustChangePassword === true, subscriptionStartedAt: req.user.subscriptionStartedAt || null, subscriptionExpiresAt: req.user.subscriptionExpiresAt || null } });
});

app.get('/api/admin/operations', requireAuthLazy, requireOwner, async (req, res) => {
  const db = req.app.locals.db;
  const statuses = ['queued', 'submitting', 'accepted', 'rejected', 'unknown', 'cancelled'];
  const submissionCounts = {};
  await Promise.all(statuses.map(async (status) => {
    submissionCounts[status] = await db.collection('betSubmissions').countDocuments({ status });
  }));
  const control = await getOperationalControl(db);
  const worker = req.app.locals.getSubmissionRecoveryWorkerStatus?.() ?? {
    worker: 'submission-recovery', state: 'not_started', mode: 'recovery-only'
  };
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    operations: {
      emergencyStop: control,
      executionEnabled: false,
      bookmakerRequestsEnabled: false,
      worker,
      submissionCounts,
      alerts: [
        ...(worker.consecutiveFailures >= 3 ? ['SUBMISSION_RECOVERY_REPEATED_FAILURES'] : []),
        ...(submissionCounts.unknown > 0 ? ['SUBMISSIONS_REQUIRE_RECONCILIATION'] : []),
        ...(control.emergencyStop ? ['EMERGENCY_STOP_ACTIVE'] : [])
      ]
    }
  });
});

app.patch('/api/admin/emergency-stop', csrfProtection, requireAuthLazy, requireOwner, async (req, res, next) => {
  try {
    const parsed = emergencyStopSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Provide enabled, a reason, and the exact confirmation when clearing the stop.' } });
    const control = await setEmergencyStop(req.app.locals.db, {
      enabled: parsed.data.enabled,
      reason: parsed.data.reason,
      actorUserId: req.user._id
    });
    await writeAudit(req.app.locals.db, {
      actorUserId: req.user._id,
      action: parsed.data.enabled ? 'operations.emergency_stop.enable' : 'operations.emergency_stop.clear',
      requestId: req.requestId,
      details: { emergencyStop: control.emergencyStop, reason: control.reason }
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ emergencyStop: control, executionEnabled: false, bookmakerRequestsEnabled: false });
  } catch (error) { next(error); }
});

app.get('/api/admin/status', requireAuthLazy, requireOwner, async (req, res) => {
  const accountCount = await req.app.locals.db.collection('bettingAccounts').countDocuments({ ownerUserId: req.user._id });
  res.json({
    company: 'BETGO',
    accountCount,
    bookmakerIntegrations: {
      enabled: false,
      reason: 'No official API or partner authorization has been verified.'
    },
    automaticBetting: false
  });
});

app.get('/api/accounts', requireAuthLazy, async (req, res) => {
  const accountFilter = { ownerUserId: req.user._id };
  if (req.user.role !== 'owner' && req.user.bookmaker) accountFilter.platform = req.user.bookmaker;
  const accounts = await req.app.locals.db.collection('bettingAccounts')
    .find(accountFilter)
    .sort({ createdAt: -1 }).limit(200).toArray();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ accounts: accounts.map(publicAccount) });
});

app.post('/api/accounts', csrfProtection, requireAuthLazy, async (req, res, next) => {
  try {
    const parsed = accountCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Provide a valid display name, supported platform and optional notes.' } });
    if (req.user.role !== 'owner' && parsed.data.platform !== req.user.bookmaker) {
      return res.status(403).json({ error: { code: 'BOOKMAKER_NOT_IN_SUBSCRIPTION', message: 'Your subscription only includes the bookmaker selected when you applied.' } });
    }
    const now = new Date();
    const account = {
      ownerUserId: req.user._id,
      displayName: parsed.data.displayName,
      displayNameNormalized: parsed.data.displayName.toLocaleLowerCase('en-US'),
      platform: parsed.data.platform,
      notes: parsed.data.notes,
      connectionStatus: 'not_connected',
      capabilities: [],
      lastSuccessfulSyncAt: null,
      balanceMinor: null,
      currency: null,
      enabledForNewActivity: false,
      integrationAuthorized: false,
      createdAt: now,
      updatedAt: now
    };
    const result = await req.app.locals.db.collection('bettingAccounts').insertOne(account);
    await writeAudit(req.app.locals.db, {
      actorUserId: req.user._id, action: 'account.create', requestId: req.requestId,
      details: { accountId: result.insertedId.toString(), platform: account.platform }
    });
    res.status(201).json({ account: publicAccount({ ...account, _id: result.insertedId }) });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: { code: 'ACCOUNT_EXISTS', message: 'An account with this name already exists for this platform.' } });
    next(error);
  }
});

app.patch('/api/accounts/:accountId', csrfProtection, requireAuthLazy, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.accountId)) return res.status(400).json({ error: { code: 'INVALID_ACCOUNT_ID', message: 'Account ID is invalid.' } });
    const parsed = accountUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Provide valid account fields.' } });
    const update = { ...parsed.data, updatedAt: new Date() };
    if (update.displayName !== undefined) update.displayNameNormalized = update.displayName.toLocaleLowerCase('en-US');
    // Enabling new activity cannot override the integration authorization gate.
    if (update.enabledForNewActivity === true) {
      const existing = await req.app.locals.db.collection('bettingAccounts').findOne({
        _id: new ObjectId(req.params.accountId), ownerUserId: req.user._id
      });
      if (!existing) return res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' } });
      return res.status(409).json({ error: { code: 'INTEGRATION_NOT_AUTHORIZED', message: 'This account cannot be enabled until an approved integration is verified.' } });
    }
    const updateFilter = { _id: new ObjectId(req.params.accountId), ownerUserId: req.user._id };
    if (req.user.role !== 'owner' && req.user.bookmaker) updateFilter.platform = req.user.bookmaker;
    const result = await req.app.locals.db.collection('bettingAccounts').findOneAndUpdate(
      updateFilter,
      { $set: update }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' } });
    await writeAudit(req.app.locals.db, {
      actorUserId: req.user._id, action: 'account.update', requestId: req.requestId,
      details: { accountId: req.params.accountId, fields: Object.keys(parsed.data) }
    });
    res.json({ account: publicAccount(result) });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: { code: 'ACCOUNT_EXISTS', message: 'An account with this name already exists for this platform.' } });
    next(error);
  }
});

function publicAccount(account) {
  return {
    id: account._id.toString(),
    displayName: account.displayName,
    platform: account.platform,
    notes: account.notes || '',
    connectionStatus: account.connectionStatus,
    capabilities: account.capabilities || [],
    lastSuccessfulSyncAt: account.lastSuccessfulSyncAt || null,
    balanceMinor: account.balanceMinor ?? null,
    currency: account.currency ?? null,
    enabledForNewActivity: account.enabledForNewActivity === true,
    integrationAuthorized: account.integrationAuthorized === true,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

app.get('/api/audit/recent', requireAuthLazy, requireOwner, async (req, res) => {
  const events = await req.app.locals.db.collection('auditEvents')
    .find({ actorUserId: req.user._id })
    .sort({ createdAt: -1 }).limit(50).toArray();
  res.json({ events: events.map(({ _id, actorUserId, action, outcome, requestId, details, createdAt }) => ({
    id: _id, actorUserId, action, outcome, requestId, details, createdAt
  })) });
});

app.get('/api/safety-policy', requireAuthLazy, async (req, res) => {
  const saved = await req.app.locals.db.collection('safetyPolicies').findOne({ ownerUserId: req.user._id });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ policy: publicSafetyPolicy(saved), currency: 'NGN', amountUnit: 'kobo' });
});

app.patch('/api/safety-policy', csrfProtection, requireAuthLazy, async (req, res, next) => {
  try {
    const parsed = safetyPolicySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Limits must be positive integer amounts in kobo.' } });
    const db = req.app.locals.db;
    const saved = await db.collection('safetyPolicies').findOne({ ownerUserId: req.user._id });
    const policy = { ...DEFAULT_SAFETY_POLICY, ...publicSafetyPolicy(saved), ...parsed.data, ownerUserId: req.user._id, updatedAt: new Date() };
    if (policy.maxStakeMinor > policy.dailyStakeLimitMinor || policy.perAccountDailyStakeLimitMinor > policy.dailyStakeLimitMinor) {
      return res.status(400).json({ error: { code: 'INCONSISTENT_LIMITS', message: 'Maximum stake and per-account daily limit cannot exceed the global daily stake limit.' } });
    }
    await db.collection('safetyPolicies').updateOne({ ownerUserId: req.user._id }, { $set: policy, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    await writeAudit(db, { actorUserId: req.user._id, action: 'safety_policy.update', requestId: req.requestId, details: { fields: Object.keys(parsed.data) } });
    res.json({ policy: publicSafetyPolicy(policy), currency: 'NGN', amountUnit: 'kobo' });
  } catch (error) { next(error); }
});

function publicSafetyPolicy(saved) {
  const policy = { ...DEFAULT_SAFETY_POLICY };
  if (saved) for (const key of Object.keys(DEFAULT_SAFETY_POLICY)) if (Number.isInteger(saved[key])) policy[key] = saved[key];
  return policy;
}

app.get('/api/bet-instructions', requireAuthLazy, async (req, res) => {
  const instructions = await req.app.locals.db.collection('betInstructions').find({ ownerUserId: req.user._id }).sort({ createdAt: -1 }).limit(100).toArray();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ instructions: instructions.map(publicInstruction) });
});

app.post('/api/bet-instructions', csrfProtection, requireAuthLazy, async (req, res, next) => {
  let reservation = null;
  let openSlotReserved = false;
  try {
    const parsed = instructionCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Provide an account, event, selection, stake in kobo and UUID idempotency key.' } });
    const db = req.app.locals.db;
    const input = parsed.data;
    const prior = await db.collection('betInstructions').findOne({ ownerUserId: req.user._id, idempotencyKey: input.idempotencyKey });
    if (prior) return res.status(200).json({ instruction: publicInstruction(prior), replayed: true });
    const accountId = new ObjectId(input.accountId);
    const account = await db.collection('bettingAccounts').findOne({ _id: accountId, ownerUserId: req.user._id });
    if (!account) return res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'Account record not found.' } });
    if (req.user.role !== 'owner' && account.platform !== req.user.bookmaker) return res.status(403).json({ error: { code: 'BOOKMAKER_NOT_IN_SUBSCRIPTION', message: 'This account is outside your subscribed bookmaker.' } });
    const policies = db.collection('safetyPolicies');
    await policies.updateOne({ ownerUserId: req.user._id }, { $setOnInsert: { ...DEFAULT_SAFETY_POLICY, ownerUserId: req.user._id, openInstructionCount: 0, createdAt: new Date() } }, { upsert: true });
    await policies.updateOne({ ownerUserId: req.user._id, openInstructionCount: { $exists: false } }, { $set: { openInstructionCount: 0 } });
    const saved = await policies.findOne({ ownerUserId: req.user._id });
    const policy = publicSafetyPolicy(saved);
    if (input.stakeMinor > policy.maxStakeMinor) return res.status(409).json({ error: { code: 'STAKE_LIMIT_EXCEEDED', message: 'Stake exceeds the configured maximum per instruction.' } });
    const slot = await policies.findOneAndUpdate({ ownerUserId: req.user._id, openInstructionCount: { $lt: policy.maxOpenInstructions } }, { $inc: { openInstructionCount: 1 }, $set: { updatedAt: new Date() } }, { returnDocument: 'after' });
    if (!slot) return res.status(409).json({ error: { code: 'OPEN_INSTRUCTION_LIMIT', message: 'Maximum open instructions reached.' } });
    openSlotReserved = true;
    const day = new Date().toISOString().slice(0, 10);
    const spend = db.collection('dailySpend');
    await spend.updateOne({ ownerUserId: req.user._id, day }, { $setOnInsert: { ownerUserId: req.user._id, day, reservedStakeMinor: 0, settledLossMinor: 0, accountReservedStakeMinor: {}, createdAt: new Date() } }, { upsert: true });
    const accountField = `accountReservedStakeMinor.${accountId.toString()}`;
    const reserved = await spend.findOneAndUpdate({ ownerUserId: req.user._id, day, $expr: { $and: [
      { $lte: [{ $add: [{ $ifNull: ['$reservedStakeMinor', 0] }, input.stakeMinor] }, policy.dailyStakeLimitMinor] },
      { $lte: [{ $add: [{ $ifNull: ['$settledLossMinor', 0] }, { $ifNull: ['$reservedStakeMinor', 0] }, input.stakeMinor] }, policy.dailyLossLimitMinor] },
      { $lte: [{ $add: [{ $ifNull: [`$${accountField}`, 0] }, input.stakeMinor] }, policy.perAccountDailyStakeLimitMinor] }
    ] } }, { $inc: { reservedStakeMinor: input.stakeMinor, [accountField]: input.stakeMinor }, $set: { updatedAt: new Date() } }, { returnDocument: 'after' });
    if (!reserved) {
      await db.collection('safetyPolicies').updateOne({ ownerUserId: req.user._id, openInstructionCount: { $gt: 0 } }, { $inc: { openInstructionCount: -1 }, $set: { updatedAt: new Date() } });
      openSlotReserved = false;
      return res.status(409).json({ error: { code: 'DAILY_LIMIT_EXCEEDED', message: 'Global stake, conservative loss-exposure or per-account daily limit would be exceeded.' } });
    }
    reservation = { ownerUserId: req.user._id, day, accountField, stakeMinor: input.stakeMinor };
    const now = new Date();
    const instruction = { ownerUserId: req.user._id, accountId, accountLabel: account.displayName, platform: account.platform, eventLabel: input.eventLabel, selectionLabel: input.selectionLabel, notes: input.notes, stakeMinor: input.stakeMinor, currency: 'NGN', status: 'awaiting_approval', idempotencyKey: input.idempotencyKey, reservationDay: day, reservationActive: true, submissionEnabled: false, createdAt: now, updatedAt: now };
    const inserted = await db.collection('betInstructions').insertOne(instruction);
    reservation = null;
    openSlotReserved = false;
    await writeAudit(db, { actorUserId: req.user._id, action: 'bet_instruction.create', requestId: req.requestId, details: { instructionId: inserted.insertedId.toString(), accountId: accountId.toString(), stakeMinor: input.stakeMinor, status: instruction.status } });
    res.status(201).json({ instruction: publicInstruction({ ...instruction, _id: inserted.insertedId }) });
  } catch (error) {
    if (reservation) await req.app.locals.db.collection('dailySpend').updateOne({ ownerUserId: reservation.ownerUserId, day: reservation.day }, { $inc: { reservedStakeMinor: -reservation.stakeMinor, [reservation.accountField]: -reservation.stakeMinor }, $set: { updatedAt: new Date() } }).catch(() => {});
    if (openSlotReserved) await req.app.locals.db.collection('safetyPolicies').updateOne({ ownerUserId: req.user._id, openInstructionCount: { $gt: 0 } }, { $inc: { openInstructionCount: -1 }, $set: { updatedAt: new Date() } }).catch(() => {});
    if (error?.code === 11000) {
      const prior = await req.app.locals.db.collection('betInstructions').findOne({ ownerUserId: req.user._id, idempotencyKey: req.body?.idempotencyKey });
      if (prior) return res.status(200).json({ instruction: publicInstruction(prior), replayed: true });
    }
    next(error);
  }
});

app.post('/api/bet-instructions/:instructionId/approve', csrfProtection, requireAuthLazy, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.instructionId)) return res.status(400).json({ error: { code: 'INVALID_INSTRUCTION_ID', message: 'Instruction ID is invalid.' } });
    const db = req.app.locals.db;
    const instruction = await db.collection('betInstructions').findOneAndUpdate(
      { _id: new ObjectId(req.params.instructionId), ownerUserId: req.user._id, status: 'awaiting_approval', reservationActive: true },
      { $set: { status: transitionInstructionStatus('awaiting_approval', 'approve'), approvedAt: new Date(), approvedByUserId: req.user._id, updatedAt: new Date(), submissionEnabled: false } },
      { returnDocument: 'after' }
    );
    if (!instruction) return res.status(409).json({ error: { code: 'NOT_REVIEWABLE', message: 'Instruction was not found or is no longer awaiting approval.' } });
    await writeAudit(db, { actorUserId: req.user._id, action: 'bet_instruction.approve', requestId: req.requestId, details: { instructionId: instruction._id.toString(), status: instruction.status, submissionEnabled: false } });
    res.json({ instruction: publicInstruction(instruction), submissionEnabled: false, message: 'Approved for the next workflow stage only. No bookmaker request was sent.' });
  } catch (error) { next(error); }
});

app.post('/api/bet-instructions/:instructionId/cancel', csrfProtection, requireAuthLazy, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.instructionId)) return res.status(400).json({ error: { code: 'INVALID_INSTRUCTION_ID', message: 'Instruction ID is invalid.' } });
    const db = req.app.locals.db;
    const instruction = await db.collection('betInstructions').findOneAndUpdate({ _id: new ObjectId(req.params.instructionId), ownerUserId: req.user._id, status: { $in: CANCELLABLE_INSTRUCTION_STATUSES }, reservationActive: true }, { $set: { status: 'cancelled', reservationActive: false, reservationReleaseState: 'pending', updatedAt: new Date(), cancelledAt: new Date() } }, { returnDocument: 'after' });
    if (!instruction) return res.status(409).json({ error: { code: 'NOT_CANCELLABLE', message: 'Instruction was not found or is no longer cancellable.' } });
    await releaseInstructionReservation(db, instruction);
    await writeAudit(db, { actorUserId: req.user._id, action: 'bet_instruction.cancel', requestId: req.requestId, details: { instructionId: instruction._id.toString() } });
    res.json({ instruction: publicInstruction({ ...instruction, reservationReleaseState: 'released' }), submissionEnabled: false });
  } catch (error) { next(error); }
});

app.post('/api/bet-instructions/:instructionId/reject', csrfProtection, requireAuthLazy, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.instructionId)) return res.status(400).json({ error: { code: 'INVALID_INSTRUCTION_ID', message: 'Instruction ID is invalid.' } });
    const db = req.app.locals.db;
    const instruction = await db.collection('betInstructions').findOneAndUpdate({
      _id: new ObjectId(req.params.instructionId), ownerUserId: req.user._id,
      status: { $in: ['awaiting_approval', 'approved_not_submitted'] }, reservationActive: true
    }, { $set: { status: 'rejected', reservationActive: false, reservationReleaseState: 'pending', rejectedAt: new Date(), rejectedByUserId: req.user._id, updatedAt: new Date(), submissionEnabled: false } }, { returnDocument: 'after' });
    if (!instruction) return res.status(409).json({ error: { code: 'NOT_REJECTABLE', message: 'Instruction was not found or cannot be rejected in its current state.' } });
    await releaseInstructionReservation(db, instruction);
    await writeAudit(db, { actorUserId: req.user._id, action: 'bet_instruction.reject', requestId: req.requestId, details: { instructionId: instruction._id.toString(), status: 'rejected' } });
    res.json({ instruction: publicInstruction({ ...instruction, reservationReleaseState: 'released' }), submissionEnabled: false });
  } catch (error) { next(error); }
});

app.post('/api/admin/recover-reservations', csrfProtection, requireAuthLazy, requireOwner, async (req, res, next) => {
  try {
    const result = await recoverPendingReservationReleases(req.app.locals.db);
    await writeAudit(req.app.locals.db, { actorUserId: req.user._id, action: 'reservations.recover', requestId: req.requestId, details: result });
    res.json({ recovery: result, message: 'Only cancelled/rejected instructions with pending reservation releases were processed.' });
  } catch (error) { next(error); }
});

function publicInstruction(instruction) {
  return { id: instruction._id.toString(), accountId: instruction.accountId.toString(), accountLabel: instruction.accountLabel, platform: instruction.platform, eventLabel: instruction.eventLabel, selectionLabel: instruction.selectionLabel, notes: instruction.notes || '', stakeMinor: instruction.stakeMinor, currency: instruction.currency, status: instruction.status, reservationReleaseState: instruction.reservationReleaseState || (instruction.reservationActive ? 'active' : 'not_applicable'), submissionEnabled: false, createdAt: instruction.createdAt, updatedAt: instruction.updatedAt };
}

app.get('/api/integrations', requireAuthLazy, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ integrations: listBookmakerIntegrations() });
});

// Read-only SportyBet public web-data adapter. This does not authenticate an account or place wagers.
app.get('/api/sportybet/fixtures', requireAuthLazy, async (req, res) => {
  try {
    const limit = req.query.limit === undefined ? 30 : Number(req.query.limit);
    const timeline = req.query.timeline === undefined ? 168 : Number(req.query.timeline);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(timeline) || timeline < 1 || timeline > 720) {
      return res.status(400).json({ error: { code: 'INVALID_QUERY', message: 'limit must be 1–100 and timeline must be 1–720 hours.' } });
    }
    const data = await sportyBetDataClient.getFixtures({ limit, timeline });
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (error) {
    res.status(error.status || 502).json({ error: { code: error.code || 'SPORTYBET_UNAVAILABLE', message: error.message || 'SportyBet data is temporarily unavailable.' } });
  }
});

app.get('/api/sportybet/events/:eventId/markets', requireAuthLazy, async (req, res) => {
  try {
    const data = await sportyBetDataClient.getMarkets(req.params.eventId);
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (error) {
    res.status(error.status || 502).json({ error: { code: error.code || 'SPORTYBET_UNAVAILABLE', message: error.message || 'SportyBet markets are temporarily unavailable.' } });
  }
});

app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.requestId } }));

app.use((error, req, res, _next) => {
  console.error(JSON.stringify({
    level: 'error',
    requestId: req.requestId,
    errorName: error?.name || 'Error',
    message: req.app.locals.config?.nodeEnv === 'production' ? 'Request failed' : String(error?.message || error)
  }));
  if (res.headersSent) return;
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId: req.requestId } });
});

export default app;
