'use strict';

const fs = require('node:fs');
const path = require('node:path');
const parse5 = require('parse5');
const { renderNflPromo } = require('../nba-publish');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'archives', 'nbaedge');
const DESTINATION = path.join(ROOT, 'archives');
const YEARS = ['2013', '2014', '2015', '2016'];
const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'h1', 'h2', 'h3', 'h4', 'h5',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'blockquote', 'div', 'span', 'center']);
const OMIT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta', 'base', 'title', 'noscript']);
const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;

function candidates() {
    const sources = new Map();
    for (const dir of [SOURCE, ...YEARS.map(year => path.join(SOURCE, year))]) {
        if (!fs.existsSync(dir)) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const match = /^nba(1[1-7])[^/\\]*\.(?:htm|html|xhtml)$/i.exec(entry.name);
            if (!match) continue;
            const year = `20${match[1]}`;
            const key = `${year}/${entry.name.toLowerCase()}`;
            // Season-directory copies take precedence over root-level duplicates.
            if (!sources.has(key) || path.basename(dir) === year) {
                const outputName = entry.name.replace(/\.xhtml$/i, '.xhtml.html');
                sources.set(key, { year, name: entry.name, outputName, source: path.join(dir, entry.name) });
            }
        }
    }
    for (const [year, name, dir] of [
        ['2012', 'nbaOS.htm', SOURCE],
        ['2013', 'nba0S.htm', path.join(SOURCE, '2013')]
    ]) {
        const source = path.join(dir, name);
        if (fs.existsSync(source)) sources.set(`${year}/${name.toLowerCase()}`, { year, name, outputName: name, source });
    }
    return [...sources.values()].sort((a, b) => a.year.localeCompare(b.year) || a.name.localeCompare(b.name));
}

function hasTag(node, tag) {
    return node.tagName === tag || (node.childNodes || []).some(child => hasTag(child, tag));
}

function textContent(node) {
    if (node.nodeName === '#text') return node.value;
    if (OMIT.has(node.tagName) || node.nodeName === '#comment') return '';
    return (node.childNodes || []).map(textContent).join(' ');
}

function hasTrustedPokerLink(node) {
    const href = attr(node, 'href');
    let trusted = false;
    if (href) {
        try {
            const host = new URL(href).hostname.toLowerCase();
            trusted = host === '888poker.com' || host === 'www.888poker.com';
        } catch {
            trusted = false;
        }
    }
    return trusted || (node.childNodes || []).some(hasTrustedPokerLink);
}

function banner(trustedPoker = false) {
    const image = '<!-- advertisement --><a href="../../NBATMP.htm"><img class="classic-ad-banner" src="../../images/nbaedgeban.gif" alt="The NBA Edge: current projections"></a>';
    return trustedPoker ? `${image}<p class="classic-poker">Historical sponsor: <a href="https://www.888poker.com/" rel="noopener noreferrer">888poker</a> (availability varies by location).</p>` : image;
}

