'use strict';

const db = require('../db');

async function listFriends(req, res) {
    try {
        const { rows } = await db.query(
            `SELECT u.id, u.username, u.avatar_url, u.is_online, f.status
             FROM friendships f
             JOIN users u ON u.id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
             WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
             ORDER BY u.username`,
            [req.user.user_id]
        );
        res.json({ friends: rows });
    } catch (err) {
        console.error('[FRIENDS] listFriends:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function listPendingRequests(req, res) {
    try {
        const { rows } = await db.query(
            `SELECT u.id, u.username, u.avatar_url, f.created_at
             FROM friendships f
             JOIN users u ON u.id = f.user_id
             WHERE f.friend_id = $1 AND f.status = 'pending'
             ORDER BY f.created_at DESC`,
            [req.user.user_id]
        );
        res.json({ requests: rows });
    } catch (err) {
        console.error('[FRIENDS] listPendingRequests:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function sendRequest(req, res) {
    const friendId = parseInt(req.params.id);
    if (!friendId || friendId === req.user.user_id)
        return res.status(400).json({ error: 'Invalid user id' });
    try {
        await db.query(
            `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING`,
            [req.user.user_id, friendId]
        );
        res.status(201).json({ ok: true });
    } catch (err) {
        console.error('[FRIENDS] sendRequest:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function acceptRequest(req, res) {
    const requesterId = parseInt(req.params.id);
    try {
        const { rowCount } = await db.query(
            `UPDATE friendships SET status = 'accepted', updated_at = NOW()
             WHERE user_id = $1 AND friend_id = $2 AND status = 'pending'`,
            [requesterId, req.user.user_id]
        );
        if (!rowCount) return res.status(404).json({ error: 'Request not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[FRIENDS] acceptRequest:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function removeFriend(req, res) {
    const otherId = parseInt(req.params.id);
    try {
        await db.query(
            `DELETE FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
            [req.user.user_id, otherId]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('[FRIENDS] removeFriend:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

module.exports = { listFriends, listPendingRequests, sendRequest, acceptRequest, removeFriend };