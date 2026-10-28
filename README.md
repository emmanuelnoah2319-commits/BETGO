# BETGO

Private, mobile-first betting management foundation. **This is not yet a betting bot and does not place bets.** Bookmaker connectors are explicitly unavailable until a permitted bet-placement interface is verified. Automatic betting remains disabled.

## Requirements

- Node.js 22 or newer
- MongoDB 6+ (managed MongoDB is recommended for production)
- npm

## Run locally

```bash
cp .env.example .env
# Edit .env and set SESSION_SECRET to a random value of at least 32 characters.
npm install
npm test
npm run check
npm start
```

Open `http://localhost:3000`. Health endpoints:
- `GET /health/live`
- `GET /health/ready`

The server requires MongoDB to be running. A local MongoDB instance can be used for development. Do not expose it publicly.

## Bootstrap the private owner

Set both `BOOTSTRAP_OWNER_EMAIL` and `BOOTSTRAP_OWNER_PASSWORD` in `.env` before first startup. Use a unique password of at least 12 characters. The server creates an owner only if no owner already exists. Remove these two variables after the owner is created. Do not commit `.env`.

Public registration is not implemented. Additional users should not be added until an explicit owner-management workflow is built and tested.

## Security notes

- Passwords are hashed using Argon2id.
- Session tokens are random and only SHA-256 hashes are stored in MongoDB.
- Cookies are HttpOnly, SameSite=Strict, and Secure in production.
- Mutating routes require a CSRF cookie/header pair.
- Helmet security headers and a restrictive same-origin Content Security Policy are enabled.
- Login attempts are rate-limited.
- Request IDs and allowlisted audit events are recorded.
- Production requires `SESSION_COOKIE_SECURE=true` and a non-placeholder secret.
- Terminate TLS at a trusted reverse proxy and configure proxy trust deliberately before deployment.
- Use managed database encryption, backups, least-privilege database credentials, secret-manager storage, monitoring and tested restore drills in production.

## Current implementation status

Implemented in this foundation:
- Express 5 app and validated configuration
- MongoDB connection and indexes
- Private owner login, logout, sessions and Argon2id password hashing
- CSRF checks for state-changing routes
- Rate limiting, Helmet, CSP and request IDs
- Liveness/readiness endpoints
- Integration status and private dashboard shell
- Private account-record create/list/edit UI and owner-scoped API routes
- Account labels, platform, non-sensitive notes and duplicate-name protection
- Configurable per-instruction, global daily stake, per-account daily stake, daily exposure and open-instruction limits
- Durable review instructions with UUID idempotency keys, reserved exposure, review approval/rejection, cancellation, recoverable idempotent reservation release and audit events
- Unit tests for security utilities

Not implemented yet:
- Account deletion and verified live bookmaker connection workflows
- Full rules engine and settled-loss reconciliation (the current daily loss guard is a conservative exposure cap that counts reserved stakes)
- Bookmaker submissions and settlement reconciliation; the current background worker is recovery-only and does not execute queued wagers
- Actual bookmaker integrations and bet submission
- Firebase Admin SDK and device registration
- Production alert delivery and deployment automation
- Automated end-to-end tests with a real MongoDB test service

No balances, odds, accepted bets or results are fabricated. Integration status is always unavailable until a provider is verified.

## Data collections

`users`, `sessions`, `auditEvents`, `bettingAccounts`, `betInstructions`, `betSubmissions`, `dailySpend`, `notificationDevices`, `systemHealth`.

Indexes are initialized on server startup. Financial collections and settlement data will require additional schemas and retention rules before any real betting functionality is enabled.

## Production deployment

Do not deploy a public instance yet. Before production:
1. Set secrets in the hosting provider's secret manager, not in Git.
2. Use managed MongoDB with TLS, backups and a dedicated least-privilege database user.
3. Set `NODE_ENV=production`, `SESSION_COOKIE_SECURE=true`, and `APP_ORIGIN` to the HTTPS origin.
4. Use a process supervisor or container orchestration with restart-on-failure.
5. Add reverse-proxy configuration, explicit proxy trust, monitoring and alerting.
6. Run tests against an isolated MongoDB test database.
7. Perform security review and backup/restore testing.
8. Keep all bookmaker integrations and automatic betting disabled until written approval and sandbox verification.

## Recovery

