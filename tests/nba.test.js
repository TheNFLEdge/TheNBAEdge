'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const data = require('../nba-data');
const daily = require('../nba-daily');
const model = require('../nba-projection');
const publish = require('../nba-publish');

function competitor(id, side, score) {
    return {
        id, homeAway: side, score, team: { abbreviation: id, displayName: `${id} Team` },
        records: [{ type: 'total', summary: '10-5' }]
    };
}

function event(id, date, completed, awayScore = 100, homeScore = 110) {
    return {
        id, date, season: { type: 2 },
        competitions: [{
            id, status: { type: { completed, state: completed ? 'post' : 'pre' } },
            competitors: [competitor('A', 'away', awayScore), competitor('H', 'home', homeScore)],
            odds: [{ details: 'H -3.5', overUnder: 210.5, provider: { name: 'Book' } }]
        }]
    };
}

function temporaryRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-edge-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.copyFileSync(path.join(__dirname, '..', 'nba-template.htm'), path.join(root, 'nba-template.htm'));
    fs.copyFileSync(path.join(__dirname, '..', 'nba-unavailable.html'), path.join(root, 'nba-unavailable.html'));
    return root;
}

test('model uses NFL buckets, quarter averages, rounding and NBA tie resolution', () => {
    const stats = { gp: 4, wins: 3, pf_sum: 440, pa_sum: 400 };
    const opponent = { gp: 4, wins: 1, pf_sum: 400, pa_sum: 440 };
    assert.equal(model.bucket(3, 4), '0.75');
    assert.deepEqual(model.projectMatchup(stats, opponent, model.modelConfig({})), { away: 124, home: 81 });
    assert.deepEqual(model.projectMatchup(stats, stats, model.modelConfig({})), { away: 118, home: 119 });
    assert.equal(model.roundEven(2.5), 2);
    assert.equal(model.roundEven(3.5), 4);
    assert.equal(model.projectMatchup({ gp: 3 }, opponent, model.modelConfig({})), null);
    assert.throws(() => model.modelConfig({ PG_MD: 'nope' }), /Invalid PG_MD/);
    assert.equal(model.modelConfig({}).usesFallback, true);
    const configured = { PG_PI0: '3', PG_PI7: '3', PG_PPI5: '3', PG_PI2: '3', PG_PI_X: '3', PG_MD: '3' };
    assert.equal(model.modelConfig(configured).usesFallback, false);
    assert.equal(model.modelConfig({ ...configured, PG_PI2: '' }).usesFallback, true);
});

test('rounded score ties follow even tiny raw differences, with an exact tie favoring home', () => {
    const config = model.modelConfig({ PG_PPI5: '0.0016', PG_MD: '0' });
    const low = { gp: 4, wins: 2, pf_sum: 0, pa_sum: 0 };
    const high = { ...low, pf_sum: 1 };
    assert.ok(model.rawScore(high, low, config).score - model.rawScore(low, high, config).score > 0);
    assert.deepEqual(model.projectMatchup(high, low, config), { away: 1, home: 0 });
    assert.deepEqual(model.projectMatchup(low, high, config), { away: 0, home: 1 });
    assert.deepEqual(model.projectMatchup(low, low, config), { away: 0, home: 1 });
});

test('rolling history takes last four distinct final games before cutoff', () => {
    const games = [
        event('1', '2026-10-01T00:00:00Z', true, 100, 110),
        event('2', '2026-10-03T00:00:00Z', true, 120, 110),
        event('3', '2026-10-04T00:00:00Z', true, 111, 110),
        event('4', '2026-10-05T00:00:00Z', true, 90, 110),
        event('5', '2026-10-06T00:00:00Z', true, 115, 110),
        event('6', '2026-10-07T00:00:00Z', false),
        event('7', '2026-10-09T00:00:00Z', true)
    ];
    const stats = data.rollingStats([...games, games[4]], 'A', Date.parse('2026-10-08T00:00:00Z'));
    assert.deepEqual(stats, { gp: 4, wins: 3, losses: 1, pf_sum: 436, pa_sum: 440, game_ids: ['5', '4', '3', '2'] });
});

test('ESPN lines are interpreted as home handicap and missing data is not zero', () => {
    assert.deepEqual(data.parseMatchup(event('1', '2026-11-16T00:00:00Z', false)).odds,
        { spread: -3.5, total: 210.5, source: 'Book' });
    const e = event('1', '2026-11-16T00:00:00Z', false);
    e.competitions[0].odds = [{ details: 'A -4.5', overUnder: null }];
    assert.deepEqual(data.parseMatchup(e).odds, { spread: 4.5, total: null, source: 'ESPN' });
    e.competitions[0].odds = [];
    assert.deepEqual(data.parseMatchup(e).odds, { spread: null, total: null, source: null });
    e.competitions[0].odds = [{ details: 'PK', overUnder: 0 }];
    assert.deepEqual(data.parseMatchup(e).odds, { spread: 0, total: 0, source: 'ESPN' });
});

test('partial slates skip the odds lookup; an entirely missing slate uses a nonblocking fallback', async t => {
    const originalFetch = global.fetch;
    const originalWarn = console.warn;
    t.after(() => { global.fetch = originalFetch; console.warn = originalWarn; });
    const warnings = [];
    console.warn = message => warnings.push(message);
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('network unavailable'); };
    const partial = [
        { odds: { spread: -3.5, total: null } },
        { odds: { spread: null, total: null } }
    ];
    await data.mergeOdds(partial, 'key');
    assert.equal(calls, 0);
    assert.deepEqual(partial[1].odds, { spread: null, total: null });
    const missing = [{ odds: { spread: null, total: null } }];
    await data.mergeOdds(missing, 'key');
    assert.equal(calls, 1);
    assert.deepEqual(missing[0].odds, { spread: null, total: null });
    assert.match(warnings[0], /publishing with TBD lines/);

    global.fetch = async () => ({ ok: true, json: async () => [{
        away_team: 'Away', home_team: 'Home', commence_time: '2026-11-20T23:00:00Z',
        bookmakers: [{ title: 'Book', markets: [
            { key: 'spreads', outcomes: [{ name: 'Home', point: -4.5 }] },
            { key: 'totals', outcomes: [{ name: 'Over', point: 220.5 }] }
        ] }]
    }] });
    const game = { date: '2026-11-20T23:00:00Z', away: { name: 'Away' }, home: { name: 'Home' }, odds: { spread: null, total: null, source: null } };
    await data.mergeOdds([game], 'key');
    assert.deepEqual(game.odds, { spread: -4.5, total: 220.5, source: 'Book' });
    global.fetch = async () => ({ ok: true, json: async () => ({}) });
    await assert.rejects(data.mergeOdds(missing, 'key'), /not an array/);
});

