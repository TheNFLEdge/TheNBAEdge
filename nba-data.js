'use strict';

const ESPN_BASE = process.env.NBA_ESPN_BASE_URL || 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const ODDS_BASE = process.env.ODDS_BASE_URL || 'https://api.the-odds-api.com/v4';

class ProviderUnavailableError extends Error {}

async function requestJson(url) {
    let response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'TheNBAEdge/1.0' } });
    } catch (error) {
        throw new ProviderUnavailableError(`NBA provider request failed: ${error.message}`);
    }
    if (!response.ok) throw new ProviderUnavailableError(`NBA provider returned HTTP ${response.status} for ${new URL(url).pathname}`);
    return response.json();
}

function competition(event) {
    if (!event || !Array.isArray(event.competitions) || event.competitions.length !== 1) {
        throw new Error(`Invalid ESPN competition for event ${event?.id || '(unknown)'}`);
    }
    return event.competitions[0];
}

function sides(game) {
    const competitors = game.competitors;
    if (!Array.isArray(competitors) || competitors.length !== 2) throw new Error('ESPN game must have two competitors');
    const away = competitors.find(team => team.homeAway === 'away');
    const home = competitors.find(team => team.homeAway === 'home');
    if (!away?.id || !home?.id || !away.team?.abbreviation || !home.team?.abbreviation || away.id === home.id) {
        throw new Error('ESPN game has invalid team identities');
    }
    return { away, home };
}

function scoreValue(value) {
    const raw = typeof value === 'object' && value !== null ? value.value : value;
    if (raw === '' || raw === null || raw === undefined) throw new Error('Final game is missing a score');
    const score = Number(raw);
    if (!Number.isInteger(score) || score < 0) throw new Error('Final game has an invalid score');
    return score;
}

