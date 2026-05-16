'use strict';

const db = require('../db');

async function getProfile(req, res) {
    const userId = parseInt(req.params.id);
    try {
        const { rows } = await db.query(
            `SELECT id, username, avatar_url, is_online, role, created_at FROM users WHERE id = $1`,
            [userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        res.json({ user: rows[0] });
    } catch (err) {
        console.error('[PROFILE] getProfile:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function updateProfile(req, res) {
    const { username, avatar_url } = req.body ?? {};
    if (!username?.trim() && !avatar_url?.trim())
        return res.status(400).json({ error: 'Nothing to update' });
    try {
        const { rows } = await db.query(
            `UPDATE users SET username = COALESCE($1, username), avatar_url = COALESCE($2, avatar_url), updated_at = NOW()
             WHERE id = $3 RETURNING id, username, email, avatar_url, role`,
            [username?.trim() || null, avatar_url?.trim() || null, req.user.user_id]
        );
        res.json({ user: rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
        console.error('[PROFILE] updateProfile:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function getUserStats(req, res) {
    const userId = parseInt(req.params.id);
    try {
        const { rows } = await db.query(
            `SELECT s.wins, s.losses, s.draws, s.win_streak, s.best_streak, s.xp, s.level, s.updated_at,
                    u.username, u.avatar_url
             FROM user_stats s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`,
            [userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Stats not found' });
        res.json({ stats: rows[0] });
    } catch (err) {
        console.error('[PROFILE] getUserStats:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function getMatchHistory(req, res) {
    const userId = parseInt(req.params.id);
    try {
        const { rows } = await db.query(
            `SELECT m.id, m.score1, m.score2, m.game_type, m.played_at, m.winner_id,
                    u1.username AS player1, u1.avatar_url AS avatar1,
                    u2.username AS player2, u2.avatar_url AS avatar2
             FROM matches m
             LEFT JOIN users u1 ON u1.id = m.player1_id
             LEFT JOIN users u2 ON u2.id = m.player2_id
             WHERE m.player1_id = $1 OR m.player2_id = $1
             ORDER BY m.played_at DESC LIMIT 20`,
            [userId]
        );
        res.json({ matches: rows });
    } catch (err) {
        console.error('[PROFILE] getMatchHistory:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function getUserAchievements(req, res) {
    const userId = parseInt(req.params.id);
    try {
        const { rows } = await db.query(
            `SELECT a.key, a.name, a.description, ua.earned_at
             FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id
             WHERE ua.user_id = $1 ORDER BY ua.earned_at DESC`,
            [userId]
        );
        res.json({ achievements: rows });
    } catch (err) {
        console.error('[PROFILE] getUserAchievements:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function exportData(req, res) {
    try {
        const [{ rows: [user] }, { rows: [stats] }, { rows: history }, { rows: achievements }] = await Promise.all([
            db.query(`SELECT id, username, email, avatar_url, created_at FROM users WHERE id = $1`,
                [req.user.user_id]),
            db.query(`SELECT * FROM user_stats WHERE user_id = $1`,
                [req.user.user_id]),
            db.query(
                `SELECT m.id, m.score1, m.score2, m.game_type, m.played_at, m.winner_id,
                        u1.username AS player1, u2.username AS player2
                 FROM matches m
                 LEFT JOIN users u1 ON u1.id = m.player1_id
                 LEFT JOIN users u2 ON u2.id = m.player2_id
                 WHERE m.player1_id = $1 OR m.player2_id = $1 ORDER BY m.played_at DESC`,
                [req.user.user_id]),
            db.query(
                `SELECT a.key, a.name, a.description, ua.earned_at
                 FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id
                 WHERE ua.user_id = $1`,
                [req.user.user_id]),
        ]);
        res.json({ user: user ?? null, stats: stats ?? null, history, achievements });
    } catch (err) {
        console.error('[PROFILE] exportData:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function deleteAccount(req, res) {
    try {
        await db.query(`DELETE FROM users WHERE id = $1`, [req.user.user_id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('[PROFILE] deleteAccount:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

module.exports = { getProfile, updateProfile, getUserStats, getMatchHistory, getUserAchievements, exportData, deleteAccount };