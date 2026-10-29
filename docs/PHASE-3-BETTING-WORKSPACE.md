# Phase 3 — Betting workspace

## What it does
- **Games on demand.** New **Betting** tab. Nothing loads until the member types a game ("Arsenal vs Chelsea", one team, or a league). `GET /api/sportybet/search?q=` returns upcoming and live games (live first, with score and clock), never finished ones, and matches accent- and punctuation-insensitively. There is no browse/preload list. Rate limited to 20 searches/minute per user.
- **Markets and odds.** Opening a game shows every market SportyBet returns for it (`getEventMarkets`), each outcome as a tappable odd, with a filter box. Tapping adds it to the ticket, tapping again removes it; one outcome per match, up to 10 matches.
- **Bet ticket with max profit.** Stake and **Max profit** inputs. Combined odds are the product of the legs. If `stake × (odds − 1)` would exceed Max profit, the stake is lowered automatically to `floor(maxProfit / (odds − 1))` (never raised). The ticket shows the entered stake, the stake that will be used, potential profit (excludes returned stake) and potential return.
- **Safe save.** "Save ticket for review" posts to the existing `POST /api/bet-instructions`. The server re-fetches fresh odds, re-applies the cap, enforces stake/daily limits, and stores the result. Changed or closed odds refresh the ticket and ask for a re-save. Nothing is sent to SportyBet.

## Fixes made on the way
- Markets that share an id but differ by line (Over/Under 2.5 vs 3.5) are now told apart by `specifier` in both the UI and server verification. Previously the server would have verified against whichever line came first.
- Single selections now also fail if the match has started.
- The cap calculation can no longer land a kobo over the cap through floating-point rounding.
- `public/app.js` is now loaded as an ES module so the browser shares `public/ticket-calc.js`; `test/ticket-calc.test.js` proves it matches the server maths.
- The old test asserting "the dashboard has no ticket screens" was replaced to match this phase.

## Known limits
- Uses SportyBet's **unofficial** public web API. The per-event endpoint (`/api/ng/factsCenter/event`) was written from memory of its shape and could not be called from the build sandbox. If it fails, the adapter falls back to the fixture list (core markets only) and the UI shows a notice. Verify against the live service on staging.
- Search reads up to 25 pages (2,500 games) within 30 days, using the total reported on page 1; games beyond that cap may not appear.
- The ticket page does not yet list or approve saved tickets (existing `GET /api/bet-instructions`, approve and cancel routes are ready for it).

## Live games
- Live games come from SportyBet's live feed (`/api/ng/factsCenter/liveOrPrematchEvents`, cached 5 s). It is unofficial and **could not be called from the build sandbox**; its response shape is handled tolerantly. If it fails, search still returns upcoming games and the UI says live games could not be loaded.
- An open live game shows a LIVE badge, score and clock, and refreshes its odds every 5 s while visible. Ticket selections keep the odds you tapped until you press Refresh odds or save.
- Saving: prematch odds must match exactly. For live selections the server also accepts **higher** current odds (never lower); the stake cap is recalculated at the verified odds and the saved ticket reports them.
- Bettable statuses are `not_started` and any in-play status; ended, closed, cancelled, abandoned, postponed and unknown are refused.
