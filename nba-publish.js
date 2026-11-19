'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const hash = text => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const issueName = issue => `nba${String(issue.season).slice(-2)}-${String(issue.number).padStart(3, '0')}.html`;
const outcome = value => value > 0 ? 1 : value < 0 ? -1 : 0;
const grade = (predicted, actual) => !predicted || !actual ? 'push' : predicted === actual ? 'win' : 'loss';

function adjustedSpread(game) {
    const spread = game.odds.spread;
    if (spread === null || !game.projection) return null;
    if (!Number.isInteger(spread)) return spread;
    const margin = game.projection.home - game.projection.away;
    const side = outcome(margin + spread) || outcome(margin);
    if (!side) return null;
    return spread + side * 0.5;
}

function gameResults(game) {
    if (!game.final || !game.projection) return { winner: null, ats: null, adjustedAts: null, total: null };
    const p = game.projection;
    const f = game.final;
    const adjusted = adjustedSpread(game);
    return {
        winner: grade(outcome(p.home - p.away), outcome(f.home - f.away)),
        ats: game.odds.spread === null ? null : grade(
            outcome(p.home - p.away + game.odds.spread), outcome(f.home - f.away + game.odds.spread)),
        adjustedAts: adjusted === null ? null : grade(
            outcome(p.home - p.away + adjusted), outcome(f.home - f.away + adjusted)),
        total: game.odds.total === null ? null : grade(
            outcome(p.home + p.away - game.odds.total), outcome(f.home + f.away - game.odds.total))
    };
}

function summarize(issue) {
    const result = {};
    for (const name of ['winner', 'ats', 'adjustedAts', 'total']) result[name] = { win: 0, loss: 0, push: 0 };
    for (const game of issue.games) {
        const grades = gameResults(game);
        for (const name of Object.keys(result)) if (grades[name]) result[name][grades[name]]++;
    }
    return result;
}

function recordString(record) {
    return `${record.win}-${record.loss}-${record.push}`;
}

function displayScore(game, score) {
    return `${escapeHtml(game.away.abbreviation)} ${score.away} - ${escapeHtml(game.home.abbreviation)} ${score.home}`;
}

function resultIndicators(game, result) {
    let winner = '';
    if (result.winner === 'win') {
        winner = result.adjustedAts === 'win' ?
            '<strong class="result-win" aria-label="Winner and favorable spread comparison correct">W</strong>' :
            '<span aria-label="Winner correct">W</span>';
    } else if (result.winner === 'loss') {
        winner = result.adjustedAts === 'win' ?
            '<strong class="result-win" aria-label="Winner incorrect, favorable spread comparison correct">COVER</strong>' :
            '<span aria-label="Winner incorrect">L</span>';
    }
    let total = '';
    if (result.total === 'win') {
        const over = game.projection.home + game.projection.away > game.odds.total;
        total = `<strong class="result-win" aria-label="${over ? 'Over' : 'Under'} correct">(${over ? 'O' : 'U'})</strong>`;
    }
    return [winner, total].filter(Boolean).map(value => ` ${value}`).join('');
}