The server runs a recovery-only worker that marks stale `submitting` records as `unknown`; it never claims queued work or submits wagers. A persisted global emergency-stop control starts enabled and can be managed by the owner through the operations API. Clearing it does not enable betting: execution and bookmaker requests remain hard-disabled. The owner-only `GET /api/admin/operations` endpoint reports recovery-worker health, submission counts and operational alerts. The worker status is process-local, so each instance reports its own health; production alert delivery and multi-instance aggregation remain future work.

## Tests

```bash
npm test
npm run check
```

Tests do not place real-money bets.

## Account records (foundation increment)

Authenticated users can create and list their own account records with `GET /api/accounts` and `POST /api/accounts`; the private dashboard includes forms to add records and edit their display name/notes. `PATCH /api/accounts/:accountId` also supports disabling new activity. Records are not connected to bookmaker accounts: no bookmaker password or secret is collected, balances remain `null`, and attempts to enable activity are rejected until an authorized integration exists. Requests that change data require a CSRF token from `GET /api/csrf` in both the `betgo_csrf` cookie and `X-CSRF-Token` header. Duplicate display names for the same platform are rejected per user.

## Financial guardrails (foundation increment)

The dashboard and API expose configurable limits at `GET/PATCH /api/safety-policy`. Monetary amounts are stored as integer kobo. Defaults are ₦5,000 per instruction, ₦20,000 global daily stake, ₦10,000 conservative daily exposure, ₦7,500 per account per day and five open instructions. Creating an instruction reserves exposure using an atomic MongoDB update, uses an owner-scoped UUID idempotency key, and starts in `awaiting_approval`. Cancelling a pending instruction releases its reservation. If the process fails after reserving but before recording an instruction, a reservation can remain and conservatively block further activity; reconciliation/repair tooling is still required. This increment does not submit bets, settle results or calculate actual settled losses.


## Bookmaker connector status

The target platforms are SportyBet, Football.com Nigeria, BetWinner, Sokabet and MSport. The connector registry currently reports all five as unavailable and disables account authentication, balance lookup, bet placement and bet-status lookup. This is intentional: a data feed or a non-staking booking-code endpoint is not a bet-placement API. No bookmaker credentials are collected and no submission request is sent.

The release-gate helper in `src/integrations/readiness-gate.js` checks provider authorization, official placement documentation, sandbox results, reconciliation, idempotency, secret storage, stake limits, emergency stop and adapter methods. Each item must include a verification flag, evidence reference, reviewer and review timestamp; bare booleans do not pass. Passing it only marks a connector eligible for separate release review; it does not enable or execute a connector. See `docs/CONNECTOR-RELEASE-GATE.md`.

A copy-ready provider outreach pack is available at `docs/BOOKMAKER-API-ACCESS-REQUESTS.md`; it includes official contact routes found, a request template, technical questions and the activation gate. No requests have been sent automatically. A connector may be enabled only after its actual bet-placement interface, allowed third-party use, authentication method, acceptance/rejection response, duplicate handling and status reconciliation have been verified. The registry and tests fail closed until then. No undocumented endpoint is treated as a stable or authorized API.


## Instruction review lifecycle (foundation increment)

Instructions can now be approved from `awaiting_approval` to `approved_not_submitted`. This is an internal review state only: `submissionEnabled` remains false and no bookmaker request is made. Instructions in `prepared`, `awaiting_approval` or `approved_not_submitted` can be cancelled, releasing their reserved exposure. The status-transition helper is covered by unit tests; live API/MongoDB behavior has not yet been integration-tested.


## Reservation recovery and rejection (foundation increment)

Reviewable instructions can be rejected, which keeps submission disabled and releases reserved exposure. Cancellation/rejection first persist an inactive reservation with a pending release state. Release markers are stored alongside the daily exposure and policy counters so retries do not decrement the same reservation twice. Startup recovery processes up to 500 cancelled/rejected instructions whose release state is not complete; the owner can also call `POST /api/admin/recover-reservations` with a valid session and CSRF token. If counter state is inconsistent, recovery fails closed and records the failure count rather than claiming success. MongoDB-backed crash/restart integration tests are still required.

## Environment diagnostic

Before starting the app, run:

```bash
npm run doctor
```

The diagnostic checks the Node.js version, whether declared production dependencies resolve, whether a local `.env` file and `.env.example` exist, and confirms that this check does not enable bookmaker connectors. A failed dependency check means `npm install` has not completed successfully; it does not mean the app or its full test suite has passed. The diagnostic never prints environment variable values or secrets.

