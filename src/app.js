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
import { getBookmakerConnector, listBookmakerIntegrations } from './integrations/bookmakers.js';
import { applyConnectorCheck, connectionUpdate } from './services/account-connection.js';
import { sportyBetDataClient } from './integrations/sportybet-data.js';
import { CANCELLABLE_INSTRUCTION_STATUSES, transitionInstructionStatus } from './services/instruction-lifecycle.js';
import { recoverPendingReservationReleases, releaseInstructionReservation } from './services/instruction-reservations.js';
import { getOperationalControl, setEmergencyStop } from './services/operational-control.js';
import { sendEmail } from './services/notifications.js';
import { escapeRegex, manageBlock, publicUser } from './services/user-admin.js';
import { MIN_PASSWORD_LENGTH, completePasswordReset, requestPasswordReset } from './services/password-reset.js';
import { initializeFlutterwavePayment, verifyFlutterwavePayment } from './services/payments.js';
import { capStakeToNetProfit } from './services/profit-cap.js';
import { OPEN_APPLICATION_STATUSES, allowedBookmakers, applicationBlock, canUseBookmaker, grantSubscription, hasSubscriptionRecord, latestExpiry, publicSubscriptions, subscriptionsOf } from './services/subscriptions.js';

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
  oddsDecimal: z.number().finite().gt(1).max(1000).optional(),
  eventId: z.string().regex(/^sr:match:\d+$/).optional(),
  marketId: z.string().min(1).max(40).optional(),
  outcomeId: z.string().min(1).max(40).optional(),
  maxNetProfitMinor: z.number().int().min(100).max(1_000_000_000).optional(),
  idempotencyKey: z.string().uuid()
}).strict().superRefine((value, ctx) => {
  const providerFields = [value.eventId, value.marketId, value.outcomeId];
  if (providerFields.some((field) => field !== undefined) && providerFields.some((field) => field === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['eventId'], message: 'Event, market and outcome identifiers must be provided together.' });
  }
  if ((value.oddsDecimal === undefined) !== (value.maxNetProfitMinor === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['oddsDecimal'], message: 'Odds and maximum net profit must be provided together.' });
  }
  if (value.eventId && value.oddsDecimal === undefined) {
    ctx.addIssue({ code: 'custom', path: ['oddsDecimal'], message: 'A selected bookmaker outcome requires its odds and maximum net-profit cap.' });
  }
});

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
const renewalSchema = z.object({ bookmaker: z.enum(supportedPlatforms) }).strict();
const reviewSchema = z.object({ reason: z.string().trim().min(3).max(500).optional() }).strict();

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024)
}).strict();

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\"', '&quot;').replaceAll("'", '&#39;');
}

const app = express();

// Render terminates TLS and forwards requests through one trusted proxy layer.
// Keep the hop count explicit; do not trust arbitrary client-supplied forwarding chains.
app.set('trust proxy', 1);
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

const forgotPasswordSchema = z.object({ email: z.string().trim().email().max(254) }).strict();
const resetPasswordSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(1024) }).strict();

// Same response whether or not the email has an account, so the form cannot be used to discover who is a member.
app.post('/api/auth/forgot-password', authLimiter, csrfProtection, async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid email address.' } });
  res.status(202).json({ message: 'If an account exists for that email, a reset link is on its way. It expires in 30 minutes.' });
  try {
    const config = req.app.locals.config;
    await requestPasswordReset(req.app.locals.db, { email: parsed.data.email, appOrigin: config.appOrigin, requestId: req.requestId, sendEmail: (message) => sendEmail(config, message) });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'password_reset_request_failed', requestId: req.requestId, errorCode: error?.code || null }));
  }
});

