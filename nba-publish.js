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

function renderNflPromo(prefix = '') {
    return `<article class="sponsor sponsor-nfl" aria-label="The NFL Edge promotion"><div class="sponsor-row"><a href="https://thenfledge.com/"><img class="nfl-logo" src="${prefix}images/nfl-edge-banner.gif" alt="The NFL Edge" loading="lazy"></a><div><h3>Get the Winners. Get the Edge.</h3><p>Free, no-nonsense NFL picks and computer-generated score projections from Greggy the Greek's PanaGeoTech formula throughout the football season.</p><p><a href="https://thenfledge.com/">Get the NFL Edge &rarr;</a></p></div></div></article>`;
}

function resultLegend() {
    return '<p class="result-legend"><strong>Legend:</strong> W = correct winner; L = incorrect winner; green <strong class="result-win">W</strong> = correct winner and spread; green <strong class="result-win">COVER</strong> = correct spread but incorrect winner; green <strong class="result-win">(O)</strong> or <strong class="result-win">(U)</strong> = correct over or under prediction.</p>';
}

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
            '<strong class="result-win" aria-label="Winner and spread prediction correct">W</strong>' :
            '<span aria-label="Winner correct">W</span>';
    } else if (result.winner === 'loss') {
        winner = result.adjustedAts === 'win' ?
            '<strong class="result-win" aria-label="Winner incorrect, spread prediction correct">COVER</strong>' :
            '<span aria-label="Winner incorrect">L</span>';
    }
    let total = '';
    if (result.total === 'win') {
        const over = game.projection.home + game.projection.away > game.odds.total;
        total = `<strong class="result-win" aria-label="${over ? 'Over' : 'Under'} correct">(${over ? 'O' : 'U'})</strong>`;
    }
    return [winner, total].filter(Boolean).map(value => ` ${value}`).join('');
}

function card(game, modern = false) {
    const odds = game.odds;
    const total = odds.total === null ? (modern ? 'TBD' : 'Unavailable') : String(odds.total);
    const comparison = adjustedSpread(game);
    const adjusted = modern && comparison === null ? odds.spread : comparison;
    const spread = adjusted === null ? (modern ? 'TBD' : 'Unavailable') :
        `${escapeHtml(game.home.abbreviation)} ${adjusted > 0 ? '+' : ''}${adjusted}`;
    const away = escapeHtml(game.away.name);
    const home = escapeHtml(game.home.name);
    const record = team => team.record ? `(${escapeHtml(team.record)}) ` : '';
    let matchup = `The ${record(game.away)}${away} head into ${record(game.home)}${home}`;
    if (modern) {
        if (adjusted === null) matchup += ', where the point spread is TBD';
        else if (adjusted < 0) matchup += `, where the home team is a ${Math.abs(adjusted)}-point favorite`;
        else if (adjusted > 0) matchup += `, where the home team is a ${adjusted}-point underdog`;
        else matchup += ' in a pick&#39;em matchup';
        matchup += odds.total === null ? ' and the total is TBD.' : ` and the total has been set for ${total}.`;
    } else {
        if (adjusted === null) matchup += '.';
        else if (adjusted < 0) matchup += `, where the home team is a ${Math.abs(adjusted)}-point favorite for this comparison.`;
        else if (adjusted > 0) matchup += `, where the home team is a ${adjusted}-point underdog for this comparison.`;
        else matchup += ' in a pick&#39;em matchup.';
    }
    const result = gameResults(game);
    const indicators = game.final ? resultIndicators(game, result) : '';
    return `<article class="game-card" data-game-id="${escapeHtml(game.id)}">
<h2>${away} at ${home}</h2>
<p class="line">Comparison spread: ${spread} &nbsp; | &nbsp; O/U: ${total}</p>
<p>${matchup}</p>
<p><strong>Projected Score:</strong> ${game.projection ? displayScore(game, game.projection) : 'TBD'}<br>
<strong>Final Score:</strong> ${game.final ? displayScore(game, game.final) : 'TBD'}${indicators}</p></article>`;
}