test('issue template intersperses all three ads and resolves artwork for current and archived issues', () => {
    const root = path.join(__dirname, '..');
    const template = fs.readFileSync(path.join(root, 'nba-template.htm'), 'utf8');
    const game = {
        id: '1', away: { name: 'Away', abbreviation: 'A' }, home: { name: 'Home', abbreviation: 'H' },
        odds: { spread: null, total: null }, projection: null, final: null
    };
    const issue = { date: '2026-11-15', number: 1, season: 2026, games: [game, { ...game, id: '2' }] };
    for (const prefix of ['', '../../']) {
        const html = publish.renderIssue(template, issue, prefix);
        assert.match(html, /Liberty Mutual advertisement/);
        assert.match(html, /PRO Properties Group advertisement/);
        assert.match(html, /Greggy Feesh and the Phlops advertisement/);
        assert.ok(html.includes(`src="${prefix}images/banner.jpg"`));
        assert.ok(html.includes(`src="${prefix}images/gfish-promo-ad.jpg"`));
        assert.ok(html.includes(`href="${prefix}NBATMP.htm"`));
        assert.ok(html.includes(`href="${prefix}disclaimer.html"`));
        assert.ok(html.includes(`src="${prefix}nba-viewport.js" data-date="2026-11-15" data-fallback="${prefix}nba-unavailable.html"`));
        assert.ok(!html.includes('{{ROOT}}'));
    }
});

test('ads are distributed between game cards for varying slate sizes', () => {
    const template = fs.readFileSync(path.join(__dirname, '..', 'nba-template.htm'), 'utf8');
    const game = {
        away: { name: 'Away', abbreviation: 'A' }, home: { name: 'Home', abbreviation: 'H' },
        odds: { spread: null, total: null }, projection: null, final: null
    };
    for (const count of [1, 2, 3, 5, 11, 12, 13, 15]) {
        const games = Array.from({ length: count }, (_, index) => ({ ...game, id: String(index + 1) }));
        const html = publish.renderIssue(template, { date: '2026-11-15', number: 1, season: 2026, games });
        const items = [...html.matchAll(/class="game-card" data-game-id="(\d+)"|class="sponsor sponsor-(liberty|property|feesh)"/g)]
            .map(match => match[1] ? `game-${match[1]}` : match[2]);
        assert.deepEqual(items.filter(item => item.startsWith('game-')), games.map(item => `game-${item.id}`));
        assert.deepEqual(items.filter(item => !item.startsWith('game-')), ['liberty', 'property', 'feesh']);
        assert.equal(items[0], 'game-1');
        if (count > 1) assert.equal(items.at(-1), `game-${count}`);
        if (count === 2) assert.equal(items[1], 'liberty');
        if (count === 12) {
            assert.deepEqual(items.map((item, index) => !item.startsWith('game-') ? index : -1).filter(index => index >= 0), [3, 7, 11]);
        }
        assert.doesNotMatch(html, /SPONSOR-(DEFINITIONS|START|END)/);
    }
    assert.throws(() => publish.renderIssue(template.replace('<!-- SPONSOR-END -->', ''), {
        date: '2026-11-15', number: 1, season: 2026, games: [game]
    }), /Invalid NBA sponsor/);
});

test('legacy issue templates retain their original sponsor layout', () => {
    const template = '<!-- GAME-CARDS --><section>Original sponsors</section>';
    const game = {
        id: '1', away: { name: 'Away', abbreviation: 'A' }, home: { name: 'Home', abbreviation: 'H' },
        odds: { spread: null, total: null }, projection: null, final: null
    };
    assert.match(publish.renderIssue(template, { date: '2026-11-15', number: 1, season: 2026, games: [game] }),
        /<\/article>\s*<section>Original sponsors<\/section>/);
    const root = path.join(__dirname, '..');
    const archived = daily.readState(root).issues.find(issue => issue.archived);
    assert.equal(publish.hash(publish.renderIssue(archived.template, archived, '../../')), archived.archive_hash);
});

