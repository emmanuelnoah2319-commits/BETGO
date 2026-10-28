# BETGO

Private, mobile-first betting management foundation. **This is not yet a betting bot and does not place bets.** Bookmaker adapters are explicitly unavailable until official integration access and permission are verified. Automatic betting remains disabled.

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
- Audit events for login/logout
- Unit tests for configuration and security utilities

Not implemented yet:
- Betting-account create/edit flows
- Rules engine and atomic spend/loss-limit enforcement
- Bet instructions, approval queue, submissions or settlement reconciliation
- Actual bookmaker integrations
- Firebase Admin SDK and device registration
- Operational worker and deployment automation
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

The current server does not run a betting worker, so it cannot resume or submit bets after restart. The session and audit records persist in MongoDB. Worker recovery and durable submission reconciliation will be designed before a betting engine is implemented.

## Tests

```bash
npm test
npm run check
```

Tests do not place real-money bets.
