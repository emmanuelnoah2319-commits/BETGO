# BETGO Phase 1 — Discovery and Feasibility

## Confirmed scope
- Company/product: BETGO
- New repository; private dashboard
- Node.js/Express ES modules, vanilla HTML/CSS/JS, MongoDB, FCM
- Target bookmakers: SportyBet, Football.com Nigeria (`football.com/ng`), BetWinner, Sokabet and MSport
- No official API/partner credentials currently available
- Automatic betting disabled by default

## Integration gate
No platform adapter may submit a bet until the operator's official API/partner documentation, account authorization, permitted use, market coverage, rate limits, sandbox and reconciliation semantics have been verified. Website access or undocumented endpoints are not sufficient authorization. Where terms prohibit automated access, do not automate website interaction.

## Initial architecture
Browser dashboard -> Express API -> MongoDB. Separate durable worker will later consume database-backed instructions and use atomic claims, unique submission records, limits and reconciliation. FCM will be an optional notification side channel. No queue service is introduced until workload requirements justify it.

## Phase 2 foundation scope
Environment validation, MongoDB connection/indexes, Argon2id owner authentication, hashed opaque sessions, CSRF, rate limiting, security headers, audit events, health checks, dashboard shell and automated tests.

## Open blockers
1. Written API/partner approval from each operator.
2. Sandbox credentials and provider integration specifications.
3. Exact Nigeria-specific terms for each operator.
4. FCM project configuration.
5. Production hosting, domain, monitoring and backup choices.
6. Worker/submission engine is not implemented and must not be implied to exist.

## Follow-on increment: account records
- Added authenticated list/create/update endpoints for internal account records.
- Account records are scoped to the authenticated owner user and store no bookmaker credentials.
- New activity is disabled by default; enabling is rejected until an authorized integration is verified.
- Duplicate display names are constrained per user and platform.
- Account writes emit audit events containing allowlisted metadata only.

## Membership, approval and subscription lifecycle (Phase 1 implementation)

- Public `GET /api/plans` returns the configured per-bookmaker 30-day prices.
- Public `POST /api/applications` stores an application as `pending`; it does not create a user or charge the applicant.
- Owner-only `GET /api/admin/applications` lists applications. Owner-only approve/reject endpoints enforce pending-state transitions. Rejection requires a reason.
- Approval initializes a Flutterwave transaction and emails its hosted payment link through Resend. Approval is unavailable until payment and email configuration are present; the UI does not report a false success.
- `POST /api/payments/flutterwave/webhook` verifies the webhook secret hash (`verif-hash` header) and independently verifies the transaction with Flutterwave before checking amount, NGN currency and customer email. A verified payment creates a member with a 30-day subscription starting at confirmation time and sends a random temporary password. The first authenticated session is restricted to the password-change screen until a 12+ character password is set.
- Subscription expiry is enforced at login and authenticated request middleware. Bet fixtures and odds are not stored by these membership routes.

### Required deployment environment

Set `RESEND_API_KEY`, a verified `EMAIL_FROM`, `FLW_SECRET_KEY`, and a strong random `FLW_SECRET_HASH` in Render. Set `FLW_CALLBACK_URL` to the deployed return URL. In the Flutterwave dashboard, configure the webhook URL as `/api/payments/flutterwave/webhook` and use the exact same secret hash. Configure prices with `PRICE_SPORTYBET_NGN`, `PRICE_FOOTBALL_COM_NGN`, `PRICE_BETWINNER_NGN`, `PRICE_SOKABET_NGN`, and `PRICE_MSPORT_NGN`. Keep secrets in Render environment settings; never commit them. Configure Flutterwave to send the `charge.completed` webhook to `/api/payments/flutterwave/webhook`.

### Verification status

Syntax checks were run for all changed JavaScript files. Full `npm test` and integration tests still need to run in the repository's normal Node 22 environment with dependencies installed; payment and email providers also require live staging verification.