app.post('/api/auth/reset-password', authLimiter, csrfProtection, async (req, res, next) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `Choose a new password of at least ${MIN_PASSWORD_LENGTH} characters.` } });
    const result = await completePasswordReset(req.app.locals.db, { token: parsed.data.token, newPassword: parsed.data.newPassword, hashPassword: (value) => argon2.hash(value, { type: argon2.argon2id }), requestId: req.requestId });
    if (!result) return res.status(400).json({ error: { code: 'RESET_LINK_INVALID', message: 'This reset link is invalid, expired or already used. Request a new one.' } });
    res.clearCookie(req.app.locals.config.cookieName, { httpOnly: true, secure: req.app.locals.config.cookieSecure, sameSite: 'strict', path: '/' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ message: 'Password updated. Sign in with your new password.' });
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
    const pending = await db.collection('applications').findOne({ emailNormalized, bookmaker: parsed.data.bookmaker, status: { $in: OPEN_APPLICATION_STATUSES } });
    const block = applicationBlock({ user: existingUser, pending, bookmaker: parsed.data.bookmaker });
    if (block) return res.status(409).json({ error: block });
    const now = new Date();
    const application = {
      fullName: parsed.data.fullName.trim(), email, emailNormalized, bookmaker: parsed.data.bookmaker,
      priceNgn: req.app.locals.config.bookmakerPricesNgn[parsed.data.bookmaker], status: 'pending', type: existingUser ? 'add_bookmaker' : 'new',
      createdAt: now, updatedAt: now, reviewedAt: null, reviewedByUserId: null, rejectionReason: null
    };
    let result;
    try { result = await db.collection('applications').insertOne(application); }
    catch (insertError) {
      if (insertError?.code === 11000) return res.status(409).json({ error: { code: 'APPLICATION_EXISTS', message: 'An application for this email and bookmaker is already being processed.' } });
      throw insertError;
    }
    await writeAudit(db, { action: 'application.submit', requestId: req.requestId, details: { applicationId: result.insertedId.toString(), bookmaker: application.bookmaker } });
    res.status(201).json({ message: 'Application received. BETGO will email you after review.', application: { id: result.insertedId.toString(), status: application.status } });
  } catch (error) { next(error); }
});

app.post('/api/subscriptions/renew', authLimiter, csrfProtection, requireAuthLazy, async (req, res, next) => {
  try {
    const parsed = renewalSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Choose one of your subscribed bookmakers to renew.' } });
    if (req.user.role === 'owner') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Owner accounts do not need subscriptions.' } });
    const bookmaker = parsed.data.bookmaker;
    if (!hasSubscriptionRecord(req.user, bookmaker)) return res.status(409).json({ error: { code: 'NO_SUBSCRIPTION_TO_RENEW', message: 'You have not subscribed to this bookmaker yet. Submit an application for it instead.' } });
    const db = req.app.locals.db;
    const emailNormalized = req.user.emailNormalized;
    const pending = await db.collection('applications').findOne({ emailNormalized, bookmaker, status: { $in: OPEN_APPLICATION_STATUSES } });
    if (pending) return res.status(409).json({ error: { code: 'APPLICATION_EXISTS', message: 'A renewal or application for this bookmaker is already being processed.' } });
    const now = new Date();
    const application = { fullName: req.user.fullName || req.user.email, email: req.user.email, emailNormalized, bookmaker, priceNgn: req.app.locals.config.bookmakerPricesNgn[bookmaker], status: 'pending', type: 'renewal', userId: req.user._id, createdAt: now, updatedAt: now, reviewedAt: null, reviewedByUserId: null, rejectionReason: null };
    let result;
    try { result = await db.collection('applications').insertOne(application); }
    catch (insertError) {
      if (insertError?.code === 11000) return res.status(409).json({ error: { code: 'APPLICATION_EXISTS', message: 'A renewal or application for this bookmaker is already being processed.' } });
      throw insertError;
    }
    await writeAudit(db, { actorUserId: req.user._id, action: 'subscription.renewal_request', requestId: req.requestId, details: { applicationId: result.insertedId.toString(), bookmaker } });
    res.status(201).json({ message: 'Renewal request received. BETGO will email your payment link after review.', application: { id: result.insertedId.toString(), status: application.status } });
  } catch (error) { next(error); }
});

const deactivateUserSchema = z.object({ reason: z.string().trim().max(200).optional().default('') }).strict();

async function loadManagedUser(req) {
  if (!ObjectId.isValid(req.params.userId)) return { block: { status: 400, code: 'INVALID_USER_ID', message: 'User ID is invalid.' } };
  const target = await req.app.locals.db.collection('users').findOne({ _id: new ObjectId(req.params.userId) }, { projection: { passwordHash: 0 } });
  return { target, block: manageBlock(req.user, target) };
}

app.get('/api/admin/users', requireAuthLazy, requireOwner, async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 100) : '';
    const filter = { role: { $ne: 'owner' }, ...(q ? { emailNormalized: { $regex: escapeRegex(q) } } : {}) };
    const users = await req.app.locals.db.collection('users').find(filter, { projection: { passwordHash: 0 } }).sort({ createdAt: -1 }).limit(100).toArray();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ users: users.map((user) => publicUser(user)) });
  } catch (error) { next(error); }
});

