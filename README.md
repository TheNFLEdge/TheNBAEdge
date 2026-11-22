# The NBA Edge

Daily NBA score projections and results, adapted from the NFL Edge's PanaGeoTech projection and issue-rotation design. Node.js 20 or newer is required. The classic-archive conversion tool uses the development dependency in `package-lock.json`; install it with `npm ci`.

## Site and classic archives

`index.html` is the NBA portal, `about.html` introduces the site's history and pilot, `disclaimer.html` explains the site's commentary, reporting and limitations, and `nba-template.htm` supplies the layout and four sponsor ads for new daily issues. Three are distributed through the games and the NFL Edge promotion follows the final game. On slates with more than 12 games, a PanaGeoTech placeholder appears in the footer. Short slates may have multiple ads in one gap. Older captured templates retain their previous layout. All use `nba.css` and the artwork in `images/`. The template is captured with each issue so its finalized archive retains the original presentation; later template edits do not rewrite previously generated issues.

The portal and archive landing page share a decorative basketball illustration; the 2026–27 archive index uses a decorative 109–98 scoreboard, and the disclaimer page features a stop-signaling referee. The basketball animation respects reduced-motion preferences. The NFL promotion is shared with the archive-index generators; static page copies should be kept in sync with `renderNflPromo` in `nba-publish.js`.

The archive landing page links to cleaned historical issues and records from 2011–2017, alongside newly generated daily archives. The 2012 material consists of an offseason page found outside the empty 2012 directory. Files are organized under `archives/<year>/`; historical commentary and records are not current performance claims. The copied originals in `archives/nbaedge/` remain local and are excluded by `.gitignore` because that directory contains unrelated material that must not be published.

The 2013–2016 season indexes highlight reported records from the recovered tables. The classic issues feature curated basketball selections informed by computer projections, while the current pilot publishes computer projections directly. The 2015 table reports 12–1 ATS (92.31%), and the 2016 table reports 19–2 winners (90.48%) and 18–3 ATS (85.71%).

`tools/build-classic-archives.js` rebuilds the public historical pages from those local originals. It takes year-prefixed NBA HTML issues and season records from the original directory and the 2013–2016 season directories, plus the identified 2012 and 2013 offseason pages; nested dumps, media, backups and other files are not included. It strips scripts, tracking and obsolete external links, replaces legacy image ads with `images/nbaedgeban.gif`, and links only to existing local issue pages. Historical 888poker ads link to the verified current official site without the old tracking parameters; availability varies by jurisdiction. Other legacy betting ads are not retained without a verified current destination. Review regenerated content and links before publishing. `nba-publish.js` generates the archive landing page during rotation, so changes to its historical links must also be reflected in the initial `archives/index.html`.

## Daily publication

The workflow in `.github/workflows/nba-daily.yml` attempts publication four times a day, every three hours at **02:34, 05:34, 08:34 and 11:34 Eastern**, using the America/New_York time zone. Subsequent attempts retry missed or failed updates. GitHub may delay or skip any or all scheduled runs, so these are targets, not delivery guarantees. The workflow can also be started manually on `main` at any time. It publishes only to `main` and uses a concurrency group shared with score updates. After tests pass, it commits and dispatches a Pages deployment for available final scores before attempting the new issue, so a failed or delayed projection update does not hold those scores back.

The previous `NBATMP.htm` remains accessible if the next update is delayed or fails. From 04:30 Eastern on the following day, `nba-viewport.js` displays a prominent notice that the page is dated and is not today's update; older pages receive the notice immediately. This also applies to an older no-games page. The check relies on JavaScript, the visitor's clock, and a working copy of the script; it does not change or delete published issues, and direct links to dated issues are unaffected. If the date check fails, the page remains accessible with a warning.

The score workflow targets hourly passes at 01:10 through 04:10 Eastern, allowing late games to finish. Each pass looks up unarchived issues through the current Eastern date, saves available finals, updates the currently displayed issue with individual grades and a summary, and archives an earlier issue once all its games are final. The original numbered issue remains the immutable prediction snapshot; the finalized archive has the results. A score-only pass never generates a new issue or replaces a newer viewport with an older one. GitHub may delay or skip scheduled runs; daily publication attempts also retry pending scores.

For the current Eastern calendar date, the program:

1. Checks each earlier unarchived issue by ESPN event ID. Final scores are recorded as they become available. An issue is archived only when **every** game is final; postponed or unfinished issues stay pending without blocking today's publication. A transient score-lookup failure emits a warning and leaves the affected game pending; malformed or mismatched score data fails the run.
2. Fetches today's ESPN NBA scoreboard and selects not-yet-started regular-season and postseason games with an Eastern game date of today. A manual run after games have started does not retrospectively make predictions for those games.
3. Fetches each team's most recent four completed regular-season or postseason games, including the preceding season when needed. It records the four-game win/loss record, points scored and points allowed, along with the season record reported by ESPN. If fewer than four games are available, the projection is pending rather than estimated.
4. Captures ESPN's available spread and over/under. If no lines are available anywhere on the slate, an optional Odds API key supplies a fallback. Otherwise, individual missing lines are not looked up and are shown as TBD; no line is invented. A transient fallback-provider failure logs a warning and publishes with TBD lines.
5. Writes a numbered canonical issue, `NBATMP.htm` as its viewport, and `nba_rotation_state.json`. If there are no upcoming games, the viewport shows the picks-unavailable page and no issue number is consumed. It distinguishes a day with no scheduled games from a late run after games have started. A repeat run on a date with an issue preserves the original predictions and lines, including any finals already recorded in the viewport.

The NBA season is assigned by its start year: July 2026 through June 2027 uses season `2026`. Issue numbers restart each season. For example, the first issue is `nba26-001.html`; its finalized copy is `archives/2026/nba26-001.html`. The season index at `archives/2026/index.html` lists each completed issue, winner/against-the-spread/over-under wins-losses-pushes, and season totals. Winner and against-the-spread season percentages are wins divided by wins plus losses, excluding pushes; with no decisions they show N/A. `archives/index.html` links to the available seasons. A push in either the projected or actual result is a push. Games with missing projections or missing lines are excluded from the applicable totals.

Issues and season indexes show one against-the-spread record using the displayed comparison spread. If the captured spread is a whole number, this comparison moves it half a point toward the projected spread pick; if the projection is exactly on the spread, it favors the projected outright winner. Half-point lines are unchanged. The original captured line remains in the ledger. Comparison spreads may differ from available betting lines.

On each final-score line, W or L reflects the outright winner prediction. A bold green W means the winner and favorable spread comparison were both correct; if the winner prediction lost but the spread comparison was correct, bold green COVER appears instead. A green (O) or (U) appears only when the corresponding total prediction was correct. Pushes and unavailable predictions or lines do not receive a winning indicator; aggregate records remain separate. A compact legend appears below season archive tables and after the games in archived issues.

`nba_rotation_state.json` is the authoritative ledger. Numbered root issues preserve the original published snapshot; the finalized archive is a separate copy. Both are checksum-validated on later runs. The viewport is not the source of truth. Do not delete the ledger or edit numbered issues or archives by hand: restore the matching files and ledger from Git history if a checksum fails. To apply a presentation or grading update to existing finalized issues, `node nba-daily.js --refresh-results` validates checksums first and regenerates archives and their hashes without changing the original projections or lines. A manual `NBA Daily Update` dispatch can refresh today's unarchived issue presentation without changing projections or lines, or explicitly rebuild its projections from stored team-stat snapshots and configured repository secrets. A projection rebuild is permitted only before any game starts and refuses to run if a projection secret is missing. A missing ledger with existing issues is rejected rather than silently starting over. ESPN event IDs are retained so games postponed to a different date can still be resolved. If ESPN never marks a game final, that issue remains pending and needs an explicit operational review; it is not silently discarded.

## Projection model

The Projection model is based on the PanaGeoTech NFL Edge Score Projection model built and Copyrighted (c) PanaGeoTech Inc. 1998, 1999, 2000-2026 All rights reserved. 

## Configuration and deployment

ESPN's public NBA endpoints require no key. The only optional betting-data integration is The Odds API's `basketball_nba` market, using the existing `ODDS_API_KEY` secret name. It is consulted only when ESPN provides no lines for the entire slate; network or HTTP failures are warned about and leave lines TBD, while malformed responses still fail the update. The NFL's API-Sports and Highlightly integrations are not configured here.

Secrets are repository-specific unless supplied by an organization. `NBA_ESPN_BASE_URL` and `ODDS_BASE_URL` can override provider base URLs. The workflow does not set these overrides.

## Local commands

```text
npm test
npm run daily
node nba-daily.js --scores-only
```

Both update commands perform real provider requests and change the working tree. Run the daily command only when ready to create or rotate an issue for the actual current date; the score-only command updates existing results without creating today's issue. To inspect the output without changing this checkout, run it from a separate disposable clone. Schedule and history are provider-dependent; NBA game postponements, ESPN availability, late GitHub starts, and missing lines affect what can be published. Projections are informational and for entertainment only.
