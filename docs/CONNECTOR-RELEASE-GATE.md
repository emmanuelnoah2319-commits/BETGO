# Bookmaker connector release gate

Updated: 2026-10-28

BETGO has no verified, authorized real-money placement connector at this time. This gate is a defensive helper for future connector review; it does **not** activate connectors and is not a substitute for provider approval, legal review, or controlled testing.

## Required evidence

The pure helper `src/integrations/readiness-gate.js` blocks readiness unless each required item is a reviewable evidence record containing `verified: true`, a non-empty `reference`, a non-empty `reviewedBy`, and a valid non-future `reviewedAt` timestamp. Bare booleans do not count. The reference should identify a provider document, controlled test report, or internal review artifact; do not put credentials or other secrets in evidence records. Required evidence:

- Written provider authorization for the intended integration and jurisdiction.
- Official placement documentation from the provider or an authorized partner.
- Authentication verified without collecting secrets in browser-visible fields.
- Sandbox/controlled placement tested.
- Accepted and rejected responses tested.
- Timeout/unknown-result reconciliation tested without blind retries.
- Idempotency and duplicate-submit protection verified.
- Server-side secret storage verified.
- Stake limits verified at the connector boundary.
- Emergency stop verified.
- An adapter implements both `placeBet` and `reconcileBet`.
- Explicit enablement is provided for the readiness evaluation.

Even when all checks pass, the result is `eligible_for_release_review`, not `enabled`. Production registry changes require a separate reviewed implementation and release. Do not place real bets during unit tests.

## Current status

All five target bookmakers remain unavailable. No provider has supplied verified placement documentation in this repository, and no request has been sent automatically. See `BOOKMAKER-API-ACCESS-REQUESTS.md` for the owner-led outreach process and `BOOKMAKER-INTEGRATION-STATUS.md` for the current evidence summary.

## Tests

Run `node --test test/readiness-gate.test.js test/bookmakers.test.js`. The tests verify missing evidence, reject bare booleans and incomplete/future-dated review records, check missing adapter methods and explicit enablement, and preserve the distinction between release eligibility and an active connector.