// Sends the member a normal reset link by email; the owner never sees a token or sets a password for them.
app.post('/api/admin/users/:userId/reset-password', authLimiter, csrfProtection, requireAuthLazy, requireOwner, async (req, res, next) => {
  try {
    const { target, block } = await loadManagedUser(req);
    if (block) return res.status(block.status).json({ error: { code: block.code, message: block.message } });
    if (target.disabledAt) return res.status(409).json({ error: { code: 'USER_DISABLED', message: 'Reactivate this member before sending a reset link.' } });
    const config = req.app.locals.config;
    const result = await requestPasswordReset(req.app.locals.db, { email: target.email, appOrigin: config.appOrigin, requestId: req.requestId, sendEmail: (message) => sendEmail(config, message) });
    await writeAudit(req.app.locals.db, { actorUserId: req.user._id, action: 'admin.user_password_reset', outcome: result.sent ? 'success' : result.reason, requestId: req.requestId, details: { targetUserId: target._id.toString() } });
    if (result.reason === 'cooldown') return res.status(429).json({ error: { code: 'RESET_RECENTLY_SENT', message: 'A reset link was sent a moment ago. Wait a minute before sending another.' } });
    if (!result.sent) return res.status(502).json({ error: { code: 'EMAIL_FAILED', message: 'The reset email could not be sent. Check the email settings and try again.' } });
    res.json({ message: `Reset link sent to ${target.email}. It expires in 30 minutes.` });
  } catch (error) { next(error); }
});

app.post('/api/admin/users/:userId/deactivate', csrfProtection, requireAuthLazy, requireOwner, async (req, res, next) => {
  try {
    const parsed = deactivateUserSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Reason must be 200 characters or fewer.' } });
    const { target, block } = await loadManagedUser(req);
    if (block) return res.status(block.status).json({ error: { code: block.code, message: block.message } });
    const db = req.app.locals.db; const now = new Date();
    const result = await db.collection('users').updateOne({ _id: target._id, role: { $ne: 'owner' }, disabledAt: null }, { $set: { disabledAt: now, disabledReason: parsed.data.reason || null, updatedAt: now }, $inc: { authVersion: 1 } });
    if (result.modifiedCount !== 1) return res.status(409).json({ error: { code: 'ALREADY_DISABLED', message: 'This member is already deactivated.' } });
    await db.collection('sessions').updateMany({ userId: target._id, revokedAt: null }, { $set: { revokedAt: now } });
    await db.collection('bettingAccounts').updateMany({ ownerUserId: target._id }, { $set: { enabledForNewActivity: false, integrationAuthorized: false, updatedAt: now } });
    await writeAudit(db, { actorUserId: req.user._id, action: 'admin.user_deactivate', requestId: req.requestId, details: { targetUserId: target._id.toString() } });
    res.json({ message: 'Member deactivated and signed out everywhere.' });
  } catch (error) { next(error); }
});

app.post('/api/admin/users/:userId/reactivate', csrfProtection, requireAuthLazy, requireOwner, async (req, res, next) => {
  try {
    const { target, block } = await loadManagedUser(req);
    if (block) return res.status(block.status).json({ error: { code: block.code, message: block.message } });
    const db = req.app.locals.db;
    const result = await db.collection('users').updateOne({ _id: target._id, role: { $ne: 'owner' }, disabledAt: { $ne: null } }, { $set: { disabledAt: null, disabledReason: null, updatedAt: new Date() } });
    if (result.modifiedCount !== 1) return res.status(409).json({ error: { code: 'NOT_DISABLED', message: 'This member is not deactivated.' } });
    await writeAudit(db, { actorUserId: req.user._id, action: 'admin.user_reactivate', requestId: req.requestId, details: { targetUserId: target._id.toString() } });
    res.json({ message: 'Member reactivated. Their connections and activity switches stay off until re-enabled.' });
  } catch (error) { next(error); }
});