function localHref(href, year, lookup) {
    if (!href || href.startsWith('#')) return href || null;
    const clean = href.split(/[?#]/)[0].replace(/\\/g, '/');
    const name = clean.slice(clean.lastIndexOf('/') + 1).toLowerCase();
    if (!/^nba1[1-7][^/]*\.(?:htm|html|xhtml)$/.test(name)) return null;
    const targetYear = `20${name.slice(3, 5)}`;
    const target = lookup.get(`${targetYear}/${name}`);
    return target ? (targetYear === year ? encodeURI(target.outputName) : `../${targetYear}/${encodeURI(target.outputName)}`) : null;
}

function renderNode(node, context) {
    if (node.nodeName === '#text') return escape(node.value);
    if (node.nodeName === '#comment' || OMIT.has(node.tagName)) return '';
    if (node.tagName === 'img') {
        const width = Number(attr(node, 'width'));
        const height = Number(attr(node, 'height'));
        if ((width && width <= 2) || (height && height <= 2)) return '';
        return banner();
    }
    const children = node.childNodes || [];
    if ((node.tagName === 'center' || node.tagName === 'table') && (hasTag(node, 'img') || hasTag(node, 'script') || hasTag(node, 'object')) &&
        textContent(node).replace(/\s+/g, ' ').trim().length < 250) {
        return banner(hasTrustedPokerLink(node));
    }
    if (node.tagName === 'a') {
        const href = attr(node, 'href');
        if (hasTag(node, 'img')) return banner(hasTrustedPokerLink(node));
        if (href && /^(?:https?:)?\/\/(?:www\.)?888poker\.com(?:\/|$)/i.test(href)) {
            return `<a href="https://www.888poker.com/" rel="noopener noreferrer">${children.map(child => renderNode(child, context)).join('')}</a>`;
        }
        const local = localHref(href, context.year, context.lookup);
        const content = children.map(child => renderNode(child, context)).join('');
        const label = textContent(node).replace(/\s+/g, ' ').trim();
        if (!local && /^(?:\*+\s*)?(?:click here for (?:the )?live|www\.)/i.test(label)) return '';
        return local ? `<a href="${escape(local)}">${content}</a>` : content;
    }
    if (node.tagName === 'font') {
        const color = attr(node, 'color');
        const colors = { '#009900': '#7ee08c', '#cc0000': '#ff9696', green: '#7ee08c', red: '#ff9696' };
        const mapped = color && colors[color.toLowerCase()];
        const safeColor = mapped ? ` style="color:${mapped}"` : '';
        return `<span${safeColor}>${children.map(child => renderNode(child, context)).join('')}</span>`;
    }
    const content = children.map(child => renderNode(child, context)).join('');
    if (!ALLOWED.has(node.tagName)) return content;
    const attributes = ['td', 'th'].includes(node.tagName) ? ['colspan', 'rowspan'].map(name => {
        const value = attr(node, name);
        return value && /^\d{1,2}$/.test(value) ? ` ${name}="${value}"` : '';
    }).join('') : '';
    if (node.tagName === 'br') return '<br>';
    return `<${node.tagName}${attributes}>${content}</${node.tagName}>`;
}

function convert(source, lookup) {
    const bytes = fs.readFileSync(source.source);
    const decoder = new TextDecoder('windows-1252');
    const prefix = bytes.subarray(0, 1000).toString('ascii');
    const text = bytes[0] === 0xff && bytes[1] === 0xfe ? new TextDecoder('utf-16le').decode(bytes) :
        bytes[0] === 0xfe && bytes[1] === 0xff ? new TextDecoder('utf-16be').decode(bytes) :
            /(?:utf-8)/i.test(prefix) ? new TextDecoder('utf-8').decode(bytes) : decoder.decode(bytes);
    const document = parse5.parse(text);
    const html = document.childNodes.find(node => node.tagName === 'html');
    const body = html?.childNodes.find(node => node.tagName === 'body');
    if (!body) throw new Error(`Missing body in ${source.source}`);
    const content = renderNode(body, { year: source.year, lookup });
    if (textContent(body).trim().length < 40) throw new Error(`No meaningful content in ${source.source}`);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(source.year)} NBA Edge | ${escape(source.name)}</title><link rel="stylesheet" href="../../nba.css"></head>
<body><main class="page"><header class="header"><p><a href="../../index.html">Home</a> &middot; <a href="../index.html">Archives</a> &middot; <a href="index.html">${source.year} issues</a></p><p class="eyebrow">From the classic NBA Edge</p><h1>${source.year} archive</h1><p>Historical issue: ${escape(source.name)}. Picks, results and commentary reflect the original publication and are not current advice.</p></header><article class="game-card classic-issue">${content}</article></main></body></html>\n`;
}

function seasonIndex(year, sources) {
    const entries = sources.filter(item => item.year === year);
    const rows = entries.map(item => `<li><a href="${escape(encodeURI(item.outputName))}">${escape(item.name)}</a></li>`).join('\n');
    const records = {
        '2013': '<p>The <a href="nba13arch.html">2013 season archive</a> reports 77.08% winners. Explore the recovered and reconstructed issues rescued from the classic NBA Edge vault.</p>',
        '2014': '<p>The <a href="nba14-arch.html">2014 season archive</a> reports a fantastic 83.33% against the spread. Explore the recovered issues and alternate versions from the classic NBA Edge vault.</p>',
        '2015': '<p>The <a href="nba15-arch.xhtml.html">2015 season archive</a> reports a standout 92.31% against the spread. Classic selections also ventured beyond the NBA into NCAA basketball. Explore the recovered issues and alternate versions from the classic NBA Edge vault.</p>',
        '2016': '<p>The <a href="nba16-arch.html">2016 season archive</a> boasts 90.48% winners and 85.71% against the spread. Our classic selections expanded beyond the NBA into NCAA basketball, bringing readers even more winners!</p>'
    };
    const record = records[year] ? `<section class="game-card archive-list"><h2>Historical archives</h2>${records[year]}<p>ATS means against the spread. Classic picks were curated from computer projections; today's NBA Edge publishes the computer's projections directly.</p></section>` : '';
    const intro = year === '2017'
        ? 'This was a short run as operations wound down. These are the 2017 issues we were able to recover; other issues may no longer be available.'
        : year === '2011' || year === '2012'
            ? 'These recovered and reconstructed pages come from Wayback Machine snapshots and may not include every issue published that year.'
            : 'Explore recovered and reconstructed classic issues, records, and alternate versions preserved from the NBA Edge vault.';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${year} classic NBA Edge archives</title><link rel="stylesheet" href="../../nba.css"></head><body><main class="page"><header class="header"><p><a href="../../index.html">Home</a> &middot; <a href="../index.html">All archives</a> &middot; <a href="../../disclaimer.html">Disclaimer</a></p><p class="eyebrow">Classic NBA Edge</p><h1>${year} archives</h1><p>${intro}</p></header>${record}<section class="game-card archive-list"><h2>Issues and records</h2><ul>${rows}</ul></section><div class="sponsor-stack">${renderNflPromo('../../')}</div></main></body></html>\n`;
}

function build() {
    const sources = candidates();
    if (!sources.length) throw new Error(`No classic NBA issue files found in ${SOURCE}`);
    const lookup = new Map(sources.map(source => [`${source.year}/${source.name.toLowerCase()}`, source]));
    const files = sources.map(source => ({ file: path.join(DESTINATION, source.year, source.outputName), html: convert(source, lookup) }));
    for (const year of new Set(sources.map(source => source.year))) {
        files.push({ file: path.join(DESTINATION, year, 'index.html'), html: seasonIndex(year, sources) });
    }
    for (const { file, html } of files) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, html, 'utf8');
    }
    console.log(`Created ${sources.length} classic pages in ${[...new Set(sources.map(source => source.year))].join(', ')}`);
}

if (require.main === module) build();
module.exports = { banner, candidates, convert, localHref, seasonIndex };
