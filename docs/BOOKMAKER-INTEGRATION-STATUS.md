# BETGO bookmaker integration feasibility (2026-10-28)

## Goal

BETGO's required integration is an account-level betting interface that can submit a stake to a target bookmaker, then reconcile accepted/rejected/unknown outcomes and later settlement. A fixtures/odds API is not sufficient.

## Findings

| Target | Verified public third-party bet-placement API? | Current decision |
|---|---|---|
| SportyBet | Not verified. A public community project describes website endpoints for fixtures/markets and a shareable booking code. It explicitly says the booking-code flow does not submit or stake a wager and that the endpoints are undocumented/unsupported. | Do not treat as a real betting connector. Seek written permission and a supported placement interface. |
| Football.com Nigeria | Not verified in this discovery pass. | Unavailable; ask the operator for a partner/API specification. |
| BetWinner | Not verified in this discovery pass. Public website terms describing normal customer betting are not developer API documentation. | Unavailable; ask the operator for an authorized integration/partner route. |
| Sokabet | Not verified in this discovery pass. | Unavailable; ask the operator for a partner/API specification. |
| MSport | Not verified. Its official Nigeria contact page lists `marketing.nigeria@msport.com` for business and other enquiries. | Ask the operator whether an approved betting API or B2B integration exists; do not infer access from the contact page. |

## Sources checked

- SportyBet community connector description (not official): https://github.com/UbongErnest/Sportybet-mcp
- SportyBet API discussion, updated October 2026 (secondary source): https://sportapi.net/blog/sportybet-api.html
- MSport official Nigeria contact page: https://www.msport.com/ng/support/about/contact-us
- BetWinner Nigeria website: https://betwinner.ng/en

These sources do not establish a permitted real-money bet-placement API for any of the five target platforms. Search results, reverse-engineered website endpoints, affiliate links, booking-code creation and sports-data feeds must not be represented as a bookmaker bet-placement API.

## Next external action

A copy-ready outreach message, operator contact routes, required questions and activation checklist are now in [`BOOKMAKER-API-ACCESS-REQUESTS.md`](./BOOKMAKER-API-ACCESS-REQUESTS.md). These requests have not been sent by BETGO. The project owner must contact the operators and record their replies. Start with SportyBet and MSport because official contact routes were found; then use the official Nigeria support routes for Football.com, BetWinner and Sokabet. A partner/affiliate page alone does not prove that a betting API is available. If a response only offers affiliate tracking, odds data or booking-code sharing, it does not satisfy BETGO's requirement. Never submit bookmaker passwords, OTPs or recovery codes to a third-party integration service.

## Connector activation gate

A target can be marked available only after all of these are verified:

1. The provider permits this integration for the intended account type and jurisdiction.
2. A documented placement operation and authentication method are supplied by the provider or its authorized partner.
3. A sandbox or controlled test process verifies request schema and accepted/rejected responses.
4. A timeout after submission can be reconciled without blindly retrying and duplicating a wager.
5. Bet status and settlement can be queried or received from a trusted provider mechanism.
6. Credentials are stored server-side in a secret manager, never in the browser or account notes.
7. Stake limits, explicit enablement, emergency stop, audit events and idempotency are enforced before the live connector is enabled.

Until then, all five connectors remain unavailable. The app must not submit to undocumented endpoints or claim a wager succeeded without provider confirmation.

## SportyBet odds-to-instruction handoff (2026-10-28)

The read-only fixtures panel now provides a `Use selection` action for an active 1X2 outcome with a valid decimal price. It copies the fixture and selected outcome into BETGO's existing review-instruction form, selects an existing SportyBet reference account when available, and records the fetched time/price snapshot in the notes. Inactive outcomes or missing/invalid prices are disabled. The UI explicitly warns that the odds are a snapshot and that BETGO has not placed a wager. This is still a manual review workflow; no bookmaker login or wager submission is performed.

Validation: `node --check public/app.js`, `node --check src/app.js`, and `node --test test/sportybet-data.test.js` passed locally. A full test run could not complete because the package install timed out and dependencies such as `dotenv` were unavailable in the temporary test directory. MongoDB integration tests still require an isolated `MONGO_TEST_URI`.
