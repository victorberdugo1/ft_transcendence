'use strict';

const db = require('../db');

async function listNotifications(req, res) {
    try {
        const { rows } = await db.query(
            `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
            [req.user.user_id]
        );
        res.json({ notifications: rows });
    } catch {
        res.status(500).json({ error: 'Internal error' });
    }
}

async function markAllRead(req, res) {
    try {
        await db.query(`UPDATE notifications SET is_read = TRUE WHERE user_id = $1`, [req.user.user_id]);
        res.json({ ok: true });
    } catch {
        res.status(500).json({ error: 'Internal error' });
    }
}

async function markOneRead(req, res) {
    try {
        await db.query(
            `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
            [req.params.id, req.user.user_id]
        );
        res.json({ ok: true });
    } catch {
        res.status(500).json({ error: 'Internal error' });
    }
}

module.exports = { listNotifications, markAllRead, markOneRead };