## Submission lifecycle groundwork (no live execution)

`src/services/submission-lifecycle.js` defines a pure state machine for a future authorized submission worker. It treats timeouts and transport errors as `unknown`, blocks retries until reconciliation, and makes accepted/rejected/cancelled states terminal. It does not persist submissions, contact a bookmaker, or place bets. See `docs/SUBMISSION-STATE-MACHINE.md`. MongoDB-backed submission-record primitives now provide owner-scoped queued records, compare-and-set state transitions, transition history, provider-reference validation, and unique idempotency constraints. They are not exposed through a route or worker. Provider-specific reconciliation, real MongoDB concurrency/crash tests, and connector authorization remain unimplemented.

## Submission recovery worker (recovery only)

The server runs a small background recovery sweep at startup and every 30 seconds. It only changes `submitting` records older than 60 seconds to `unknown`, marks `reconciliationRequired`, and records `WORKER_LEASE_EXPIRED`. This protects against a process crash leaving an attempt falsely appearing in progress. It **never** retries an attempt, claims queued records, or sends a request to a bookmaker. `unknown` must be reconciled against a provider-supported status interface before any retry can be evaluated. The recovery worker is stopped on graceful shutdown. Its unit tests use a fake database; run integration tests against an isolated MongoDB service before relying on production concurrency guarantees.


## Operations monitoring and emergency stop

The singleton `systemControls` record starts with `emergencyStop: true`. If the record is missing or malformed, reads fail closed and report the stop as active. The owner-only `GET /api/admin/operations` endpoint returns submission counts, recovery-worker heartbeat/counters, and alerts for repeated recovery failures, unresolved `unknown` submissions, or an active stop. `PATCH /api/admin/emergency-stop` requires authentication, CSRF protection, owner role, and a reason. Clearing the stop also requires the exact confirmation `I CONFIRM BETGO REMAINS NON-EXECUTING`. This is a guardrail only: clearing the stop does not enable execution or bookmaker requests. The current worker is recovery-only, and monitoring is per process rather than a centralized alerting service.

## MongoDB integration tests

The default `npm test` suite uses unit tests and test doubles; it does not prove MongoDB concurrency guarantees. To run the opt-in integration test against a dedicated, disposable MongoDB test server, set `MONGO_TEST_URI` to a URI with permission to create and drop a temporary database, then run:

```bash
BETGO_CONFIRM_DISPOSABLE_MONGO=true npm run test:integration
```

The runner refuses to start unless `MONGO_TEST_URI` is set and `BETGO_CONFIRM_DISPOSABLE_MONGO=true` explicitly confirms the server is dedicated to disposable tests. It rejects URI paths that look like `prod`, `production`, or `live`. The test creates a uniquely named `betgo_test_*` database and drops only that temporary database in cleanup. **Never point `MONGO_TEST_URI` at production or a database containing real user data.** The integration test verifies the submission uniqueness indexes, emergency-stop fail-closed behavior, idempotency replay, competing state transitions, and stale-submission recovery. The test command now fails closed instead of silently reporting a skipped integration test when its required environment is missing.

## SportyBet unofficial read-only data adapter (new increment)

The private dashboard now has a **Load live fixtures** action backed by `GET /api/sportybet/fixtures` and a read-only `GET /api/sportybet/events/:eventId/markets` route. These routes use SportyBet's undocumented public web endpoint for Nigeria (`/api/ng/factsCenter/pcUpcomingEvents`) and require a BETGO login. Fixture responses are normalized server-side, limited to 100 events per request, bounded to a 1–720 hour timeline, timed out after 10 seconds, and cached for 30 seconds. Only current provider response data is shown; provider/network errors are returned as errors rather than fabricated fixtures.

This is an unofficial, changeable data feed. It does not authenticate a SportyBet user, fetch account balances, submit a wager, or enable any connector. Odds can change and are not guaranteed current. The bookmaker integration registry remains unavailable for bet placement. `SPORTYBET_API_BASE_URL` can optionally override the default `https://www.sportybet.com` for testing; do not point production at an untrusted host.

Unit tests cover response normalization, short caching, malformed event IDs, provider errors and bounded query parameters. They use mocked HTTP responses and do not prove that SportyBet's live endpoint will remain available or that any wager can be placed.
