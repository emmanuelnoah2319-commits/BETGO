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