function renderIssue(template, issue, prefix = '') {
    const modern = template.includes('<!-- MATCHUP-WORDING-V2 -->');
    const year = Number(issue.date.slice(0, 4));
    const thanksgiving = new Date(Date.UTC(year, 10, 1));
    thanksgiving.setUTCDate(1 + ((4 - thanksgiving.getUTCDay() + 7) % 7) + 21);
    const thanksgivingStart = new Date(thanksgiving);
    thanksgivingStart.setUTCDate(thanksgivingStart.getUTCDate() - 7);
    const thanksgivingEnd = new Date(thanksgiving);
    thanksgivingEnd.setUTCDate(thanksgivingEnd.getUTCDate() + 4);
    const dateValue = Date.parse(`${issue.date}T00:00:00Z`);
    const isThanksgivingWindow = dateValue >= thanksgivingStart.getTime() && dateValue <= thanksgivingEnd.getTime();
    const feeshAd = isThanksgivingWindow ? 'gfeesh-thanksgiving-ad.jpg' : 'gfish-promo-ad.jpg';
    const feeshAdPath = `${prefix}images/${feeshAd}`;
    const feeshAdContent = isThanksgivingWindow
        ? `<div style="position:relative; padding-bottom:55px; background:linear-gradient(rgba(33,23,42,.72), rgba(33,23,42,.72)), url('${feeshAdPath}') center 40% / cover;">
        <img src="${feeshAdPath}" alt="Greggy FEESH and the Phlops celebrate Thanksgiving" loading="lazy" style="width:min(100%, 490px); height:clamp(210px, 27vw, 250px); max-width:none; object-fit:cover; object-position:center 40%; display:block;${modern ? ' margin:0 auto;' : ''}">
        <div style="position:absolute; bottom:0; left:0; right:0; display:flex; flex-wrap:wrap; justify-content:center; gap:10px; padding:22px 12px 12px; background:linear-gradient(transparent, rgba(33,23,42,.95)); font-family:Arial, sans-serif;">
            <a href="https://distrokid.com/hyperfollow/greggyfeeshandthephlops/pumpkin-pie-feat-g-pan?ref=release" target="_blank" rel="noopener noreferrer" style="flex:0 1 auto; min-width:0; padding:12px; border-radius:6px; background:#f28b21; color:#21172a; font-size:clamp(12px, 3vw, 16px); font-weight:700; text-align:center; text-decoration:none;">Pumpkin Pie (feat. G Pan)</a>
            <a href="https://distrokid.com/hyperfollow/greggyfeeshandthephlops/the-thanksgiving?ref=release" target="_blank" rel="noopener noreferrer" style="flex:0 1 auto; min-width:0; padding:12px; border-radius:6px; background:#e46aff; color:#21172a; font-size:clamp(12px, 3vw, 16px); font-weight:700; text-align:center; text-decoration:none;">The Thanksgiving</a>
        </div>
    </div>
    <div style="padding:14px 18px; text-align:center; font-family:Arial, sans-serif;">
        <h2 style="color:#ffd700;">What's better than Thanksgiving, turkey &amp; football?</h2>
        <p style="margin:0;"><strong style="color:#8cff00;">FRESH FEESH&mdash;with a slice of Pumpkin Pie!</strong> Pre-order the latest releases from <strong style="color:#e46aff;">Greggy FEESH and the Phlops</strong>.</p>
    </div>`
        : `<a href="https://open.spotify.com/artist/6fa6DV6wh6WscR3R7fWAyI" target="_blank" rel="noopener noreferrer" style="background:#fff;color:#111;text-align:center;padding:16px 0;">
        <div style="position:relative;width:100%;margin:0 auto;">
            <p style="position:relative;top:12px;z-index:1;margin:0 0 -5px;padding:5px 8px;background:rgba(15,11,34,.55);color:#fff86a;font-size:clamp(11px, 2.7vw, 15px);font-weight:800;line-height:1.25;text-shadow:0 1px 3px #000,1px 1px 2px #000;">Tired of swimming in the same old waves?</p>
            <img src="${feeshAdPath}" alt="Greggy FEESH and the Phlops" loading="lazy" style="display:block;width:min(100%, 500px);height:auto;max-height:250px;margin:0 auto;">
            <div style="position:absolute;left:0;right:0;top:75%;transform:translateY(-50%);padding:5px 8px;background:rgba(15,11,34,.55);color:#fff86a;font-size:clamp(11px, 2.7vw, 15px);font-weight:800;line-height:1.25;text-shadow:0 1px 3px #000,1px 1px 2px #000;">Catch the latest <strong style="color:#fd8cff;">FRESH FEESH</strong> music from your new favorite artist:</div>
        </div>
        <span style="position:relative;top:-20px;padding:8px;background:rgba(15,11,34,.9);color:#fff86a;font-size:clamp(11px, 2.7vw, 15px);font-weight:800;line-height:1.25;text-shadow:0 1px 3px #000,1px 1px 2px #000;">Listen to Greggy FEESH and the Phlops on <strong style="color:#1db954;">Spotify</strong> &rarr;</span>
    </a>`;
    const feeshAdArticleStyle = isThanksgivingWindow
        ? ''
        : 'style="padding:0;background:#fff;border-color:#fff"';
    const gameCards = issue.games.map(game => card(game, modern));
    let cards = gameCards;
    const definitions = /<!-- SPONSOR-DEFINITIONS-START -->([\s\S]*?)<!-- SPONSOR-DEFINITIONS-END -->/;
    const match = template.match(definitions);
    if (match) {
        const sponsors = [...match[1].matchAll(/<!-- SPONSOR-START -->\s*([\s\S]*?)\s*<!-- SPONSOR-END -->/g)]
            .map(item => item[1]
                .replaceAll('{{FEESH_AD_ARTICLE_STYLE}}', feeshAdArticleStyle)
                .replaceAll('{{FEESH_AD_CONTENT}}', feeshAdContent)
                .replaceAll('{{NFL_AD_CONTENT}}', renderNflPromo('{{ROOT}}')));
        if (![3, 5].includes(sponsors.length) || !template.includes('<!-- GAME-CARDS -->')) {
            throw new Error('Invalid NBA sponsor definitions or missing game cards marker');
        }
        template = template.replace(definitions, '');
        if (cards.length) {
            const insertions = new Map();
            sponsors.forEach((sponsor, index) => {
                const position = sponsors.length === 5 && index === sponsors.length - 1 ? cards.length :
                    cards.length === 1 ? 1 :
                        Math.max(1, Math.min(cards.length - 1, Math.round((index + 1) * cards.length / (sponsors.length === 5 ? 5 : 4))));
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
        if (prefix === '../../') cards.splice(cards.lastIndexOf(gameCards[gameCards.length - 1]) + 1, 0, resultLegend());
        cards.unshift(`<section class="game-card" aria-label="Projection results"><h2>Projection results</h2><p>Final games: ${finished} of ${issue.games.length}. Records are wins-losses-pushes; games without a projection or line are excluded.</p><p>Winners: ${recordString(totals.winner)} &nbsp; | &nbsp; Against the spread: ${recordString(totals.adjustedAts)} &nbsp; | &nbsp; Over/under: ${recordString(totals.total)}</p></section>`);
    }
    return template.replace('Lines are snapshots and may change.', 'Comparison spreads may differ from available betting lines.')
        .replace('<!-- MATCHUP-WORDING-V2 -->', '')
        .replaceAll('{{ROOT}}', prefix)
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
        return `<tr><td><a href="${issueName(issue)}">${escapeHtml(issue.date)} (Issue ${issue.number})</a></td><td>${recordString(sum.winner)}${mark}</td><td></td><td>${recordString(sum.adjustedAts)}${mark}</td><td></td><td>${recordString(sum.total)}${mark}</td></tr>`;
    });
    const totalMark = (complete.some(issue => marker(issue) === '*') ? '*' : '') + (complete.some(issue => marker(issue) === '?') ? '?' : '');
    const percentage = record => record.win + record.loss ? `${(100 * record.win / (record.win + record.loss)).toFixed(2)}%` : 'N/A';
    rows.push(`<tr><th>Season total</th><th>${recordString(totals.winner)}${totalMark}</th><td>${percentage(totals.winner)}</td><th>${recordString(totals.adjustedAts)}${totalMark}</th><td>${percentage(totals.adjustedAts)}</td><th>${recordString(totals.total)}${totalMark}</th></tr>`);
    const artwork = season === 2026 ? '<img class="header-scoreboard" src="../../images/archive-scoreboard.svg" alt="">' : '';
    const lineNotice = season === 2026
        ? 'Point spreads and totals used are automatically calculated at publication time, which may differ from available betting lines.'
        : 'Season percentages exclude pushes. Comparison spreads may differ from available betting lines.';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${season} NBA archives</title><link rel="stylesheet" href="../../nba.css"></head><body><main class="page"><header class="header"><p><a href="../../index.html">Home</a> &middot; <a href="../index.html">All archives</a> &middot; <a href="../../disclaimer.html">Disclaimer</a></p><div class="header-art-layout"><div><h1>${season}&ndash;${String(season + 1).slice(-2)} archives</h1><p>Records are wins-losses-pushes. Games without a projection or line are excluded from the relevant record. ${lineNotice}</p></div>${artwork}</div></header><div class="game-card table-wrap"><table class="season-table"><thead><tr><th>Issue</th><th>Winner</th><th aria-label="Winner percentage"></th><th>Against<br>the&nbsp;spread</th><th aria-label="Against the spread percentage"></th><th>Over/under</th></tr></thead><tbody>${rows.join('\n')}</tbody></table>${resultLegend()}</div><div class="sponsor-stack">${renderNflPromo('../../')}</div></main></body></html>\n`;
}

function renderArchivesIndex(issues) {
    const seasons = [...new Set(issues.filter(issue => issue.archived).map(issue => issue.season))].sort((a, b) => b - a);
    const links = seasons.map(season => `<li><a href="${season}/index.html">${season}&ndash;${String(season + 1).slice(-2)} season</a></li>`).join('\n');
    const classic = [2017, 2016, 2015, 2014, 2013, 2012, 2011].map(year => `<li><a href="${year}/index.html">${year} classic issues</a></li>`).join('\n');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NBA archives</title><link rel="stylesheet" href="../nba.css"></head><body><main class="page"><header class="header"><p><a href="../index.html">Home</a> &middot; <a href="../NBATMP.htm">Today's projections</a> &middot; <a href="../disclaimer.html">Disclaimer</a></p><div class="header-art-layout"><div><p class="eyebrow">The NBA Edge</p><h1>NBA archives</h1><p>Explore completed daily issues and a selection from the classic NBA Edge.</p></div><img class="legacy-basketball" src="../images/legacy-basketball.svg" alt=""></div></header><section class="game-card archive-list"><h2>Season archives</h2>${links ? `<ul>${links}</ul>` : '<p>No completed daily issues yet.</p>'}</section><section class="game-card archive-list"><h2>Classic NBA Edge</h2><p>Explore preserved historical issues and season records. Historical projections and results are presented as published and do not represent current performance.</p><ul>${classic}</ul></section><div class="sponsor-stack">${renderNflPromo('../')}</div></main></body></html>\n`;
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

module.exports = { adjustedSpread, gameResults, hash, issueName, renderArchivesIndex, renderIssue, renderNflPromo, renderSeasonIndex, summarize, writeAtomic };