app.get('/api/admin/applications', requireAuthLazy, requireOwner, async (req, res) => {
  const applications = await req.app.locals.db.collection('applications').find({}).sort({ createdAt: -1 }).limit(200).toArray();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ applications: applications.map((item) => ({ id: item._id.toString(), fullName: item.fullName, email: item.email, bookmaker: item.bookmaker, priceNgn: item.priceNgn, type: item.type || 'new', status: item.status, createdAt: item.createdAt, rejectionReason: item.rejectionReason || null })) });
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
    let notificationSent = true;
    try {
      await sendEmail(req.app.locals.config, { to: application.email, subject: 'BETGO application update', text: `Hello ${application.fullName},\n\nYour BETGO application for ${application.bookmaker} was not approved.\n\nReason: ${parsed.data.reason}\n\nYou may contact BETGO support if you need clarification.` });
    } catch (emailError) {
      notificationSent = false;
      console.error(JSON.stringify({ level: 'error', event: 'application_rejection_email_failed', requestId: req.requestId, applicationId: application._id.toString(), errorName: emailError?.name || 'Error', errorCode: emailError?.code || 'EMAIL_SEND_FAILED' }));
    }
    await writeAudit(db, { actorUserId: req.user._id, action: 'application.reject', requestId: req.requestId, details: { applicationId: application._id.toString(), bookmaker: application.bookmaker, notificationSent } });
    res.json({ message: notificationSent ? 'Application rejected and notification email sent.' : 'Application rejected, but the notification email could not be sent. Check the email provider configuration in Render.', notificationSent });
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
    await sendEmail(req.app.locals.config, {
      to: application.email,
      subject: 'Your BETGO application is approved',
      text: `Hello ${application.fullName},\n\nYour application for ${application.bookmaker} has been approved.\n\nSubscription price: NGN ${application.priceNgn.toLocaleString('en-NG')} for 30 days.\n\nComplete payment securely using this Flutterwave link:\n${payment.link}\n\nYour 30-day subscription starts only after Flutterwave confirms successful payment. Do not share your payment details with anyone.`,
      html: `<p>Hello ${escapeHtml(application.fullName)},</p><p>Your application for ${escapeHtml(application.bookmaker)} has been approved.</p><p>Subscription price: NGN ${application.priceNgn.toLocaleString('en-NG')} for 30 days.</p><p>Complete payment securely using this Flutterwave link:</p><p><a href="${escapeHtml(payment.link)}">Pay securely with Flutterwave</a></p><p>Your 30-day subscription starts only after Flutterwave confirms successful payment. Do not share your payment details with anyone.</p>`
    });
    await writeAudit(db, { actorUserId: req.user._id, action: 'application.approve', requestId: req.requestId, details: { applicationId: application._id.toString(), bookmaker: application.bookmaker, amountNgn: application.priceNgn } });
    res.json({ message: 'Application approved; payment link created and email sent.', paymentUrl: payment.link });
  } catch (error) { next(error); }
});

app.get('/payment/return', async (req, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const transactionId = String(req.query.transaction_id || '');
    const reference = String(req.query.tx_ref || '');
    if (!/^\d+$/.test(transactionId) || !/^betgo_[a-fA-F0-9]{24}_[a-fA-F0-9]{32}$/.test(reference)) {
      return res.status(400).send(paymentResultPage('Payment not verified', 'The payment details returned by Flutterwave are incomplete or invalid. Do not pay again yet; contact BETGO support to check the transaction.'));
    }
    if (!req.app.locals.config.flutterwaveSecretKey) {
      return res.status(503).send(paymentResultPage('Payment check unavailable', 'BETGO could not verify this transaction right now. Your payment has not been activated by this page. Please try again later.'));
    }
    const verified = await verifyFlutterwavePayment(req.app.locals.config, transactionId);
    if (!verified || String(verified.tx_ref) !== reference || String(verified.id) !== transactionId || verified.status !== 'successful') {
      return res.status(400).send(paymentResultPage('Payment not confirmed', 'Flutterwave has not confirmed a successful matching transaction. Your subscription has not been activated by this page.'));
    }
    const db = req.app.locals.db;
    const payment = await db.collection('payments').findOne({ reference, provider: 'flutterwave' });
    if (!payment) return res.status(404).send(paymentResultPage('Payment reference not found', 'The transaction was verified, but BETGO could not match it to an application. Contact support and provide your Flutterwave transaction ID.'));
    const application = await db.collection('applications').findOne({ _id: payment.applicationId });
    const amountOk = Number(verified.amount) === Number(payment.amountNgn);
    const currencyOk = verified.currency === 'NGN';
    if (!application || !amountOk || !currencyOk) {
      console.warn('payment mismatch (return)', { reference, applicationFound: Boolean(application), amountOk, currencyOk, got: { amount: verified.amount, currency: verified.currency, email: verified.customer?.email }, expected: { amount: payment.amountNgn, email: application?.email } });
      return res.status(400).send(paymentResultPage('Payment details need review', 'The verified transaction does not match the expected application, amount, currency, and customer. BETGO has not activated this subscription from the callback. Contact support.'));
    }
    if (payment.status === 'paid' && application.status === 'active') {
      return res.send(paymentResultPage('Payment confirmed', 'Your payment and subscription are confirmed. You can return to BETGO and sign in.'));
    }
    return res.send(paymentResultPage('Payment verified', 'Flutterwave confirms your payment. BETGO is waiting for its secure payment-processing webhook to activate your 30-day subscription and send your login details. Do not pay again. If activation email does not arrive shortly, contact BETGO support.'));
  } catch (error) { next(error); }
});

