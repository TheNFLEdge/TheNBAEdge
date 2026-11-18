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

test('issue template retains all three ads and resolves artwork for current and archived issues', () => {
    const root = path.join(__dirname, '..');
    const template = fs.readFileSync(path.join(root, 'nba-template.htm'), 'utf8');
    const issue = { date: '2026-11-15', number: 1, season: 2026, games: [] };
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
    assert.match(html, /The \(10-5\) Chicago Bulls head into \(8-7\) Brooklyn Nets, where the home team is installed as a 2\.5-point favorite/);
    assert.match(html, /Projected Score:<\/strong> CHI 123 - BKN 95/);
    assert.match(html, /Final Score:<\/strong> TBD/);
    assert.doesNotMatch(html, /Our computer projects|Example Book|Game 1:|last four|440 scored|<table>/i);
    game.odds.spread = 3.5;
    html = render();
    assert.match(html, /BKN \+3\.5/);
    assert.match(html, /home team is a 3\.5-point underdog/);
    game.odds = { spread: 0, total: null, source: null };
    game.projection = null;
    game.final = { away: 100, home: 110 };
    html = render();
    assert.match(html, /BKN PK &nbsp; \| &nbsp; O\/U: Unavailable/);
    assert.match(html, /pick&#39;em matchup/);
    assert.match(html, /Projected Score:<\/strong> TBD/);
    assert.match(html, /Final Score:<\/strong> CHI 100 - BKN 110/);
    game.odds.spread = null;
    game.away.record = null;
    game.home.record = null;
    assert.match(render(), /The Chicago Bulls head into Brooklyn Nets\./);
});

test('only an outdated daily viewport routes to the fallback on Eastern date boundaries', () => {
    const root = path.join(__dirname, '..');
    const script = fs.readFileSync(path.join(root, 'nba-viewport.js'), 'utf8');
    function check(pathname, issueDate, instant) {
        let redirected = null;
        let scheduled;
        const clock = class extends Date {
            constructor() { super(instant); }
        };
        const window = {
            location: { pathname, replace: url => { redirected = url; } },
            setInterval: (callback, delay) => { scheduled = { callback, delay }; }
        };
        vm.runInNewContext(script, {
            window, document: { currentScript: { dataset: { date: issueDate, fallback: 'nba-unavailable.html' } } },
            Date: clock, Intl, console
        });
        return { redirected, scheduled };
    }
    assert.equal(check('/NBATMP.htm', '2026-11-15', '2026-11-16T04:59:00Z').redirected, null);
    const stale = check('/NBATMP.htm', '2026-11-15', '2026-11-16T05:00:00Z');
    assert.equal(stale.redirected, 'nba-unavailable.html');
    assert.equal(stale.scheduled.delay, 60000);
    assert.equal(check('/NBATMP.htm', '2026-07-01', '2026-07-02T03:59:00Z').redirected, null);
    assert.equal(check('/NBATMP.htm', '2026-07-01', '2026-07-02T04:00:00Z').redirected, 'nba-unavailable.html');
    assert.equal(check('/nba26-001.html', '2026-11-15', '2026-11-16T05:00:00Z').redirected, null);
    assert.equal(check('/archives/2026/nba26-001.html', '2026-11-15', '2026-11-16T05:00:00Z').redirected, null);
    assert.ok(fs.existsSync(path.join(root, 'images', 'under-construction.gif')));
    const fallback = fs.readFileSync(path.join(root, 'nba-unavailable.html'), 'utf8');
    assert.match(fallback, /href="archives\/index\.html"/);
    assert.match(fallback, /src="images\/under-construction\.gif"/);
});

test('disclaimer is linked from the portal, about page, and current viewport', () => {
    const root = path.join(__dirname, '..');
    const disclaimer = fs.readFileSync(path.join(root, 'disclaimer.html'), 'utf8');
    assert.match(disclaimer, /First Amendment/);
    assert.match(disclaimer, /whether a particular use qualifies depends on the circumstances/i);
    assert.match(disclaimer, /actual final scores and compare them with our projections/);
    for (const name of ['index.html', 'about.html', 'NBATMP.htm']) {
        assert.match(fs.readFileSync(path.join(root, name), 'utf8'), /href="disclaimer\.html"/, name);
    }
});

test('generated archive index preserves local classic season links', () => {
    const root = path.join(__dirname, '..');
    const html = publish.renderArchivesIndex([{ season: 2026, archived: true }]);
    assert.match(html, /2026\/index\.html/);
    for (const href of ['2011/index.html', '2012/index.html', '2013/index.html', '2014/index.html',
        '2015/index.html', '2016/index.html', '2017/index.html']) {
        assert.ok(html.includes(`href="${href}"`), href);
        assert.ok(fs.existsSync(path.join(root, 'archives', ...href.split('/'))), href);
    }
    assert.equal(fs.readFileSync(path.join(root, 'archives', 'index.html'), 'utf8'), publish.renderArchivesIndex([]));
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
    assert.ok(hero.includes('the historical season of 2015 the NBA Edge beat the spread even better than our 90% rate, going 92.31% in our selected picks'));
    assert.match(hero, /href="about\.html"/);
    const about = fs.readFileSync(path.join(root, 'about.html'), 'utf8');
    assert.match(about, /Chris &ldquo;Green Bomber&rdquo; Campbell/);
    assert.match(about, /PanaGeoTech formula/);
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
    assert.deepEqual(publish.gameResults(game), { winner: 'win', ats: 'push', total: 'push' });
    game.odds = { spread: null, total: null };
    assert.deepEqual(publish.gameResults(game), { winner: 'win', ats: null, total: null });
    game.projection = null;
    assert.deepEqual(publish.gameResults(game), { winner: null, ats: null, total: null });
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

test('Eastern dates and season rollover honor daylight saving time', () => {
    assert.equal(daily.easternDate(new Date('2026-11-01T04:30:00Z')), '2026-11-01');
    assert.equal(daily.easternParts(new Date('2026-11-01T09:41:00Z')).hour, '04');
    assert.equal(daily.easternParts(new Date('2026-07-01T08:41:00Z')).hour, '04');
    assert.equal(daily.shouldRunSchedule(new Date('2026-07-01T10:15:00Z'), '41 8 * * *'), true);
    assert.equal(daily.shouldRunSchedule(new Date('2026-07-01T10:15:00Z'), '41 9 * * *'), false);
    assert.equal(daily.shouldRunSchedule(new Date('2026-11-01T10:15:00Z'), '41 9 * * *'), true);
    assert.equal(daily.shouldRunSchedule(new Date('2026-11-01T10:15:00Z'), '41 8 * * *'), false);
    assert.equal(daily.seasonStart('2027-06-30'), 2026);
    assert.equal(daily.seasonStart('2027-07-01'), 2027);
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
    assert.match(fs.readFileSync(path.join(root, 'NBATMP.htm'), 'utf8'), /No upcoming NBA games/);
    assert.ok(!fs.existsSync(path.join(root, 'nba_rotation_state.json')));
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
