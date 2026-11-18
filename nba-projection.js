'use strict';

const DEFAULT_MULTIPLIERS = { '1.0': 2.4, '0.75': 2.2, '0.5': 2.0, '0.25': 1.66, '0.0': 1.5 };

function modelConfig(env = process.env) {
    const keys = { '1.0': 'PG_PI0', '0.75': 'PG_PI7', '0.5': 'PG_PPI5', '0.25': 'PG_PI2', '0.0': 'PG_PI_X' };
    const multipliers = {};
    for (const [bucket, key] of Object.entries(keys)) {
        multipliers[bucket] = env[key] ? Number(env[key]) : DEFAULT_MULTIPLIERS[bucket];
        if (!Number.isFinite(multipliers[bucket]) || multipliers[bucket] < 0) throw new Error(`Invalid ${key}`);
    }
    const margin = env.PG_MD ? Number(env.PG_MD) : 2;
    if (!Number.isFinite(margin) || margin < 0) throw new Error('Invalid PG_MD');
    return { multipliers, margin };
}

function bucket(wins, games) {
    const percentage = wins / games;
    if (percentage >= 0.8) return '1.0';
    if (percentage >= 0.6) return '0.75';
    if (percentage >= 0.4) return '0.5';
    if (percentage >= 0.2) return '0.25';
    return '0.0';
}

// Python's round uses ties-to-even, unlike Math.round.
function roundEven(value) {
    const lower = Math.floor(value);
    if (value - lower === 0.5) return lower % 2 === 0 ? lower : lower + 1;
    return Math.round(value);
}

function rawScore(team, opponent, config) {
    const confidence = bucket(team.wins, team.gp);
    const base = team.pf_sum / (team.gp * 4) + opponent.pa_sum / (opponent.gp * 4);
    let score = base * config.multipliers[confidence];
    let rounder = roundEven;
    if (Number(confidence) >= 0.75) {
        score += config.margin;
        rounder = Math.ceil;
    } else if (Number(confidence) <= 0.25) {
        score -= config.margin;
        rounder = Math.floor;
    }
    return { score, rounded: Math.max(0, rounder(score)) };
}

function projectMatchup(away, home, config = modelConfig()) {
    if (!away || !home || away.gp !== 4 || home.gp !== 4) return null;
    const a = rawScore(away, home, config);
    const h = rawScore(home, away, config);
    if (a.rounded === h.rounded) {
        if (a.score > h.score) a.rounded++;
        else h.rounded++;
    }
    return { away: a.rounded, home: h.rounded };
}

module.exports = { bucket, modelConfig, projectMatchup, rawScore, roundEven };