test('game cards present matchup, home line and scores without exposing model inputs or line source', () => {
    const root = path.join(__dirname, '..');
    const template = fs.readFileSync(path.join(root, 'nba-template.htm'), 'utf8');
    const game = {
        id: '1', away: { name: 'Chicago Bulls', abbreviation: 'CHI', record: '10-5', stats: { gp: 4, pf_sum: 440, pa_sum: 420 } },
        home: { name: 'Brooklyn Nets', abbreviation: 'BKN', record: '8-7', stats: { gp: 4, pf_sum: 420, pa_sum: 440 } },
        odds: { spread: -2.5, total: 220.5, source: 'Example Book' },
        projection: { away: 123, home: 95 }, final: null
    };
    const issue = { date: '2026-11-18', number: 1, season: 2026, games: [game] };
    const render = () => publish.renderIssue(template, issue);
    let html = render();
    assert.match(html, /Chicago Bulls at Brooklyn Nets/);
    assert.match(html, /BKN -2\.5 &nbsp; \| &nbsp; O\/U: 220\.5/);
    assert.match(html, /The \(10-5\) Chicago Bulls head into \(8-7\) Brooklyn Nets, where the home team is a 2\.5-point favorite and the total has been set for 220\.5\./);
    assert.match(html, /Projected Score:<\/strong> CHI 123 - BKN 95/);
    assert.match(html, /Final Score:<\/strong> TBD/);
    assert.doesNotMatch(html, /Our computer projects|Example Book|Game 1:|last four|440 scored|<table>/i);
    game.odds.spread = 3.5;
    html = render();
    assert.match(html, /BKN \+3\.5/);
    assert.match(html, /home team is a 3\.5-point underdog and the total has been set for 220\.5/);
    game.odds = { spread: 0, total: null, source: null };
    game.projection = null;
    game.final = { away: 100, home: 110 };
    html = render();
    assert.match(html, /Comparison spread: BKN 0 &nbsp; \| &nbsp; O\/U: TBD/);
    assert.match(html, /pick&#39;em matchup and the total is TBD\./);
    assert.match(html, /Projected Score:<\/strong> TBD/);
    assert.match(html, /Final Score:<\/strong> CHI 100 - BKN 110/);
    game.odds.spread = null;
    game.away.record = null;
    game.home.record = null;
    assert.match(render(), /The Chicago Bulls head into Brooklyn Nets, where the point spread is TBD and the total is TBD\./);
    game.odds.total = 220.5;
    assert.match(render(), /point spread is TBD and the total has been set for 220\.5\./);
    game.odds.spread = -2.5;
    game.odds.total = null;
    assert.match(render(), /2\.5-point favorite and the total is TBD\./);
});

test('final score indicators distinguish winners, covers and correct totals', () => {
    const make = (projection, final, spread, total) => ({
        id: '1', away: { name: 'Away', abbreviation: 'A' }, home: { name: 'Home', abbreviation: 'H' },
        projection, final, odds: { spread, total }
    });
    const render = game => publish.renderIssue('<!-- GAME-CARDS -->', { games: [game], date: '2026-11-18', number: 1, season: 2026 });
    let html = render(make({ away: 127, home: 143 }, { away: 121, home: 116 }, 1.5, 222.5));
    assert.match(html, /Final Score:<\/strong> A 121 - H 116 <span aria-label="Winner incorrect">L<\/span> <strong class="result-win" aria-label="Over correct">\(O\)<\/strong>/);
    assert.doesNotMatch(html, /<p>Results:/);
    html = render(make({ away: 78, home: 148 }, { away: 130, home: 137 }, -12.5, 236.5));
    assert.match(html, /H 137 <span aria-label="Winner correct">W<\/span><\/p>/);
    html = render(make({ away: 134, home: 117 }, { away: 119, home: 104 }, 6.5, 224.5));
    assert.match(html, /H 104 <strong class="result-win" aria-label="Winner and spread prediction correct">W<\/strong><\/p>/);
    html = render(make({ away: 100, home: 106 }, { away: 105, home: 103 }, -10, 220));
    assert.match(html, /H 103 <strong class="result-win" aria-label="Winner incorrect, spread prediction correct">COVER<\/strong> <strong class="result-win" aria-label="Under correct">\(U\)<\/strong>/);
    html = render(make({ away: 100, home: 106 }, { away: 100, home: 103 }, -10, 220));
    assert.match(html, /H 103 <strong class="result-win" aria-label="Winner and spread prediction correct">W<\/strong>/);
    html = render(make({ away: 100, home: 106 }, { away: 100, home: 106 }, -6, 206));
    assert.match(html, /H 106 <strong class="result-win" aria-label="Winner and spread prediction correct">W<\/strong><\/p>/);
    html = render(make({ away: 100, home: 106 }, { away: 100, home: 106 }, null, null));
    assert.match(html, /H 106 <span aria-label="Winner correct">W<\/span><\/p>/);
    html = render(make(null, { away: 100, home: 106 }, -6, 206));
    assert.match(html, /Final Score:<\/strong> A 100 - H 106<\/p>/);
    html = render(make({ away: 100, home: 106 }, null, -6, 206));
    assert.match(html, /Final Score:<\/strong> TBD<\/p>/);
    assert.doesNotMatch(html, /aria-label="Winner|aria-label="Over|aria-label="Under/);
});

test('public issue and season records use the displayed comparison spread only', () => {
    const game = {
        id: '1', away: { name: 'Away', abbreviation: 'A' }, home: { name: 'Home', abbreviation: 'H' },
        projection: { away: 100, home: 106 }, final: { away: 100, home: 106 },
        odds: { spread: -6, total: 210 }
    };
    const issue = { games: [game], date: '2026-11-18', number: 1, season: 2026, archived: true };
    const html = publish.renderIssue('<!-- GAME-CARDS -->', issue);
    assert.match(html, /Comparison spread: H -5\.5/);
    assert.match(html, /Against the spread: 1-0-0/);
    assert.doesNotMatch(html, /favorable|original|hypothetical/i);
    const index = publish.renderSeasonIndex(2026, [issue]);
    assert.match(index, /<table class="season-table"><thead><tr>/);
    assert.match(index, /<th>Against<br>the&nbsp;spread<\/th>/);
    assert.match(index, /Issue 1\)<\/a><\/td><td>1-0-0\?<\/td><td><\/td><td>1-0-0\?<\/td>/);
    assert.doesNotMatch(index, /favorable|original|hypothetical/i);
});

test('outdated viewport stays accessible with a date warning, including DST', () => {
    const root = path.join(__dirname, '..');
    const script = fs.readFileSync(path.join(root, 'nba-viewport.js'), 'utf8');
    function check(pathname, issueDate, instant, intl = Intl) {
        let redirected = null;
        let scheduled;
        let notice;
        let ready;
        const document = {
            currentScript: { dataset: { date: issueDate, fallback: 'nba-unavailable.html' } },
            readyState: 'loading',
            addEventListener: (eventName, callback) => {
                assert.equal(eventName, 'DOMContentLoaded');
                ready = callback;
            },
            getElementById: () => notice,
            createElement: () => ({ setAttribute: (name, value) => { assert.equal(`${name}=${value}`, 'role=status'); } }),
            querySelector: selector => {
                assert.equal(selector, 'main');
                return { prepend: element => { notice = element; } };
            }
        };
        const clock = class extends Date {
            constructor(...args) { super(...(args.length ? args : [instant])); }
        };
        const window = {
            location: { pathname, replace: url => { redirected = url; } },
            setInterval: (callback, delay) => { scheduled = { callback, delay }; }
        };
        vm.runInNewContext(script, {
            window, document, Date: clock, Intl: intl, console: { error() {} }
        });
        if (ready) ready();
        document.readyState = 'complete';
        return { redirected, scheduled, notice };
    }
    assert.equal(check('/NBATMP.htm', '2026-11-15', '2026-11-16T05:00:00Z').notice, undefined);
    assert.equal(check('/NBATMP.htm', '2026-11-15', '2026-11-16T09:29:00Z').notice, undefined);
    const stale = check('/NBATMP.htm', '2026-11-15', '2026-11-16T09:30:00Z');
    assert.equal(stale.redirected, null);
    assert.match(stale.notice.textContent, /2026-11-15.*not today's update/);
    assert.equal(stale.notice.className, 'viewport-date-notice');
    assert.equal(stale.scheduled.delay, 60000);
    stale.scheduled.callback();
    assert.match(stale.notice.textContent, /2026-11-15.*not today's update/);
    assert.equal(check('/NBATMP.htm', '2026-07-01', '2026-07-02T08:29:00Z').notice, undefined);
    assert.match(check('/NBATMP.htm', '2026-07-01', '2026-07-02T08:30:00Z').notice.textContent, /not today's update/);
    assert.match(check('/NBATMP.htm', '2026-11-14', '2026-11-16T05:01:00Z').notice.textContent, /not today's update/);
    assert.equal(check('/NBATMP.htm', '2026-11-16', '2026-11-16T10:00:00Z').notice, undefined);
    assert.match(check('/NBATMP.htm', '2026-11-17', '2026-11-16T10:00:00Z').notice.textContent, /check your device/);
    assert.match(check('/NBATMP.htm', 'invalid', '2026-11-16T10:00:00Z').notice.textContent, /missing or invalid/);
    const brokenIntl = { DateTimeFormat: class { constructor() { throw new Error('unsupported timezone'); } } };
    assert.match(check('/NBATMP.htm', '2026-11-15', '2026-11-16T10:00:00Z', brokenIntl).notice.textContent, /Unable to verify.*2026-11-15/);
    assert.equal(check('/nba26-001.html', '2026-11-15', '2026-11-16T05:00:00Z').notice, undefined);
    assert.equal(check('/archives/2026/nba26-001.html', '2026-11-15', '2026-11-16T05:00:00Z').notice, undefined);
    assert.ok(fs.existsSync(path.join(root, 'images', 'under-construction.gif')));
    const fallback = fs.readFileSync(path.join(root, 'nba-unavailable.html'), 'utf8');
    assert.match(fallback, /href="archives\/index\.html"/);
    assert.match(fallback, /src="images\/under-construction\.gif"/);
});

test('daily workflow schedules four publication attempts three hours apart', () => {
    const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'nba-daily.yml'), 'utf8');
    assert.match(workflow, /cron: '41 9-18\/3 \* \* \*'/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /rebuild_today:/);
    assert.match(workflow, /refresh_today_presentation:/);
    assert.match(workflow, /group: nba-daily-publication/);
});

test('Greggy Feesh Thanksgiving sponsor matches the NFL seasonal banner', () => {
    const template = fs.readFileSync(path.join(__dirname, '..', 'nba-template.htm'), 'utf8');
    const game = data.parseMatchup(event('seasonal-ad', '2026-11-19T23:00:00Z', false));
    const renderDate = date => publish.renderIssue(template, {
        date, season: 2026, number: 1, games: [game]
    }, '../../');

    const seasonal = renderDate('2026-11-19');
    assert.match(seasonal, /src="\.\.\/\.\.\/images\/gfeesh-thanksgiving-ad\.jpg"/);
    assert.match(seasonal, /Pumpkin Pie \(feat\. G Pan\)/);
    assert.match(seasonal, /The Thanksgiving/);
    assert.match(seasonal, /background:#f28b21/);
    assert.match(seasonal, /background:#e46aff/);
    assert.match(seasonal, /height:clamp\(210px, 27vw, 250px\)/);
    assert.match(seasonal, /object-position:center 40%; display:block; margin:0 auto;/);
    assert.match(renderDate('2026-11-30'), /gfeesh-thanksgiving-ad\.jpg/);
    const regular = renderDate('2026-12-01');
    const regularSponsor = regular.match(/<article class="sponsor sponsor-feesh"[\s\S]*?<\/article>/)?.[0];
    assert.ok(regularSponsor);
    assert.match(regularSponsor, /gfish-promo-ad\.jpg/);
    assert.doesNotMatch(regular, /Pumpkin Pie \(feat\. G Pan\)/);
    assert.match(regularSponsor, /Tired of swimming in the same old waves\?/);
    assert.match(regularSponsor, /position:relative;top:12px;z-index:1;margin:0 0 -5px/);
    assert.match(regularSponsor, /Catch the latest/);
    assert.match(regularSponsor, /FRESH FEESH/);
    assert.match(regularSponsor, /Greggy FEESH and the Phlops/);
    assert.match(regularSponsor, /href="https:\/\/open\.spotify\.com\/artist\/6fa6DV6wh6WscR3R7fWAyI"/);
    assert.match(regularSponsor, /max-height:250px/);
    assert.match(regularSponsor, /position:relative;width:100%;margin:0 auto/);
    assert.match(regularSponsor, /width:min\(100%, 500px\);height:auto/);
    assert.match(regularSponsor, /top:75%/);
    assert.match(regularSponsor, /background:rgba\(15,11,34,\.55\)/);
    assert.match(regularSponsor, /position:relative;top:-20px;padding:8px;background:rgba\(15,11,34,\.9\);color:#fff86a/);
    assert.match(regularSponsor, /Listen to Greggy FEESH and the Phlops on <strong style="color:#1db954;">Spotify<\/strong> &rarr;/);
    assert.match(regularSponsor, /style="padding:0;background:#fff;border-color:#fff"/);
    assert.doesNotMatch(regularSponsor, /sponsor-label|Advertisement/);
});

test('overnight score passes update the current viewport without altering predictions or creating a new issue', async t => {
    const root = temporaryRoot(t);
    const stats = { gp: 4, wins: 3, losses: 1, pf_sum: 440, pa_sum: 420 };
    const final = new Set();
    const provider = {
        scoreboard: async date => [event(`${date}-1`, `${date}T23:00:00Z`, false), event(`${date}-2`, `${date}T23:30:00Z`, false)],
        teamStats: async () => ({ ...stats }),
        mergeOdds: async () => {},
        finalScore: async game => final.has(game.id) ? { away: 100, home: 110 } : null
    };
    await daily.run({ root, now: new Date('2026-11-15T09:41:00Z'), provider, env: {} });
    const original = fs.readFileSync(path.join(root, 'nba26-001.html'), 'utf8');
    final.add('2026-11-15-1');
    await daily.run({ root, now: new Date('2026-11-16T06:10:00Z'), provider, env: {}, scoresOnly: true });
    let viewport = fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8');
    assert.match(viewport, /Final games: 1 of 2/);
    assert.match(viewport, /Final Score:<\/strong> A 100 - H 110/);
    assert.match(viewport, /Final Score:<\/strong> TBD/);
    assert.equal(fs.readFileSync(path.join(root, 'nba26-001.html'), 'utf8'), original);
    assert.equal(daily.readState(root).issues.length, 1);
    assert.ok(!fs.existsSync(path.join(root, 'archives', '2026', 'nba26-001.html')));
    final.add('2026-11-15-2');
    await daily.run({ root, now: new Date('2026-11-16T07:10:00Z'), provider, env: {}, scoresOnly: true });
    viewport = fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8');
    assert.match(viewport, /Final games: 2 of 2/);
    assert.match(viewport, /Winners: 2-0-0/);
    assert.ok(fs.existsSync(path.join(root, 'archives', '2026', 'nba26-001.html')));
    await daily.run({ root, now: new Date('2026-11-16T09:41:00Z'), provider, env: {} });
    const next = fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8');
    await daily.run({ root, now: new Date('2026-11-17T06:10:00Z'), provider, env: {}, scoresOnly: true });
    assert.equal(fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8'), next);
    assert.match(next, /2026-11-16 Picks/);
    assert.equal(daily.readState(root).issues.length, 2);
});

test('refreshing archived results preserves canonical predictions and validates checksums', async t => {
    const root = temporaryRoot(t);
    const stats = { gp: 4, wins: 3, losses: 1, pf_sum: 440, pa_sum: 420 };
    const provider = {
        scoreboard: async date => [event(date, `${date}T23:00:00Z`, false)],
        teamStats: async () => ({ ...stats }),
        mergeOdds: async () => {},
        finalScore: async () => ({ away: 100, home: 110 })
    };
    await daily.run({ root, now: new Date('2026-11-15T09:41:00Z'), provider, env: {} });
    const canonical = fs.readFileSync(path.join(root, 'nba26-001.html'), 'utf8');
    await daily.run({ root, now: new Date('2026-11-16T06:10:00Z'), provider, env: {}, scoresOnly: true });
    const archive = path.join(root, 'archives', '2026', 'nba26-001.html');
    daily.refreshResults(root);
    assert.equal(fs.readFileSync(path.join(root, 'nba26-001.html'), 'utf8'), canonical);
    assert.match(fs.readFileSync(archive, 'utf8'), /Final Score:<\/strong> A 100 - H 110/);
    assert.doesNotMatch(fs.readFileSync(archive, 'utf8'), /<p>Results:/);
    assert.match(fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8'), /Against the spread:/);
    assert.match(fs.readFileSync(path.join(root, 'archives', '2026', 'index.html'), 'utf8'), /Against<br>the&nbsp;spread<\/th>/);
    assert.equal(daily.readState(root).issues[0].archived, true);
    fs.appendFileSync(archive, 'tampering');
    assert.throws(() => daily.refreshResults(root), /checksum mismatch/);
});

test('disclaimer is linked from the portal, about page, and current viewport', () => {
    const root = path.join(__dirname, '..');
    const disclaimer = fs.readFileSync(path.join(root, 'disclaimer.html'), 'utf8');
    assert.match(disclaimer, /First Amendment/);
    assert.match(disclaimer, /whether a particular use qualifies depends on the circumstances/i);
    assert.match(disclaimer, /actual final scores and compare them with our projections/);
    for (const name of ['index.html', 'about.html', 'NBATMP.htm', 'nba-unavailable.html']) {
        assert.match(fs.readFileSync(path.join(root, name), 'utf8'), /href="disclaimer\.html"/, name);
    }
    assert.match(fs.readFileSync(path.join(root, 'nba-template.htm'), 'utf8'), /href="\{\{ROOT\}\}disclaimer\.html"/);
});

test('generated archive index preserves local classic season links', () => {
    const root = path.join(__dirname, '..');
    const html = publish.renderArchivesIndex([{ season: 2026, archived: true }]);
    assert.match(html, /2026\/index\.html/);
    for (const href of ['2011/index.html', '2012/index.html', '2013/index.html', '2014/index.html',
        '2015/index.html', '2016/index.html', '2017/index.html']) {
        assert.ok(html.includes(`href="${href}"`), href);
        assert.ok(fs.existsSync(path.join(root, 'archives', ...href.split('/'))), href);
        assert.match(fs.readFileSync(path.join(root, 'archives', ...href.split('/')), 'utf8'), /href="\.\.\/\.\.\/disclaimer\.html"/);
    }
    assert.match(html, /href="\.\.\/disclaimer\.html"/);
    assert.match(require('../tools/build-classic-archives').seasonIndex('2013', []), /href="\.\.\/\.\.\/disclaimer\.html"/);
    assert.equal(fs.readFileSync(path.join(root, 'archives', 'index.html'), 'utf8'),
        publish.renderArchivesIndex(daily.readState(root).issues));
});

test('record summaries cite the original tables and distinguish pilot results', () => {
    const root = path.join(__dirname, '..');
    const table = fs.readFileSync(path.join(root, 'archives', '2015', 'nba15-arch.xhtml.html'), 'utf8');
    assert.match(table, /<p>A\.T\.S:<\/p><\/td><td><p>12<\/p><\/td><td><p>1<\/p><\/td><td><p>92\.31%<\/p>/);
    const alternate = fs.readFileSync(path.join(root, 'archives', '2015', 'nba15-03b.htm'), 'utf8');
    assert.match(alternate, /Akron at Buffalo/);
    const linked = fs.readFileSync(path.join(root, 'archives', '2015', 'nba15-03.htm'), 'utf8');
    assert.match(linked, /THE NBA EDGE: 2016/);
    const index = fs.readFileSync(path.join(root, 'archives', '2015', 'index.html'), 'utf8');
    assert.match(index, /12&ndash;1 ATS \(92\.31%\)/);
    assert.match(index, /not an independently verified NBA-only record/);
    const hero = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(hero, /92\.31%/);
    assert.match(hero, /class="hero-copy">Get the edge on today's NBA games/);
    assert.match(hero, /<h2>92\.31%[\s\S]*?92\.31% in the 2015 season/);
    assert.match(hero, /href="about\.html"/);
    const about = fs.readFileSync(path.join(root, 'about.html'), 'utf8');
    assert.match(about, /Chris &ldquo;Green Bomber&rdquo; Campbell/);
    assert.match(about, /PanaGeoTech formula/);
});

test('homepage places the property sponsor before the legacy section without visible advertisement labels', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(html.indexOf('class="sponsor sponsor-property"') < html.indexOf('id="approach"'));
    assert.match(html, /<h2 id="approach-heading">The NBA Edge Legacy<\/h2>/);
    assert.doesNotMatch(html, /<p class="sponsor-label">Advertisement<\/p>/);
    assert.equal((html.match(/class="sponsor sponsor-property"/g) || []).length, 1);
});

test('public classic archives contain only safe links, local assets, and preserved scores', () => {
    const root = path.join(__dirname, '..');
    let count = 0;
    for (const year of ['2011', '2012', '2013', '2014', '2015', '2016', '2017']) {
        const directory = path.join(root, 'archives', year);
        for (const name of fs.readdirSync(directory)) {
            assert.match(name, /\.(?:htm|html)$/i);
            const html = fs.readFileSync(path.join(directory, name), 'utf8');
            assert.doesNotMatch(html, /<\s*(?:script|iframe|object|embed)\b/i, name);
            assert.doesNotMatch(html, /(?:befree|jdoqocy|awltovhc|lduhtrp|bettingpartners|partners\.betus|marketing\.888)/i, name);
            for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
                const url = match[1];
                if (/^https?:/i.test(url)) assert.equal(url, 'https://www.888poker.com/', name);
                else if (!url.startsWith('#')) {
                    const target = path.resolve(directory, decodeURI(url.split('#')[0]));
                    assert.ok(fs.existsSync(target), `${name}: missing ${url}`);
                }
            }
            count++;
        }
    }
    assert.equal(count, 86);
    const issue = fs.readFileSync(path.join(root, 'archives', '2013', 'nba13-01.htm'), 'utf8');
    assert.match(issue, /BOS 91 – ORL 79/);
    assert.match(issue, /BOS 97 - ORL 84 WINNER/);
    const utf16Issue = fs.readFileSync(path.join(root, 'archives', '2011', 'nba11-11.htm'), 'utf8');
    assert.match(utf16Issue, /2011 NBA EDGE/);
    assert.doesNotMatch(utf16Issue, /&lt;SCRIPT/i);
});

test('grading treats real and projected pushes as pushes and excludes unavailable lines', () => {
    const game = {
        projection: { away: 100, home: 110 }, final: { away: 105, home: 110 },
        odds: { spread: -5, total: 215 }
    };
    assert.deepEqual(publish.gameResults(game), { winner: 'win', ats: 'push', adjustedAts: 'win', total: 'push' });
    game.odds = { spread: null, total: null };
    assert.deepEqual(publish.gameResults(game), { winner: 'win', ats: null, adjustedAts: null, total: null });
    game.projection = null;
    assert.deepEqual(publish.gameResults(game), { winner: null, ats: null, adjustedAts: null, total: null });
});

test('favorable whole-point spreads follow the projected ATS side, or winner on a projected push', () => {
    const game = { projection: { away: 100, home: 106 }, final: { away: 100, home: 106 }, odds: { spread: -6, total: 210 } };
    assert.equal(publish.adjustedSpread(game), -5.5);
    assert.equal(publish.gameResults(game).ats, 'push');
    assert.equal(publish.gameResults(game).adjustedAts, 'win');
    game.odds.spread = -10;
    assert.equal(publish.adjustedSpread(game), -10.5);
    game.final = { away: 100, home: 110 };
    assert.equal(publish.gameResults(game).ats, 'push');
    assert.equal(publish.gameResults(game).adjustedAts, 'win');
    game.projection = { away: 106, home: 100 };
    game.odds.spread = 6;
    assert.equal(publish.adjustedSpread(game), 5.5);
    game.odds.spread = 0;
    assert.equal(publish.adjustedSpread(game), -0.5);
    game.odds.spread = 5.5;
    assert.equal(publish.adjustedSpread(game), 5.5);
    game.odds.spread = null;
    assert.equal(publish.adjustedSpread(game), null);
    game.odds.spread = 0;
    game.projection = null;
    assert.equal(publish.adjustedSpread(game), null);
});

test('season records distinguish fallback, configured and unknown issue settings', () => {
    const game = { projection: { away: 100, home: 110 }, final: { away: 105, home: 110 }, odds: { spread: -5, total: 215 } };
    const issue = (number, source) => ({ season: 2026, number, date: `2026-11-${14 + number}`, archived: true, games: [game], model_source: source });
    const html = publish.renderSeasonIndex(2026, [issue(1, 'fallback'), issue(2, 'configured'), issue(3)]);
    assert.match(html, /Issue 1\)<\/a><\/td><td>1-0-0\*<\/td>/);
    assert.match(html, /Issue 2\)<\/a><\/td><td>1-0-0<\/td>/);
    assert.match(html, /Issue 3\)<\/a><\/td><td>1-0-0\?<\/td>/);
    assert.match(html, /Season total<\/th><th>3-0-0\*\?<\/th>/);
    assert.doesNotMatch(html, /fallback model settings|Model settings were not recorded/);
    const configuredOnly = publish.renderSeasonIndex(2026, [issue(2, 'configured')]);
    assert.doesNotMatch(configuredOnly, /fallback model settings|Model settings were not recorded/);
});

test('season percentages count wins and losses but exclude pushes and missing records', () => {
    const game = (finalHome, spread = -0.5) => ({
        projection: { away: 100, home: 110 }, final: { away: 100, home: finalHome },
        odds: { spread, total: null }
    });
    const games = [
        ...Array.from({ length: 10 }, () => game(110)),
        ...Array.from({ length: 6 }, () => game(90)),
        game(100, null)
    ];
    const issue = { season: 2026, number: 1, date: '2026-11-18', archived: true, model_source: 'configured', games };
    const html = publish.renderSeasonIndex(2026, [issue]);
    assert.match(html, /Season total<\/th><th>10-6-1<\/th><td>62\.50%<\/td><th>10-6-0<\/th><td>62\.50%<\/td>/);
    assert.match(publish.renderSeasonIndex(2026, []), /Season total<\/th><th>0-0-0<\/th><td>N\/A<\/td><th>0-0-0<\/th><td>N\/A<\/td>/);
    assert.match(html, /href="\.\.\/\.\.\/disclaimer\.html"/);
});

test('missing individual lines do not block daily publication', async t => {
    const root = temporaryRoot(t);
    const stats = { gp: 4, wins: 2, losses: 2, pf_sum: 440, pa_sum: 440 };
    const first = event('1', '2026-11-20T23:00:00Z', false);
    const second = event('2', '2026-11-20T23:30:00Z', false);
    first.competitions[0].odds[0].overUnder = null;
    second.competitions[0].odds = [];
    const provider = {
        scoreboard: async () => [first, second],
        teamStats: async () => stats,
        mergeOdds: data.mergeOdds
    };
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });
    global.fetch = async () => { throw new Error('partial slate must not request odds'); };
    await daily.run({ root, now: new Date('2026-11-20T10:00:00Z'), provider, env: { ODDS_API_KEY: 'key' } });
    const html = fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8');
    assert.match(html, /home team is a 3\.5-point favorite and the total is TBD/);
    assert.match(html, /point spread is TBD and the total is TBD/);
    assert.equal(daily.readState(root).issues[0].games.length, 2);
});

test('Eastern dates and season rollover honor daylight saving time', () => {
    assert.equal(daily.easternDate(new Date('2026-11-01T04:30:00Z')), '2026-11-01');
    assert.equal(daily.easternParts(new Date('2026-11-01T09:41:00Z')).hour, '04');
    assert.equal(daily.easternParts(new Date('2026-07-01T08:41:00Z')).hour, '04');
    assert.equal(daily.seasonStart('2027-06-30'), 2026);
    assert.equal(daily.seasonStart('2027-07-01'), 2027);
});

test('a failed daily update leaves the last viewport intact and a later retry publishes once', async t => {
    const root = temporaryRoot(t);
    const stats = { gp: 4, wins: 3, losses: 1, pf_sum: 440, pa_sum: 420 };
    let unavailable = false;
    const provider = {
        scoreboard: async date => {
            if (unavailable) throw new data.ProviderUnavailableError('scoreboard unavailable');
            return [event(date, `${date}T23:00:00Z`, false)];
        },
        teamStats: async () => ({ ...stats }),
        mergeOdds: async () => {},
        finalScore: async () => ({ away: 100, home: 110 })
    };
    await daily.run({ root, now: new Date('2026-11-18T09:41:00Z'), provider, env: {} });
    const previous = fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8');
    unavailable = true;
    await assert.rejects(daily.run({ root, now: new Date('2026-11-19T09:41:00Z'), provider, env: {} }), /scoreboard unavailable/);
    assert.equal(fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8'), previous);
    assert.equal(daily.readState(root).issues.length, 1);
    unavailable = false;
    await daily.run({ root, now: new Date('2026-11-19T10:41:00Z'), provider, env: {} });
    const published = fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8');
    assert.match(published, /2026-11-19 Picks/);
    assert.ok(fs.existsSync(path.join(root, 'archives', '2026', 'nba26-001.html')));
    await daily.run({ root, now: new Date('2026-11-19T11:41:00Z'), provider, env: {} });
    assert.equal(fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8'), published);
    assert.equal(daily.readState(root).issues.length, 2);
});

test('daily rotation is idempotent and archives postponed games independently', async t => {
    const root = temporaryRoot(t);
    const final = new Set();
    const stats = { gp: 4, wins: 3, losses: 1, pf_sum: 440, pa_sum: 420, game_ids: ['a', 'b', 'c', 'd'] };
    const provider = {
        scoreboard: async date => [event(date, `${date}T23:00:00Z`, false)],
        teamStats: async () => ({ ...stats }),
        mergeOdds: async () => {},
        finalScore: async game => final.has(game.id) ? { away: 100, home: 110 } : null
    };
    const run = date => daily.run({ root, now: new Date(`${date}T09:41:00Z`), provider, env: {} });
    await run('2026-11-15');
    const first = fs.readFileSync(path.join(root, 'nba26-001.html'), 'utf8');
    fs.writeFileSync(path.join(root, 'NBATMP.htm'), 'damaged viewport');
    await run('2026-11-15');
    assert.equal(fs.readFileSync(path.join(root, 'nba26-001.html'), 'utf8'), first);
    assert.equal(fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8'), first);
    await run('2026-11-16');
    assert.ok(fs.existsSync(path.join(root, 'nba26-002.html')));
    assert.ok(!fs.existsSync(path.join(root, 'archives', '2026', 'nba26-001.html')));
    final.add('2026-11-15');
    final.add('2026-11-16');
    await run('2026-11-17');
    const state = daily.readState(root);
    assert.equal(state.issues.length, 3);
    assert.deepEqual(state.issues.map(issue => issue.archived), [true, true, false]);
    assert.deepEqual(state.issues.map(issue => issue.model_source), ['fallback', 'fallback', 'fallback']);
    const archive = fs.readFileSync(path.join(root, 'archives', '2026', 'nba26-001.html'), 'utf8');
    assert.match(archive, /A 100 - H 110/);
    assert.match(archive, /href="\.\.\/\.\.\/nba\.css"/);
    const index = fs.readFileSync(path.join(root, 'archives', '2026', 'index.html'), 'utf8');
    assert.match(index, /nba26-001\.html/);
    assert.match(index, /nba26-002\.html/);
    assert.match(index, /Season total<\/th><th>[^<]*\*/);
    assert.doesNotMatch(index, /fallback model settings/);
    fs.appendFileSync(path.join(root, 'nba26-001.html'), 'tampering');
    assert.throws(() => daily.readState(root), /checksum mismatch/);
});

test('no-game days update the viewport without allocating an issue', async t => {
    const root = temporaryRoot(t);
    const provider = { scoreboard: async () => [], finalScore: async () => null };
    await daily.run({ root, now: new Date('2026-07-01T08:41:00Z'), provider, env: {} });
    const html = fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8');
    assert.match(html, /Picks unavailable/);
    assert.match(html, /There are no NBA games scheduled for today/);
    assert.match(html, /src="nba-viewport\.js" data-date="2026-07-01" data-fallback="nba-unavailable\.html"/);
    assert.doesNotMatch(html, /technical difficulties|sponsor sponsor-/);
    assert.ok(!fs.existsSync(path.join(root, 'nba_rotation_state.json')));
});

test('a late manual run distinguishes started games from a day without scheduled games', async t => {
    const root = temporaryRoot(t);
    const provider = { scoreboard: async () => [event('1', '2026-11-16T05:00:00Z', true)] };
    await daily.run({ root, now: new Date('2026-11-16T06:30:00Z'), provider, env: {} });
    const html = fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8');
    assert.match(html, /There are no upcoming NBA games remaining today/);
    assert.doesNotMatch(html, /no NBA games scheduled/i);
});

test('configured settings are recorded without values and preserved on rerun', async t => {
    const root = temporaryRoot(t);
    const stats = { gp: 4, wins: 2, losses: 2, pf_sum: 440, pa_sum: 440 };
    const provider = {
        scoreboard: async date => [event(date, `${date}T23:00:00Z`, false)],
        teamStats: async () => ({ ...stats }),
        mergeOdds: async () => {}
    };
    const env = { PG_PI0: '3', PG_PI7: '3', PG_PPI5: '3', PG_PI2: '3', PG_PI_X: '3', PG_MD: '3' };
    const now = new Date('2026-11-15T09:41:00Z');
    await daily.run({ root, now, provider, env });
    const first = daily.readState(root).issues[0];
    assert.equal(first.model_source, 'configured');
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'nba_rotation_state.json'), 'utf8'), /PG_PI0|PG_MD/);
    await daily.run({ root, now, provider, env: {} });
    assert.equal(daily.readState(root).issues[0].model_source, 'configured');
});

test('manual rebuild replaces only today using configured secrets and stored stats', async t => {
    const root = temporaryRoot(t);
    const stats = {
        A: { gp: 4, wins: 1, losses: 3, pf_sum: 381, pa_sum: 469 },
        H: { gp: 4, wins: 4, losses: 0, pf_sum: 531, pa_sum: 462 }
    };
    let scoreboardCalls = 0;
    const provider = {
        scoreboard: async date => {
            if (scoreboardCalls++) throw new Error('Rebuild should not refetch the scoreboard');
            return [event(`${date}-1`, `${date}T23:00:00Z`, false)];
        },
        teamStats: async teamId => ({ ...stats[teamId] }),
        mergeOdds: async () => {}
    };
    const configured = {
        PG_PI0: '2.4', PG_PI7: '2.2', PG_PPI5: '2.0',
        PG_PI2: '1.873', PG_PI_X: '1.765', PG_MD: '1.78'
    };
    const now = new Date('2026-11-19T09:41:00Z');
    await daily.run({ root, now, provider, env: {} });
    const original = daily.readState(root).issues[0];
    const originalHtml = fs.readFileSync(path.join(root, 'nba26-001.html'), 'utf8');
    assert.equal(original.model_source, 'fallback');

    await assert.rejects(
        daily.run({ root, now, provider, env: {}, rebuildToday: true }),
        /without all configured projection secrets/
    );
    assert.equal(fs.readFileSync(path.join(root, 'nba26-001.html'), 'utf8'), originalHtml);

    await daily.run({ root, now, provider, env: configured, rebuildToday: true });
    const rebuilt = daily.readState(root).issues[0];
    const canonical = fs.readFileSync(path.join(root, 'nba26-001.html'), 'utf8');
    assert.equal(rebuilt.number, original.number);
    assert.equal(rebuilt.date, original.date);
    assert.equal(rebuilt.model_source, 'configured');
    assert.notDeepEqual(rebuilt.games[0].projection, original.games[0].projection);
    assert.deepEqual(rebuilt.games[0].odds, original.games[0].odds);
    assert.equal(rebuilt.canonical_hash, publish.hash(canonical));
    assert.equal(fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8'), canonical);
    assert.match(canonical, /gfeesh-thanksgiving-ad\.jpg/);
    assert.equal(daily.readState(root).issues.length, 1);
    await assert.rejects(
        daily.run({ root, now: new Date('2026-11-19T23:01:00Z'), provider, env: configured, rebuildToday: true }),
        /after any game has started/
    );
    assert.equal(fs.readFileSync(path.join(root, 'nba26-001.html'), 'utf8'), canonical);
});

test('presentation refresh updates the seasonal ad without changing projections or lines', async t => {
    const root = temporaryRoot(t);
    const stats = { gp: 4, wins: 2, losses: 2, pf_sum: 440, pa_sum: 440 };
    const provider = {
        scoreboard: async date => [event(`${date}-1`, `${date}T23:00:00Z`, false)],
        teamStats: async () => ({ ...stats }),
        mergeOdds: async () => {}
    };
    const now = new Date('2026-11-19T09:41:00Z');
    await daily.run({ root, now, provider, env: {} });
    const original = daily.readState(root).issues[0];
    const originalProjection = original.games[0].projection;
    const originalOdds = original.games[0].odds;
    const templatePath = path.join(root, 'nba-template.htm');
    const oldTemplate = fs.readFileSync(templatePath, 'utf8');
    fs.writeFileSync(templatePath, oldTemplate.replace('Pumpkin Pie (feat. G Pan)', 'Old seasonal artwork'));

    daily.refreshTodayPresentation(root, now);

    const refreshed = daily.readState(root).issues[0];
    const html = fs.readFileSync(path.join(root, 'nba26-001.html'), 'utf8');
    assert.deepEqual(refreshed.games[0].projection, originalProjection);
    assert.deepEqual(refreshed.games[0].odds, originalOdds);
    assert.equal(refreshed.model_source, original.model_source);
    assert.match(html, /Pumpkin Pie \(feat\. G Pan\)/);
    assert.doesNotMatch(html, /Old seasonal artwork/);
    assert.equal(refreshed.canonical_hash, publish.hash(html));
    assert.equal(fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8'), html);
});

test('season rollover archives the previous season and restarts issue numbering', async t => {
    const root = temporaryRoot(t);
    const stats = { gp: 4, wins: 2, losses: 2, pf_sum: 440, pa_sum: 440 };
    const provider = {
        scoreboard: async date => [event(date, `${date}T23:00:00Z`, false)],
        teamStats: async () => ({ ...stats }),
        mergeOdds: async () => {},
        finalScore: async () => ({ away: 90, home: 100 })
    };
    await daily.run({ root, now: new Date('2027-06-30T08:41:00Z'), provider, env: {} });
    await daily.run({ root, now: new Date('2027-07-01T08:41:00Z'), provider, env: {} });
    assert.ok(fs.existsSync(path.join(root, 'archives', '2026', 'nba26-001.html')));
    assert.ok(fs.existsSync(path.join(root, 'nba27-001.html')));
    assert.match(fs.readFileSync(path.join(root, 'archives', 'index.html'), 'utf8'), /2026\/index\.html/);
});

test('an unavailable final-score lookup does not block the next issue', async t => {
    const root = temporaryRoot(t);
    const stats = { gp: 4, wins: 2, losses: 2, pf_sum: 440, pa_sum: 440 };
    const provider = {
        scoreboard: async date => [event(date, `${date}T23:00:00Z`, false)],
        teamStats: async () => ({ ...stats }),
        mergeOdds: async () => {},
        finalScore: async () => { throw new data.ProviderUnavailableError('HTTP 503'); }
    };
    await daily.run({ root, now: new Date('2026-11-15T09:41:00Z'), provider, env: {} });
    await daily.run({ root, now: new Date('2026-11-16T09:41:00Z'), provider, env: {} });
    const state = daily.readState(root);
    assert.equal(state.issues.length, 2);
    assert.equal(state.issues[0].archived, false);
    assert.ok(fs.existsSync(path.join(root, 'nba26-002.html')));
});

test('missing ledger with existing issue fails closed', async t => {
    const root = temporaryRoot(t);
    fs.writeFileSync(path.join(root, 'nba26-001.html'), 'existing issue');
    assert.throws(() => daily.readState(root), /state is missing/);
});

test('classic archives do not prevent first automated publication', t => {
    const root = temporaryRoot(t);
    fs.mkdirSync(path.join(root, 'archives', '2013'), { recursive: true });
    fs.writeFileSync(path.join(root, 'archives', '2013', 'nba13-05.html'), 'classic issue');
    assert.deepEqual(daily.readState(root), { schema_version: 1, issues: [] });
    fs.mkdirSync(path.join(root, 'archives', '2026'), { recursive: true });
    fs.writeFileSync(path.join(root, 'archives', '2026', 'nba26-001.html'), 'automated issue');
    assert.throws(() => daily.readState(root), /state is missing/);
});

test('malformed final data fails without publishing a later issue', async t => {
    const root = temporaryRoot(t);
    const stats = { gp: 4, wins: 2, losses: 2, pf_sum: 440, pa_sum: 440 };
    const provider = {
        scoreboard: async date => [event(date, `${date}T23:00:00Z`, false)],
        teamStats: async () => ({ ...stats }),
        mergeOdds: async () => {},
        finalScore: async () => { throw new Error('mismatched game'); }
    };
    await daily.run({ root, now: new Date('2026-11-15T09:41:00Z'), provider, env: {} });
    await assert.rejects(daily.run({ root, now: new Date('2026-11-16T09:41:00Z'), provider, env: {} }), /mismatched game/);
    assert.ok(!fs.existsSync(path.join(root, 'nba26-002.html')));
    assert.equal(daily.readState(root).issues.length, 1);
});
