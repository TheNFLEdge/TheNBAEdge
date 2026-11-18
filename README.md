# The NBA Edge

Daily NBA score projections and results, adapted from the NFL Edge's PanaGeoTech projection and issue-rotation design. Node.js 20 or newer is required. The classic-archive conversion tool uses the development dependency in `package-lock.json`; install it with `npm ci`.

## Site and classic archives

`index.html` is the NBA portal, `about.html` introduces the site's history and pilot, `disclaimer.html` explains the site's commentary, reporting and limitations, and `nba-template.htm` supplies the layout and the three sponsor ads for new daily issues. All use `nba.css` and the artwork in `images/`. The template is captured with each issue so its finalized archive retains the original presentation; later template edits do not rewrite previously generated issues.

The archive landing page links to cleaned historical issues and records from 2011–2017, alongside newly generated daily archives. The 2012 material consists of an offseason page found outside the empty 2012 directory. Files are organized under `archives/<year>/`; historical commentary and records are not current performance claims. The copied originals in `archives/nbaedge/` remain local and are excluded by `.gitignore` because that directory contains unrelated material that must not be published.

The 2013–2016 season indexes summarize reported records and link to their underlying tables, including known conflicts and missing or mismatched issues. The 2015 table reports 12–1 ATS (92.31%) over four issues, but the surviving issue #3 link points to a different-year page and an alternate includes a college game and incomplete scores. Treat this as a historical report, not a verified NBA-only rate or performance of the automated pilot. The 2016 table's 19–2 winner total includes March Madness games.

`tools/build-classic-archives.js` rebuilds the public historical pages from those local originals. It takes year-prefixed NBA HTML issues and season records from the original directory and the 2013–2016 season directories, plus the identified 2012 and 2013 offseason pages; nested dumps, media, backups and other files are not included. It strips scripts, tracking and obsolete external links, replaces legacy image ads with `images/nbaedgeban.gif`, and links only to existing local issue pages. Historical 888poker ads link to the verified current official site without the old tracking parameters; availability varies by jurisdiction. Other legacy betting ads are not retained without a verified current destination. Review regenerated content and links before publishing. `nba-publish.js` generates the archive landing page during rotation, so changes to its historical links must also be reflected in the initial `archives/index.html`.

## Daily publication

The workflow in `.github/workflows/nba-daily.yml` targets **04:41 America/New_York** every day. GitHub schedules are UTC, so two cron entries cover standard and daylight time; the program runs only the entry corresponding to 04:41 Eastern. GitHub may delay or skip scheduled runs, so 04:41 is a target, not a delivery guarantee. The workflow can also be started manually on `main` at any time. It publishes only to `main`, uses a concurrency group, and commits only after tests and the update succeed.

When a visitor opens `NBATMP.htm`, `nba-viewport.js` compares its issue date with the visitor's current Eastern date and routes an older viewport to `nba-unavailable.html`, which links to the archives. This also covers skipped runs and takes effect at Eastern midnight, including before the scheduled update. Current-day no-game messages remain visible. The check relies on JavaScript, the visitor's clock, and a working copy of the script; it does not change or delete published issues, and direct links to dated issues are unaffected.

For the current Eastern calendar date, the program:

1. Checks each earlier unarchived issue by ESPN event ID. Final scores are recorded as they become available. An issue is archived only when **every** game is final; postponed or unfinished issues stay pending without blocking today's publication. A transient score-lookup failure emits a warning and leaves the affected game pending; malformed or mismatched score data fails the run.
2. Fetches today's ESPN NBA scoreboard and selects not-yet-started regular-season and postseason games with an Eastern game date of today. A manual run after games have started does not retrospectively make predictions for those games.
3. Fetches each team's most recent four completed regular-season or postseason games, including the preceding season when needed. It records the four-game win/loss record, points scored and points allowed, along with the season record reported by ESPN. If fewer than four games are available, the projection is pending rather than estimated.
4. Captures ESPN's available spread and over/under. An optional Odds API key supplies missing lines. Missing lines remain unavailable; no line is invented.
5. Writes a numbered canonical issue, `NBATMP.htm` as its viewport, and `nba_rotation_state.json`. If there are no upcoming games, the viewport says so and no issue number is consumed. A repeat run on a date with an issue preserves the original predictions and lines and restores the viewport from that canonical issue.