function paymentResultPage(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} — BETGO</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:12vh auto;padding:24px;line-height:1.6;color:#172033}main{border:1px solid #dce2ea;border-radius:16px;padding:28px}h1{font-size:1.6rem}a{color:#1749a5}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">Return to BETGO</a></p></main></body></html>`;
}

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
    const amountOk = Number(verified.amount) === Number(payment.amountNgn);
    const currencyOk = verified.currency === 'NGN';
    if (!application || !amountOk || !currencyOk) {
      console.warn('payment mismatch (webhook)', { reference: verified.tx_ref, applicationFound: Boolean(application), amountOk, currencyOk, got: { amount: verified.amount, currency: verified.currency, email: verified.customer?.email }, expected: { amount: payment.amountNgn, email: application?.email } });
      return res.status(200).json({ received: true, verified: false });
    }
    const emailNormalized = application.emailNormalized;
    let user = await db.collection('users').findOne({ emailNormalized });
    let now = new Date();
    let subscriptionExpiresAt;
    if (payment.status === 'paid') {
      if (payment.createdAccount === false || !user || user.mustChangePassword !== true) return res.status(200).json({ received: true, alreadyProcessed: true });
      // Retry delivery after a transient email-provider failure without extending the paid subscription.
      const temporaryPassword = randomBytes(18).toString('base64url');
      await db.collection('users').updateOne({ _id: user._id, mustChangePassword: true }, { $set: { passwordHash: await argon2.hash(temporaryPassword, { type: argon2.argon2id }), temporaryPasswordIssuedAt: now } });
      subscriptionExpiresAt = latestExpiry(user) || user.subscriptionExpiresAt;
      await sendEmail(req.app.locals.config, { to: application.email, subject: 'BETGO temporary login details', text: `Hello ${application.fullName},\n\nUsername: ${application.email}\nTemporary password: ${temporaryPassword}\nSubscription expires: ${new Date(subscriptionExpiresAt).toISOString()}\n\nSign in at ${req.app.locals.config.appOrigin} and change this temporary password immediately.` });
      return res.status(200).json({ received: true, credentialEmailRetried: true });
    }
    if (payment.status !== 'pending' || application.status !== 'approved_awaiting_payment') return res.status(200).json({ received: true, alreadyProcessed: true });
    if (user?.role === 'owner') return res.status(200).json({ received: true, accountExists: true });
    if (user) {
      // Existing customer: add this bookmaker (or extend it on renewal) without touching their password or other subscriptions.
      const grant = grantSubscription(user, application.bookmaker, now);
      await db.collection('users').updateOne(
        { _id: user._id, appliedPaymentRefs: { $ne: payment.reference } },
        { $set: { subscriptions: grant.subscriptions, subscriptionExpiresAt: grant.subscriptionExpiresAt, bookmaker: user.bookmaker || application.bookmaker, updatedAt: now }, $addToSet: { appliedPaymentRefs: payment.reference } }
      );
      const refreshed = await db.collection('users').findOne({ _id: user._id });
      const bookmakerExpiresAt = subscriptionsOf(refreshed).find((item) => item.bookmaker === application.bookmaker)?.expiresAt || grant.bookmakerExpiresAt;
      await db.collection('payments').updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'paid', paidAt: now, flutterwaveTransactionId: verified.id, updatedAt: now, userId: user._id, createdAccount: false } });
      await db.collection('applications').updateOne({ _id: application._id, status: 'approved_awaiting_payment' }, { $set: { status: 'active', paidAt: now, subscriptionExpiresAt: bookmakerExpiresAt, userId: user._id, updatedAt: now } });
      await sendEmail(req.app.locals.config, { to: application.email, subject: `BETGO ${application.bookmaker} subscription confirmed`, text: `Hello ${application.fullName},\n\nYour payment of NGN ${payment.amountNgn.toLocaleString('en-NG')} is confirmed. Your ${application.bookmaker} subscription is active until ${new Date(bookmakerExpiresAt).toISOString()}.\n\nSign in at ${req.app.locals.config.appOrigin} with your existing BETGO password. Your other subscriptions are unchanged.` });
      await writeAudit(db, { action: 'payment.activate_subscription', requestId: req.requestId, details: { applicationId: application._id.toString(), userId: user._id.toString(), bookmaker: application.bookmaker, amountNgn: payment.amountNgn, existingAccount: true } });
      return res.json({ received: true, activated: true, existingAccount: true });
    }
    const temporaryPassword = randomBytes(18).toString('base64url');
    subscriptionExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const passwordHash = await argon2.hash(temporaryPassword, { type: argon2.argon2id });
    const userResult = await db.collection('users').insertOne({ email: application.email, emailNormalized, fullName: application.fullName, passwordHash, role: 'member', bookmaker: application.bookmaker, createdAt: now, disabledAt: null, authVersion: 1, subscriptionStartedAt: now, subscriptionExpiresAt, subscriptions: [{ bookmaker: application.bookmaker, startedAt: now, expiresAt: subscriptionExpiresAt }], appliedPaymentRefs: [payment.reference], mustChangePassword: true, temporaryPasswordIssuedAt: now, applicationId: application._id });
    await db.collection('payments').updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'paid', paidAt: now, flutterwaveTransactionId: verified.id, updatedAt: now, userId: userResult.insertedId, createdAccount: true } });
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
  res.json({ user: { id: req.user._id.toString(), email: req.user.email, fullName: req.user.fullName || '', role: req.user.role, bookmaker: allowedBookmakers(req.user)[0] || req.user.bookmaker || null, bookmakers: allowedBookmakers(req.user), subscriptions: publicSubscriptions(req.user), mustChangePassword: req.user.mustChangePassword === true, subscriptionStartedAt: req.user.subscriptionStartedAt || null, subscriptionExpiresAt: latestExpiry(req.user) || req.user.subscriptionExpiresAt || null } });
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
  if (req.user.role !== 'owner') accountFilter.platform = { $in: allowedBookmakers(req.user) };
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
    if (!canUseBookmaker(req.user, parsed.data.platform)) {
      return res.status(403).json({ error: { code: 'BOOKMAKER_NOT_IN_SUBSCRIPTION', message: 'Your active subscriptions do not include this bookmaker.' } });
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

const connectionCheckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many connection checks; try again later.' } }
});

