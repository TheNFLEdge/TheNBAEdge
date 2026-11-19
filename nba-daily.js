'use strict';

const fs = require('node:fs');
const path = require('node:path');
const data = require('./nba-data');
const { modelConfig, projectMatchup } = require('./nba-projection');
const publish = require('./nba-publish');

const ROOT = __dirname;
const STATE = 'nba_rotation_state.json';
const VIEWPORT = 'NBATMP.htm';

function easternParts(now) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(now);
    return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function easternDate(now) {
    const p = easternParts(now);
    return `${p.year}-${p.month}-${p.day}`;
}

function seasonStart(date) {
    const [year, month] = date.split('-').map(Number);
    return month >= 7 ? year : year - 1;
}

function readState(root) {
    const file = path.join(root, STATE);
    if (!fs.existsSync(file)) {
        const canonical = fs.readdirSync(root).some(name => /^nba\d{2}-\d+\.html$/.test(name));
        const archiveRoot = path.join(root, 'archives');
        const archive = fs.existsSync(archiveRoot) && fs.readdirSync(archiveRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /^\d{4}$/.test(entry.name))
            .some(entry => fs.readdirSync(path.join(archiveRoot, entry.name)).some(name => /^nba\d{2}-\d{3,}\.html$/.test(name)));
        if (canonical || archive) throw new Error('NBA rotation state is missing but existing issues were found; restore the state before running');
        return { schema_version: 1, issues: [] };
    }
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.schema_version !== 1 || !Array.isArray(state.issues)) throw new Error('Invalid NBA rotation state');
    const seen = new Set();
    const dates = new Set();
    for (const issue of state.issues) {
        if (!Number.isInteger(issue.season) || issue.season < 2000 || issue.season > 9999 ||
            !Number.isInteger(issue.number) || issue.number < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(issue.date) ||
            seasonStart(issue.date) !== issue.season || !Array.isArray(issue.games) || !issue.games.length ||
            typeof issue.archived !== 'boolean' || typeof issue.template !== 'string' ||
            (issue.model_source !== undefined && !['fallback', 'configured'].includes(issue.model_source))) throw new Error('Invalid NBA issue in rotation state');
        const key = `${issue.season}-${issue.number}`;
        if (seen.has(key) || dates.has(issue.date)) throw new Error(`Duplicate NBA issue ${key} or date ${issue.date}`);
        seen.add(key);
        dates.add(issue.date);
        const games = new Set();
        for (const game of issue.games) {
            if (!game.id || games.has(game.id) || !game.away?.id || !game.home?.id || !game.odds ||
                (game.final && (!Number.isInteger(game.final.away) || game.final.away < 0 ||
                    !Number.isInteger(game.final.home) || game.final.home < 0)) ||
                (issue.archived && !game.final)) throw new Error(`Invalid game in NBA issue ${key}`);
            games.add(game.id);
        }
        const canonical = path.join(root, publish.issueName(issue));
        if (!fs.existsSync(canonical) || publish.hash(fs.readFileSync(canonical, 'utf8')) !== issue.canonical_hash) {
            throw new Error(`Canonical issue checksum mismatch: ${publish.issueName(issue)}`);
        }
        if (issue.archived) {
            const archived = path.join(root, 'archives', String(issue.season), publish.issueName(issue));
            if (!fs.existsSync(archived) || publish.hash(fs.readFileSync(archived, 'utf8')) !== issue.archive_hash) {
                throw new Error(`Archived issue checksum mismatch: ${archived}`);
            }
        }
    }
    return state;
}

function viewportIssue(root, state) {
    const viewportPath = path.join(root, VIEWPORT);
    if (!fs.existsSync(viewportPath)) return null;
    const viewport = fs.readFileSync(viewportPath, 'utf8');
    const script = viewport.match(/<script\b[^>]*\bsrc="[^"]*nba-viewport\.js"[^>]*>/);
    const date = script && script[0].match(/\bdata-date="(\d{4}-\d{2}-\d{2})"/);
    return date ? state.issues.find(item => item.date === date[1]) : null;
}

function refreshResults(root = ROOT) {
    const state = readState(root);
    const outputs = new Map();
    const seasons = new Set();
    for (const issue of state.issues.filter(item => item.archived)) {
        const html = publish.renderIssue(issue.template, issue, '../../');
        issue.archive_hash = publish.hash(html);
        outputs.set(path.join(root, 'archives', String(issue.season), publish.issueName(issue)), html);
        seasons.add(issue.season);
    }
    for (const season of seasons) {
        outputs.set(path.join(root, 'archives', String(season), 'index.html'), publish.renderSeasonIndex(season, state.issues));
    }
    const issue = viewportIssue(root, state);
    if (issue && issue.games.some(game => game.final)) {
        outputs.set(path.join(root, VIEWPORT), publish.renderIssue(issue.template, issue));
    }
    for (const [file, content] of outputs) publish.writeAtomic(file, content);
    if (seasons.size) publish.writeAtomic(path.join(root, STATE), `${JSON.stringify(state, null, 2)}\n`);
    console.log(`Refreshed results for ${state.issues.filter(item => item.archived).length} archived issues.`);
}