function card(game) {
    const odds = game.odds;
    const spread = odds.spread === null ? 'Unavailable' :
        `${escapeHtml(game.home.abbreviation)} ${odds.spread > 0 ? '+' : ''}${odds.spread === 0 ? 'PK' : odds.spread}`;
    const total = odds.total === null ? 'Unavailable' : String(odds.total);
    const adjusted = adjustedSpread(game);
    const adjustedText = adjusted === null ? 'Unavailable' :
        `${escapeHtml(game.home.abbreviation)} ${adjusted > 0 ? '+' : ''}${adjusted}`;
    const away = escapeHtml(game.away.name);
    const home = escapeHtml(game.home.name);
    const record = team => team.record ? `(${escapeHtml(team.record)}) ` : '';
    let matchup = `The ${record(game.away)}${away} head into ${record(game.home)}${home}`;
    if (odds.spread === null) matchup += '.';
    else if (odds.spread < 0) matchup += `, where the home team is installed as a ${Math.abs(odds.spread)}-point favorite.`;
    else if (odds.spread > 0) matchup += `, where the home team is a ${odds.spread}-point underdog.`;
    else matchup += ' in a pick&#39;em matchup.';
    const result = gameResults(game);
    const indicators = game.final ? resultIndicators(game, result) : '';
    return `<article class="game-card" data-game-id="${escapeHtml(game.id)}">
<h2>${away} at ${home}</h2>
<p class="line">${spread} &nbsp; | &nbsp; O/U: ${total}</p>
<p>Favorable comparison spread (hypothetical): ${adjustedText}</p>
<p>${matchup}</p>
<p><strong>Projected Score:</strong> ${game.projection ? displayScore(game, game.projection) : 'TBD'}<br>
<strong>Final Score:</strong> ${game.final ? displayScore(game, game.final) : 'TBD'}${indicators}</p></article>`;
}

function renderIssue(template, issue, prefix = '') {
    let cards = issue.games.map(card);
    const definitions = /<!-- SPONSOR-DEFINITIONS-START -->([\s\S]*?)<!-- SPONSOR-DEFINITIONS-END -->/;
    const match = template.match(definitions);
    if (match) {
        const sponsors = [...match[1].matchAll(/<!-- SPONSOR-START -->\s*([\s\S]*?)\s*<!-- SPONSOR-END -->/g)]
            .map(item => item[1]);
        if (sponsors.length !== 3 || !template.includes('<!-- GAME-CARDS -->')) {
            throw new Error('Invalid NBA sponsor definitions or missing game cards marker');
        }
        template = template.replace(definitions, '');
        if (cards.length) {
            const insertions = new Map();
            sponsors.forEach((sponsor, index) => {
                const position = cards.length === 1 ? 1 :
                    Math.max(1, Math.min(cards.length - 1, Math.round((index + 1) * cards.length / 4)));
                if (!insertions.has(position)) insertions.set(position, []);
                insertions.get(position).push(sponsor);
            });
            cards = cards.flatMap((game, index) => [game, ...(insertions.get(index + 1) || [])]);
        }
    } else if (template.includes('<!-- SPONSOR-DEFINITIONS-START -->') || template.includes('<!-- SPONSOR-DEFINITIONS-END -->')) {
        throw new Error('Invalid NBA sponsor definitions');
    }
    const finished = issue.games.filter(game => game.final).length;
    if (finished) {
        const totals = summarize(issue);
        cards.unshift(`<section class="game-card" aria-label="Projection results"><h2>Projection results</h2><p>Final games: ${finished} of ${issue.games.length}. Records are wins-losses-pushes; games without a projection or line are excluded. The favorable comparison moves whole-point spreads by half a point toward the projected spread pick; it is hypothetical, not the original betting line.</p><p>Winners: ${recordString(totals.winner)} &nbsp; | &nbsp; Against the spread (original): ${recordString(totals.ats)} &nbsp; | &nbsp; Against the spread (favorable comparison): ${recordString(totals.adjustedAts)} &nbsp; | &nbsp; Over/under: ${recordString(totals.total)}</p></section>`);
    }
    return template.replaceAll('{{ROOT}}', prefix)
        .replaceAll('{{DATE}}', escapeHtml(issue.date))
        .replaceAll('{{ISSUE}}', `Issue ${issue.number} &middot; ${issue.season}&ndash;${String(issue.season + 1).slice(-2)} season`)
        .replace('<!-- GAME-CARDS -->', cards.join('\n') || '<p class="game-card">No upcoming NBA games found for this date.</p>')
        .replaceAll('{{ROOT}}', prefix);
}

