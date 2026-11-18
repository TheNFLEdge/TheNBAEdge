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

function gameResults(game) {
    if (!game.final || !game.projection) return { winner: null, ats: null, total: null };
    const p = game.projection;
    const f = game.final;
    return {
        winner: grade(outcome(p.home - p.away), outcome(f.home - f.away)),
        ats: game.odds.spread === null ? null : grade(
            outcome(p.home - p.away + game.odds.spread), outcome(f.home - f.away + game.odds.spread)),
        total: game.odds.total === null ? null : grade(
            outcome(p.home + p.away - game.odds.total), outcome(f.home + f.away - game.odds.total))
    };
}

function summarize(issue) {
    const result = {};
    for (const name of ['winner', 'ats', 'total']) result[name] = { win: 0, loss: 0, push: 0 };
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

function card(game, index) {
    const odds = game.odds;
    const spread = odds.spread === null ? 'Unavailable' :
        `${escapeHtml(game.home.abbreviation)} ${odds.spread > 0 ? '+' : ''}${odds.spread}`;
    const total = odds.total === null ? 'Unavailable' : String(odds.total);
    const source = odds.source ? ` (${escapeHtml(odds.source)})` : '';
    const stat = team => team.stats ?
        `${team.stats.wins}-${team.stats.losses}, ${team.stats.pf_sum} scored / ${team.stats.pa_sum} allowed in ${team.stats.gp} games` :
        'Unavailable';
    const result = gameResults(game);
    const resultText = game.final ? `<tr><th>Results</th><td>Winner: ${result.winner || 'N/A'}; ATS: ${result.ats || 'N/A'}; O/U: ${result.total || 'N/A'}</td></tr>` : '';
    return `<article class="game-card" data-game-id="${escapeHtml(game.id)}">
<h2>Game ${index}: ${escapeHtml(game.away.name)} @ ${escapeHtml(game.home.name)}</h2>
<p class="line">Spread: ${spread} &nbsp; | &nbsp; O/U: ${total}${source}</p>
<table><tr><th>Season records</th><td>${escapeHtml(game.away.abbreviation)} ${escapeHtml(game.away.record || 'N/A')} &ndash; ${escapeHtml(game.home.abbreviation)} ${escapeHtml(game.home.record || 'N/A')}</td></tr>
<tr><th>${escapeHtml(game.away.abbreviation)} last four</th><td>${escapeHtml(stat(game.away))}</td></tr>
<tr><th>${escapeHtml(game.home.abbreviation)} last four</th><td>${escapeHtml(stat(game.home))}</td></tr>
<tr><th>Projected score</th><td>${game.projection ? displayScore(game, game.projection) : 'Pending: four completed games required for each team'}</td></tr>
<tr><th>Final score</th><td>${game.final ? displayScore(game, game.final) : 'Pending'}</td></tr>${resultText}</table></article>`;
}

function renderIssue(template, issue, prefix = '') {
    const cards = issue.games.map((game, i) => card(game, i + 1)).join('\n');
    return template.replaceAll('{{ROOT}}', prefix)
        .replaceAll('{{DATE}}', escapeHtml(issue.date))
        .replaceAll('{{ISSUE}}', `Issue ${issue.number} &middot; ${issue.season}&ndash;${String(issue.season + 1).slice(-2)} season`)
        .replace('<!-- GAME-CARDS -->', cards || '<p class="game-card">No upcoming NBA games found for this date.</p>');
}

function renderSeasonIndex(season, issues) {
    const complete = issues.filter(issue => issue.season === season && issue.archived);
    const totals = { winner: { win: 0, loss: 0, push: 0 }, ats: { win: 0, loss: 0, push: 0 }, total: { win: 0, loss: 0, push: 0 } };
    const rows = complete.sort((a, b) => a.number - b.number).map(issue => {
        const sum = summarize(issue);
        for (const name of Object.keys(totals)) for (const outcomeName of ['win', 'loss', 'push']) totals[name][outcomeName] += sum[name][outcomeName];
        return `<tr><td><a href="${issueName(issue)}">${escapeHtml(issue.date)} (Issue ${issue.number})</a></td><td>${recordString(sum.winner)}</td><td>${recordString(sum.ats)}</td><td>${recordString(sum.total)}</td></tr>`;
    });
    rows.push(`<tr><th>Season total</th><th>${recordString(totals.winner)}</th><th>${recordString(totals.ats)}</th><th>${recordString(totals.total)}</th></tr>`);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${season} NBA archives</title><link rel="stylesheet" href="../../nba.css"></head><body><main class="page"><header class="header"><p><a href="../../index.html">Home</a> &middot; <a href="../index.html">All archives</a></p><h1>${season}&ndash;${String(season + 1).slice(-2)} archives</h1><p>Records are wins-losses-pushes. Games without a projection or line are excluded from the relevant record.</p></header><div class="game-card table-wrap"><table><thead><tr><th>Issue</th><th>Winner</th><th>Against spread</th><th>Over/under</th></tr></thead><tbody>${rows.join('\n')}</tbody></table></div></main></body></html>\n`;
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

module.exports = { gameResults, hash, issueName, renderArchivesIndex, renderIssue, renderSeasonIndex, summarize, writeAtomic };
