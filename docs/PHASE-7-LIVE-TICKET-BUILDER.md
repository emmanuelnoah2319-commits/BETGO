# Phase 7 — Live ticket builder (read-only data, review-only instructions)

## Included
- The SportyBet fixture list now feeds a ticket builder with the selected event, market, outcome, decimal odds, and fetch-time note.
- The UI previews a stake ceiling based on maximum net profit, excluding the returned stake.
- The server independently re-fetches the selected upcoming event and verifies that the market/outcome remain active and that odds have not changed. Changed or unavailable odds fail closed and require a refresh/reselection.
- The server applies the profit cap before checking/reserving account/global daily exposure and records the verified odds and cap with the review instruction.
- Fixture and odds data are not persisted in MongoDB. The adapter may cache in memory for ordinary fixture browsing; market revalidation forces a fresh upstream request.
- No bookmaker account login or wager submission is implemented. Approval still does not place a bet.

## Verification
- Run `npm run check` and `npm test` in CI.
- `test/profit-cap.test.js` covers cap calculations in integer kobo.
- Live SportyBet availability is external and must be tested from the deployed service; the endpoint is undocumented and may change.
