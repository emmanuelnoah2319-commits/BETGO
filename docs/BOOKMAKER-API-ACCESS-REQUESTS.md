# BETGO — bookmaker API access request pack

Updated: 2026-10-28

## Purpose

BETGO needs a documented, permitted interface that can submit a real wager on the user's own bookmaker account and later verify acceptance/rejection and settlement. An affiliate link, odds feed, booking-code/share-slip endpoint, or market-data API is not sufficient.

This pack helps request the right technical and commercial information. No requests have been sent by BETGO; the user must contact the operators and keep their replies.

## Copy-ready request

**Subject:** Request for authorized sportsbook API / B2B integration for BETGO

Hello Partnerships / Business Development Team,

I am developing BETGO, a private betting-account management application. I would like to ask whether your company offers an official, authorized API or B2B integration that permits an account holder or approved application to submit sports wagers to their own account.

We are specifically looking for a documented and permitted integration for:

- Authentication through an approved authorization flow (not collecting passwords, OTPs, or recovery codes in our application).
- Retrieving eligible events, markets, selections and current odds, if included in the product.
- Submitting a wager with a stake and selection, and receiving an authoritative accepted, rejected, or pending/unknown response.
- Checking a wager's status and final settlement, including a safe way to reconcile a network timeout without placing a duplicate wager.
- Sandbox/test credentials, API documentation, rate limits, supported account types and Nigerian-jurisdiction availability.
- Written terms covering permitted automated placement, security requirements, data handling, fees and any approval or licensing prerequisites.

Could you please confirm whether this integration is available and direct me to the correct technical/business contact? If your available offering is limited to affiliate tracking, odds/data access, or shareable bet slips, please clarify that as well, because those do not meet our bet-placement requirement.

We will not attempt to use undocumented endpoints or enable real-money submission without your written authorization and a successful sandbox/controlled verification process.

Thank you,
BETGO team

## Contact routes checked

These are routes found on the operators' official websites where possible. A listed customer-care channel is **not** proof that the company offers an API; ask to be routed to technical partnerships/business development. Do not send passwords, OTPs, PINs, payment details, or account recovery codes.

| Operator | Official route found | What to ask / current status |
|---|---|---|
| SportyBet Nigeria | Official site: https://www.sportybet.com/ng/ ; support contacts on official help page: https://www.sportybet.com/ng/help?nav=terms-and-conditions | Ask support to route the request to technical partnerships. No public third-party bet-placement API verified. |
| Football.com Nigeria | Official site/about: https://www.football.com/ng/m/n/help/about ; customer support: https://www.football.com/ng/m/support | Use the official support route and request business/technical partnership contact. No public third-party bet-placement API verified. |

## Questions to record for every provider

1. Is third-party bet placement permitted for an individual's own account, or is the API only for licensed B2B/white-label partners?
2. Is Nigeria supported, and what account type/legal or licensing approvals are required?
3. What is the official API base URL, documentation, versioning policy and authentication method?
4. Does the API submit a wager, not merely create a share code or bet slip?
5. What unique client reference/idempotency mechanism prevents duplicate wagers?
6. How are accepted, rejected, pending, suspended-market, odds-changed and timeout outcomes represented?
7. How can BETGO query/reconcile a wager and settlement after a lost connection?
8. Is there a sandbox or controlled test environment, and how are test results verified?
9. What are the rate limits, operational support SLA, fees and security obligations?
10. What data retention, customer consent and credential-storage requirements apply?

## Activation checklist

Do not mark a connector available until the operator's permission and technical contract are verified, credentials are provisioned securely, sandbox tests cover accepted/rejected/timeout/duplicate scenarios, bet status/settlement can be reconciled, limits and emergency stop are enforced, and an explicit production activation decision is recorded.

Until then, BETGO must keep the provider `unavailable`, `betPlacement: false`, and `automaticBettingEnabled: false`. Never probe or automate undocumented endpoints as a substitute for permission.

## Source notes

- SportyBet official Nigeria site and help page; official customer contact details are listed there.
- Football.com Nigeria official About page identifies Football Internet Ltd. as the operator; its official support route is listed above.

The sources establish contact routes, not API availability. API availability remains unverified for all five target operators.