function numeric(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function parseOdds(game, away, home) {
    const odds = Array.isArray(game.odds) ? game.odds[0] : null;
    if (!odds) return { spread: null, total: null, source: null };
    const detail = /^([A-Z0-9]+)\s+([+-]?\d+(?:\.\d+)?)$/i.exec(String(odds.details || '').trim());
    let spread = null;
    if (detail && Number.isFinite(Number(detail[2]))) {
        const team = detail[1].toUpperCase();
        if (team === home.team.abbreviation.toUpperCase()) spread = Number(detail[2]);
        if (team === away.team.abbreviation.toUpperCase()) spread = -Number(detail[2]);
    } else if (/^(PK|PICK|PICK'EM)$/i.test(String(odds.details || '').trim())) {
        spread = 0;
    }
    return { spread, total: numeric(odds.overUnder), source: odds.provider?.name || 'ESPN' };
}

function parseMatchup(event) {
    const game = competition(event);
    const { away, home } = sides(game);
    if (!event.id || !event.date || !Number.isFinite(Date.parse(event.date))) throw new Error('ESPN event has invalid ID or date');
    const team = item => ({
        id: String(item.id), abbreviation: item.team.abbreviation,
        name: item.team.displayName || item.team.abbreviation,
        record: item.records?.find(record => record.type === 'total')?.summary || null
    });
    return {
        id: String(event.id), date: event.date, away: team(away), home: team(home),
        odds: parseOdds(game, away, home), final: null, projection: null
    };
}

function rollingStats(events, teamId, cutoff) {
    const seen = new Set();
    const games = [];
    for (const event of events) {
        const game = competition(event);
        if (!game.status?.type?.completed) continue;
        const timestamp = Date.parse(event.date);
        if (!Number.isFinite(timestamp)) throw new Error(`Invalid date in ESPN team schedule: ${event.id}`);
        if (timestamp >= cutoff || seen.has(String(event.id))) continue;
        const { away, home } = sides(game);
        if (String(away.id) !== teamId && String(home.id) !== teamId) throw new Error(`Team schedule contains unrelated game ${event.id}`);
        const team = String(away.id) === teamId ? away : home;
        const opponent = team === away ? home : away;
        games.push({ id: String(event.id), timestamp, pf: scoreValue(team.score), pa: scoreValue(opponent.score) });
        seen.add(String(event.id));
    }
    games.sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
    const last = games.slice(0, 4);
    return {
        gp: last.length, wins: last.filter(game => game.pf > game.pa).length,
        losses: last.filter(game => game.pf < game.pa).length,
        pf_sum: last.reduce((sum, game) => sum + game.pf, 0),
        pa_sum: last.reduce((sum, game) => sum + game.pa, 0),
        game_ids: last.map(game => game.id)
    };
}

async function scoreboard(date) {
    const url = new URL(`${ESPN_BASE.replace(/\/$/, '')}/scoreboard`);
    url.searchParams.set('dates', date.replace(/-/g, ''));
    url.searchParams.set('limit', '100');
    const data = await requestJson(url);
    if (!Array.isArray(data.events)) throw new Error('ESPN scoreboard response has no events array');
    return data.events;
}

async function teamStats(teamId, seasonStart, cutoff) {
    const events = [];
    for (const year of [seasonStart, seasonStart + 1]) {
        for (const type of [2, 3]) {
            const url = new URL(`${ESPN_BASE.replace(/\/$/, '')}/teams/${encodeURIComponent(teamId)}/schedule`);
            url.searchParams.set('season', String(year));
            url.searchParams.set('seasontype', String(type));
            const data = await requestJson(url);
            if (!Array.isArray(data.events)) throw new Error(`ESPN schedule has no events array for team ${teamId}`);
            events.push(...data.events);
        }
    }
    return rollingStats(events, teamId, cutoff);
}

async function finalScore(matchup) {
    const url = new URL(`${ESPN_BASE.replace(/\/$/, '')}/summary`);
    url.searchParams.set('event', matchup.id);
    const data = await requestJson(url);
    const game = competition(data.header);
    const { away, home } = sides(game);
    if (String(game.id) !== matchup.id || String(away.id) !== matchup.away.id || String(home.id) !== matchup.home.id) {
        throw new Error(`ESPN returned a mismatched game for ${matchup.id}`);
    }
    if (!game.status?.type?.completed) return null;
    return { away: scoreValue(away.score), home: scoreValue(home.score) };
}

async function mergeOdds(matchups, key) {
    if (!key || !matchups.some(game => game.odds.spread === null || game.odds.total === null)) return;
    const url = new URL(`${ODDS_BASE.replace(/\/$/, '')}/sports/basketball_nba/odds`);
    url.searchParams.set('apiKey', key);
    url.searchParams.set('regions', 'us');
    url.searchParams.set('markets', 'spreads,totals');
    const events = await requestJson(url);
    if (!Array.isArray(events)) throw new Error('Odds API response is not an array');
    for (const game of matchups) {
        const found = events.filter(event => event.away_team === game.away.name && event.home_team === game.home.name &&
            Math.abs(Date.parse(event.commence_time) - Date.parse(game.date)) < 12 * 60 * 60 * 1000);
        if (found.length !== 1) continue;
        for (const book of found[0].bookmakers || []) {
            const spreads = book.markets?.find(market => market.key === 'spreads');
            const totals = book.markets?.find(market => market.key === 'totals');
            const spread = numeric(spreads?.outcomes?.find(outcome => outcome.name === game.home.name)?.point);
            const total = numeric(totals?.outcomes?.find(outcome => outcome.name === 'Over')?.point);
            const addedSpread = game.odds.spread === null && spread !== null;
            const addedTotal = game.odds.total === null && total !== null;
            if (addedSpread) game.odds.spread = spread;
            if (addedTotal) game.odds.total = total;
            if (addedSpread || addedTotal) {
                const source = book.title || 'The Odds API';
                if (!game.odds.source) game.odds.source = source;
                else if (!game.odds.source.split(' / ').includes(source)) game.odds.source += ` / ${source}`;
            }
            if (game.odds.spread !== null && game.odds.total !== null) break;
        }
    }
}

module.exports = { ProviderUnavailableError, competition, finalScore, mergeOdds, parseMatchup, parseOdds, rollingStats, scoreboard, teamStats };