The NBA season is assigned by its start year: July 2026 through June 2027 uses season `2026`. Issue numbers restart each season. For example, the first issue is `nba26-001.html`; its finalized copy is `archives/2026/nba26-001.html`. The season index at `archives/2026/index.html` lists each completed issue, winner/against-the-spread/over-under wins-losses-pushes, and season totals. `archives/index.html` links to the available seasons. A push in either the projected or actual result is a push. Games with missing projections or missing lines are excluded from the applicable totals.

`nba_rotation_state.json` is the authoritative ledger. Numbered root issues preserve the original published snapshot; the finalized archive is a separate copy. Both are checksum-validated on later runs. The viewport is not the source of truth. Do not delete the ledger or edit numbered issues or archives by hand: restore the matching files and ledger from Git history if a checksum fails. A missing ledger with existing issues is rejected rather than silently starting over. ESPN event IDs are retained so games postponed to a different date can still be resolved. If ESPN never marks a game final, that issue remains pending and needs an explicit operational review; it is not silently discarded.

## Projection model

For each team, the NFL formula divides its four-game points-for sum and the opponent's points-allowed sum by 16 quarters, adds the two figures, and multiplies by a confidence factor based on the team's four-game winning percentage. The default buckets and multipliers are:

| Winning percentage | Bucket | Multiplier |
| --- | --- | --- |
| at least 80% | 1.0 | 2.4 |
| at least 60% | 0.75 | 2.2 |
| at least 40% | 0.5 | 2.0 |
| at least 20% | 0.25 | 1.66 |
| below 20% | 0.0 | 1.5 |

As in `nfl-projection.py`, high buckets add 2 and round up; low buckets subtract 2 and round down; the middle bucket uses Python-style ties-to-even rounding. Negative scores are clamped to zero. If both rounded scores tie, the higher raw projection receives one point, with the home team winning an exact raw tie. The NFL-only impossible-football-score adjustment is not applied to basketball.

## Configuration and deployment

ESPN's public NBA endpoints require no key. The only optional betting-data integration is The Odds API's `basketball_nba` market, using the existing `ODDS_API_KEY` secret name. If configured and needed for missing lines, an Odds API request failure fails the update rather than presenting it as successful. The NFL's API-Sports and Highlightly integrations are not configured here.

Optional GitHub Actions secrets, with NFL-compatible names:

| Secret | Default |
| --- | --- |
| `ODDS_API_KEY` | unset; ESPN lines only |
| `PG_PI0` | 2.4 |
| `PG_PI7` | 2.2 |
| `PG_PPI5` | 2.0 |
| `PG_PI2` | 1.66 |
| `PG_PI_X` | 1.5 |
| `PG_MD` | 2.0 |

Secrets are repository-specific unless supplied by an organization. Configure them in this repository's GitHub settings if desired; do not commit keys. For local testing, `NBA_ESPN_BASE_URL` and `ODDS_BASE_URL` can override provider base URLs. The workflow does not set these overrides.

Before deploying, review and commit these files, push them to `main`, enable GitHub Actions with workflow read/write permissions, and ensure any branch protection permits the workflow's push. For the website, configure GitHub Pages with **GitHub Actions** as its source. `.github/workflows/deploy-pages.yml` deploys the latest `main` after a push and after a successful daily workflow; this is necessary because a push made with `GITHUB_TOKEN` does not itself trigger another push workflow. A manual workflow dispatch is useful for the initial issue; if the run occurs after games start, only still-upcoming games are included. The initial viewport is a placeholder until the first run. This repository does not automatically copy secrets or Pages settings from the NFL repository.

## Local commands

```text
npm test
npm run daily
```

`npm run daily` performs real provider requests and changes the working tree; run it only when ready to create or rotate an issue for the actual current date. To inspect the output without changing this checkout, run it from a separate disposable clone. Schedule and history are provider-dependent; NBA game postponements, ESPN availability, late GitHub starts, and missing lines affect what can be published. Projections are informational and for entertainment only.