function renderSeasonIndex(season, issues) {
    const complete = issues.filter(issue => issue.season === season && issue.archived);
    const totals = { winner: { win: 0, loss: 0, push: 0 }, ats: { win: 0, loss: 0, push: 0 }, adjustedAts: { win: 0, loss: 0, push: 0 }, total: { win: 0, loss: 0, push: 0 } };
    const marker = issue => issue.model_source === 'fallback' ? '*' : issue.model_source === 'configured' ? '' : '?';
    const rows = complete.sort((a, b) => a.number - b.number).map(issue => {
        const sum = summarize(issue);
        for (const name of Object.keys(totals)) for (const outcomeName of ['win', 'loss', 'push']) totals[name][outcomeName] += sum[name][outcomeName];
        const mark = marker(issue);
        return `<tr><td><a href="${issueName(issue)}">${escapeHtml(issue.date)} (Issue ${issue.number})</a></td><td>${recordString(sum.winner)}${mark}</td><td>${recordString(sum.ats)}${mark}</td><td>${recordString(sum.adjustedAts)}${mark}</td><td>${recordString(sum.total)}${mark}</td></tr>`;
    });
    const totalMark = (complete.some(issue => marker(issue) === '*') ? '*' : '') + (complete.some(issue => marker(issue) === '?') ? '?' : '');
    rows.push(`<tr><th>Season total</th><th>${recordString(totals.winner)}${totalMark}</th><th>${recordString(totals.ats)}${totalMark}</th><th>${recordString(totals.adjustedAts)}${totalMark}</th><th>${recordString(totals.total)}${totalMark}</th></tr>`);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${season} NBA archives</title><link rel="stylesheet" href="../../nba.css"></head><body><main class="page"><header class="header"><p><a href="../../index.html">Home</a> &middot; <a href="../index.html">All archives</a></p><h1>${season}&ndash;${String(season + 1).slice(-2)} archives</h1><p>Records are wins-losses-pushes. Games without a projection or line are excluded from the relevant record. The favorable spread comparison is hypothetical: whole-point lines move half a point toward the projected spread pick, and other lines are unchanged.</p></header><div class="game-card table-wrap"><table><thead><tr><th>Issue</th><th>Winner</th><th>Against spread (original)</th><th>Against spread (favorable comparison)</th><th>Over/under</th></tr></thead><tbody>${rows.join('\n')}</tbody></table></div></main></body></html>\n`;
}

function renderArchivesIndex(issues) {
    const seasons = [...new Set(issues.filter(issue => issue.archived).map(issue => issue.season))].sort((a, b) => b - a);
    const links = seasons.map(season => `<li><a href="${season}/index.html">${season}&ndash;${String(season + 1).slice(-2)} season</a></li>`).join('\n');
    const classic = [2017, 2016, 2015, 2014, 2013, 2012, 2011].map(year => `<li><a href="${year}/index.html">${year} classic issues</a></li>`).join('\n');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NBA archives</title><link rel="stylesheet" href="../nba.css"></head><body><main class="page"><header class="header"><p><a href="../index.html">Home</a> &middot; <a href="../NBATMP.htm">Today's projections</a></p><p class="eyebrow">The NBA Edge</p><h1>NBA archives</h1><p>Explore completed daily issues and a selection from the classic NBA Edge.</p></header><section class="game-card archive-list"><h2>Daily issue archives</h2>${links ? `<ul>${links}</ul>` : '<p>No completed daily issues yet.</p>'}</section><section class="game-card archive-list"><h2>Classic NBA Edge</h2><p>Explore preserved historical issues and season records. Historical projections and results are presented as published and do not represent current performance.</p><ul>${classic}</ul></section></main></body></html>\n`;
}

function writeAtomic(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temp, content, 'utf8');
        fs.renameSync(temp, file);
    } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
}

module.exports = { adjustedSpread, gameResults, hash, issueName, renderArchivesIndex, renderIssue, renderSeasonIndex, summarize, writeAtomic };