async function loadOwnAccount(req) {
  if (!ObjectId.isValid(req.params.accountId)) return { error: { status: 400, code: 'INVALID_ACCOUNT_ID', message: 'Account ID is invalid.' } };
  const filter = { _id: new ObjectId(req.params.accountId), ownerUserId: req.user._id };
  if (req.user.role !== 'owner') filter.platform = { $in: allowedBookmakers(req.user) };
  const account = await req.app.locals.db.collection('bettingAccounts').findOne(filter);
  if (!account) return { error: { status: 404, code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' } };
  return { account };
}

// Each account carries its own connection state. "connected" can only come from a connector's own verification;
// until a verified, permitted connector exists for the bookmaker, a check just records that it could not run.
app.post('/api/accounts/:accountId/connection/check', connectionCheckLimiter, csrfProtection, requireAuthLazy, async (req, res, next) => {
  try {
    const { account, error } = await loadOwnAccount(req);
    if (error) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    let connector = null; let verification = null;
    try { connector = getBookmakerConnector(account.platform); } catch (connectorError) { if (connectorError.code !== 'BOOKMAKER_CONNECTOR_UNAVAILABLE') throw connectorError; }
    if (connector && typeof connector.verifyConnection === 'function') {
      try { verification = await connector.verifyConnection({ accountId: account._id.toString() }); }
      catch { verification = { ok: false, reason: 'The bookmaker could not be reached. Try again later.' }; }
    }
    const result = applyConnectorCheck(account, connector, verification);
    const updated = await req.app.locals.db.collection('bettingAccounts').findOneAndUpdate({ _id: account._id, ownerUserId: req.user._id }, { $set: result.set }, { returnDocument: 'after' });
    await writeAudit(req.app.locals.db, { actorUserId: req.user._id, action: 'account.connection_check', requestId: req.requestId, details: { accountId: account._id.toString(), platform: account.platform, from: result.from, to: result.to, outcome: result.set.lastCheckOutcome } });
    res.setHeader('Cache-Control', 'no-store');
    if (!result.connected) return res.status(409).json({ error: { code: 'CONNECTION_NOT_VERIFIED', message: result.set.connectionReason || 'Connection could not be verified.' }, account: publicAccount(updated) });
    res.json({ account: publicAccount(updated), connected: true, message: 'Connection verified.' });
  } catch (error) { next(error); }
});

app.post('/api/accounts/:accountId/connection/disconnect', csrfProtection, requireAuthLazy, async (req, res, next) => {
  try {
    const { account, error } = await loadOwnAccount(req);
    if (error) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    let update;
    try { update = connectionUpdate(account, 'disconnected', { reason: 'Disconnected by you.' }); }
    catch (transitionError) { if (transitionError.code === 'INVALID_CONNECTION_TRANSITION') return res.status(409).json({ error: { code: 'INVALID_CONNECTION_TRANSITION', message: 'This account is not connected.' } }); throw transitionError; }
    const updated = await req.app.locals.db.collection('bettingAccounts').findOneAndUpdate({ _id: account._id, ownerUserId: req.user._id }, { $set: update.set }, { returnDocument: 'after' });
    await writeAudit(req.app.locals.db, { actorUserId: req.user._id, action: 'account.disconnect', requestId: req.requestId, details: { accountId: account._id.toString(), platform: account.platform, from: update.from } });
    res.json({ account: publicAccount(updated) });
  } catch (error) { next(error); }
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
    if (req.user.role !== 'owner') updateFilter.platform = { $in: allowedBookmakers(req.user) };
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
    connectionReason: account.connectionReason || null,
    connectionStatusChangedAt: account.connectionStatusChangedAt || null,
    lastCheckedAt: account.lastCheckedAt || null,
    lastCheckOutcome: account.lastCheckOutcome || null,
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
    if (!canUseBookmaker(req.user, account.platform)) return res.status(403).json({ error: { code: 'BOOKMAKER_NOT_IN_SUBSCRIPTION', message: 'This account is outside your subscribed bookmaker.' } });
    const policies = db.collection('safetyPolicies');
    await policies.updateOne({ ownerUserId: req.user._id }, { $setOnInsert: { ...DEFAULT_SAFETY_POLICY, ownerUserId: req.user._id, openInstructionCount: 0, createdAt: new Date() } }, { upsert: true });
    await policies.updateOne({ ownerUserId: req.user._id, openInstructionCount: { $exists: false } }, { $set: { openInstructionCount: 0 } });
    const saved = await policies.findOne({ ownerUserId: req.user._id });
    const policy = publicSafetyPolicy(saved);
    let verifiedOddsDecimal = input.oddsDecimal;
    if (input.eventId) {
      const current = await sportyBetDataClient.getMarkets(input.eventId);
      const market = current.markets.find((item) => item.marketId === input.marketId && item.status === 'active');
      const outcome = market?.outcomes.find((item) => item.outcomeId === input.outcomeId && item.active === true);
      const currentOdds = Number(outcome?.odds);
      if (!Number.isFinite(currentOdds) || currentOdds <= 1) return res.status(409).json({ error: { code: 'OUTCOME_UNAVAILABLE', message: 'This outcome is no longer active. Reload fixtures and choose another selection.' } });
      if (Math.abs(currentOdds - input.oddsDecimal) > 0.000001) return res.status(409).json({ error: { code: 'ODDS_CHANGED', message: `Odds changed from ${input.oddsDecimal.toFixed(2)} to ${currentOdds.toFixed(2)}. Review the updated odds before creating this instruction.` } });
      verifiedOddsDecimal = currentOdds;
    }
    // Apply the profit cap server-side. The entered stake is a ceiling; never increase it.
    const effectiveStakeMinor = verifiedOddsDecimal && input.maxNetProfitMinor !== undefined
      ? capStakeToNetProfit(input.stakeMinor, verifiedOddsDecimal, input.maxNetProfitMinor)
      : input.stakeMinor;
    if (effectiveStakeMinor < 100) return res.status(400).json({ error: { code: 'PROFIT_CAP_TOO_LOW', message: 'The maximum net-profit cap is too low for a minimum ₦1 stake at these odds.' } });
    if (effectiveStakeMinor > policy.maxStakeMinor) return res.status(409).json({ error: { code: 'STAKE_LIMIT_EXCEEDED', message: 'Stake exceeds the configured maximum per instruction.' } });
    const stakeWasAdjusted = effectiveStakeMinor < input.stakeMinor;
    const slot = await policies.findOneAndUpdate({ ownerUserId: req.user._id, openInstructionCount: { $lt: policy.maxOpenInstructions } }, { $inc: { openInstructionCount: 1 }, $set: { updatedAt: new Date() } }, { returnDocument: 'after' });
    if (!slot) return res.status(409).json({ error: { code: 'OPEN_INSTRUCTION_LIMIT', message: 'Maximum open instructions reached.' } });
    openSlotReserved = true;
    const day = new Date().toISOString().slice(0, 10);
    const spend = db.collection('dailySpend');
    await spend.updateOne({ ownerUserId: req.user._id, day }, { $setOnInsert: { ownerUserId: req.user._id, day, reservedStakeMinor: 0, settledLossMinor: 0, accountReservedStakeMinor: {}, createdAt: new Date() } }, { upsert: true });
    const accountField = `accountReservedStakeMinor.${accountId.toString()}`;
    const reserved = await spend.findOneAndUpdate({ ownerUserId: req.user._id, day, $expr: { $and: [
      { $lte: [{ $add: [{ $ifNull: ['$reservedStakeMinor', 0] }, effectiveStakeMinor] }, policy.dailyStakeLimitMinor] },
      { $lte: [{ $add: [{ $ifNull: ['$settledLossMinor', 0] }, { $ifNull: ['$reservedStakeMinor', 0] }, effectiveStakeMinor] }, policy.dailyLossLimitMinor] },
      { $lte: [{ $add: [{ $ifNull: [`$${accountField}`, 0] }, effectiveStakeMinor] }, policy.perAccountDailyStakeLimitMinor] }
    ] } }, { $inc: { reservedStakeMinor: effectiveStakeMinor, [accountField]: effectiveStakeMinor }, $set: { updatedAt: new Date() } }, { returnDocument: 'after' });
    if (!reserved) {
      await db.collection('safetyPolicies').updateOne({ ownerUserId: req.user._id, openInstructionCount: { $gt: 0 } }, { $inc: { openInstructionCount: -1 }, $set: { updatedAt: new Date() } });
      openSlotReserved = false;
      return res.status(409).json({ error: { code: 'DAILY_LIMIT_EXCEEDED', message: 'Global stake, conservative loss-exposure or per-account daily limit would be exceeded.' } });
    }
    reservation = { ownerUserId: req.user._id, day, accountField, stakeMinor: effectiveStakeMinor };
    const now = new Date();
    const instruction = { ownerUserId: req.user._id, accountId, accountLabel: account.displayName, platform: account.platform, eventLabel: input.eventLabel, selectionLabel: input.selectionLabel, notes: input.notes, stakeMinor: effectiveStakeMinor, oddsDecimal: verifiedOddsDecimal, eventId: input.eventId, marketId: input.marketId, outcomeId: input.outcomeId, maxNetProfitMinor: input.maxNetProfitMinor, stakeAdjusted: stakeWasAdjusted, currency: 'NGN', status: 'awaiting_approval', idempotencyKey: input.idempotencyKey, reservationDay: day, reservationActive: true, submissionEnabled: false, createdAt: now, updatedAt: now };
    const inserted = await db.collection('betInstructions').insertOne(instruction);
    reservation = null;
    openSlotReserved = false;
    await writeAudit(db, { actorUserId: req.user._id, action: 'bet_instruction.create', requestId: req.requestId, details: { instructionId: inserted.insertedId.toString(), accountId: accountId.toString(), stakeMinor: effectiveStakeMinor, stakeAdjusted: stakeWasAdjusted, oddsDecimal: verifiedOddsDecimal, maxNetProfitMinor: input.maxNetProfitMinor, status: instruction.status } });
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
  return { id: instruction._id.toString(), accountId: instruction.accountId.toString(), accountLabel: instruction.accountLabel, platform: instruction.platform, eventLabel: instruction.eventLabel, selectionLabel: instruction.selectionLabel, notes: instruction.notes || '', stakeMinor: instruction.stakeMinor, oddsDecimal: instruction.oddsDecimal, eventId: instruction.eventId, marketId: instruction.marketId, outcomeId: instruction.outcomeId, maxNetProfitMinor: instruction.maxNetProfitMinor, stakeAdjusted: instruction.stakeAdjusted === true, currency: instruction.currency, status: instruction.status, reservationReleaseState: instruction.reservationReleaseState || (instruction.reservationActive ? 'active' : 'not_applicable'), submissionEnabled: false, createdAt: instruction.createdAt, updatedAt: instruction.updatedAt };
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
    errorCode: error?.code || undefined,
    errorStatus: Number.isInteger(error?.status) ? error.status : undefined,
    message: req.app.locals.config?.nodeEnv === 'production' ? 'Request failed' : String(error?.message || error)
  }));
  if (res.headersSent) return;
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId: req.requestId } });
});

export default app;