async function run({ root = ROOT, now = new Date(), provider = data, env = process.env, scoresOnly = false } = {}) {
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid current time');
    const today = easternDate(now);
    const season = seasonStart(today);
    const state = readState(root);
    const template = fs.readFileSync(path.join(root, 'nba-template.htm'), 'utf8');
    const outputs = new Map();
    let changed = false;
    const archiveSeasons = new Set();

    for (const issue of state.issues.filter(item => !item.archived && item.date < today)) {
        for (const game of issue.games.filter(item => !item.final)) {
            let result;
            try {
                result = await provider.finalScore(game);
            } catch (error) {
                if (!(error instanceof data.ProviderUnavailableError)) throw error;
                console.warn(`Warning: final score for event ${game.id} is unavailable: ${error.message}`);
                continue;
            }
            if (result) {
                game.final = result;
                changed = true;
            }
        }
        if (issue.games.every(game => game.final)) {
            const html = publish.renderIssue(issue.template, issue, '../../');
            issue.archive_hash = publish.hash(html);
            issue.archived = true;
            const archive = path.join(root, 'archives', String(issue.season), publish.issueName(issue));
            if (fs.existsSync(archive) && publish.hash(fs.readFileSync(archive, 'utf8')) !== issue.archive_hash) {
                throw new Error(`Refusing to overwrite existing archive ${archive}`);
            }
            outputs.set(archive, html);
            archiveSeasons.add(issue.season);
            changed = true;
            console.log(`Archived ${publish.issueName(issue)}`);
        } else {
            console.log(`Issue ${issue.number} (${issue.date}) remains pending; not all games are final.`);
        }
    }

    if (scoresOnly) {
        const issue = viewportIssue(root, state);
        if (issue) outputs.set(path.join(root, VIEWPORT), publish.renderIssue(issue.template, issue));
    } else if (!state.issues.some(issue => issue.date === today)) {
        const events = await provider.scoreboard(today);
        const scheduled = events.filter(event => {
            return [2, 3].includes(event.season?.type) && easternDate(new Date(event.date)) === today;
        });
        const games = scheduled.filter(event => {
            const game = data.competition(event);
            return game.status?.type?.state === 'pre' && Date.parse(event.date) > now.getTime();
        }).map(data.parseMatchup);
        const ids = new Set(games.map(game => game.id));
        if (ids.size !== games.length) throw new Error('Duplicate ESPN events in scoreboard');
        if (games.length) {
            const config = modelConfig(env);
            const teams = new Map(games.flatMap(game => [game.away, game.home]).map(team => [team.id, team]));
            await Promise.all([...teams.values()].map(async team => {
                team.stats = await provider.teamStats(team.id, season, now.getTime());
            }));
            for (const game of games) {
                game.away.stats = teams.get(game.away.id).stats;
                game.home.stats = teams.get(game.home.id).stats;
                game.projection = projectMatchup(game.away.stats, game.home.stats, config);
            }
            await provider.mergeOdds(games, env.ODDS_API_KEY);
            const previous = state.issues.filter(issue => issue.season === season);
            const number = Math.max(0, ...previous.map(issue => issue.number)) + 1;
            const issue = { season, number, date: today, games, archived: false, template, model_source: config.usesFallback ? 'fallback' : 'configured' };
            const html = publish.renderIssue(template, issue);
            issue.canonical_hash = publish.hash(html);
            const canonical = path.join(root, publish.issueName(issue));
            if (fs.existsSync(canonical) && publish.hash(fs.readFileSync(canonical, 'utf8')) !== issue.canonical_hash) {
                throw new Error(`Refusing to overwrite existing canonical issue ${canonical}`);
            }
            outputs.set(canonical, html);
            outputs.set(path.join(root, VIEWPORT), html);
            state.issues.push(issue);
            changed = true;
            console.log(`Generated ${publish.issueName(issue)} with ${games.length} games`);
        } else {
            const unavailable = fs.readFileSync(path.join(root, 'nba-unavailable.html'), 'utf8');
            const message = scheduled.length ? 'There are no upcoming NBA games remaining today.' :
                'There are no NBA games scheduled for today.';
            let html = unavailable.replace(/<!-- UNAVAILABLE-REASON-START -->[\s\S]*?<!-- UNAVAILABLE-REASON-END -->/,
                `<p class="intro">${message}</p>`);
            if (html === unavailable) throw new Error('Missing NBA unavailable reason marker');
            if (!html.includes('<!-- VIEWPORT-DATE -->')) throw new Error('Missing NBA unavailable viewport date marker');
            html = html.replace('<!-- VIEWPORT-DATE -->',
                `<script src="nba-viewport.js" data-date="${today}" data-fallback="nba-unavailable.html"></script>`);
            outputs.set(path.join(root, VIEWPORT), html);
            console.log(`No upcoming regular-season or postseason games on ${today}`);
        }
    } else {
        const issue = state.issues.find(item => item.date === today);
        outputs.set(path.join(root, VIEWPORT), fs.readFileSync(path.join(root, publish.issueName(issue)), 'utf8'));
        console.log(`Issue for ${today} already exists; preserving the published projections and lines.`);
    }

    for (const year of archiveSeasons) {
        outputs.set(path.join(root, 'archives', String(year), 'index.html'), publish.renderSeasonIndex(year, state.issues));
    }
    if (archiveSeasons.size) outputs.set(path.join(root, 'archives', 'index.html'), publish.renderArchivesIndex(state.issues));
    for (const [file, content] of outputs) publish.writeAtomic(file, content);
    if (changed) publish.writeAtomic(path.join(root, STATE), `${JSON.stringify(state, null, 2)}\n`);
}

if (require.main === module) {
    const now = new Date();
    Promise.resolve().then(() => {
        if (process.argv.includes('--refresh-results')) return refreshResults();
        const scoresOnly = process.argv.includes('--scores-only');
        if (scoresOnly && process.env.GITHUB_EVENT_NAME === 'schedule' &&
            !['01', '02', '03', '04'].includes(easternParts(now).hour)) {
            console.log('Skipping score update outside the 01:00-04:59 Eastern window.');
            return;
        }
        return run({ now, scoresOnly });
    }).catch(error => {
        console.error(`NBA daily update failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { easternDate, easternParts, readState, refreshResults, run, seasonStart };
