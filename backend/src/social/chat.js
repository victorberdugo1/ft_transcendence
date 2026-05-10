'use strict';

/**
 * social/chat.js
 * ──────────────
 * Mensajes directos entre usuarios.
 *
 * GET  /api/messages/:userId   → conversación completa con :userId (más antiguo primero)
 * POST /api/messages/:userId   → enviar mensaje a :userId
 * PUT  /api/messages/:userId/read → marcar como leídos todos los mensajes de :userId
 * GET  /api/messages/unread    → número de mensajes no leídos por remitente
 */

const db = require('../db');

async function getConversation(req, res) {
    const otherId = parseInt(req.params.userId);
    if (!otherId) return res.status(400).json({ error: 'Invalid user id' });

    try {
        const { rows } = await db.query(
            `SELECT id, sender_id, receiver_id, content, is_read, sent_at
             FROM messages
             WHERE (sender_id = $1 AND receiver_id = $2)
                OR (sender_id = $2 AND receiver_id = $1)
             ORDER BY sent_at ASC`,
            [req.user.user_id, otherId]
        );
        res.json({ messages: rows });
    } catch (err) {
        console.error('[CHAT] getConversation error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function sendMessage(req, res) {
    const receiverId = parseInt(req.params.userId);
    const { content } = req.body ?? {};

    if (!receiverId || receiverId === req.user.user_id)
        return res.status(400).json({ error: 'Invalid receiver id' });
    if (!content || !content.trim())
        return res.status(400).json({ error: 'content is required' });

    try {
        const { rows } = await db.query(
            `INSERT INTO messages (sender_id, receiver_id, content)
             VALUES ($1, $2, $3)
             RETURNING id, sender_id, receiver_id, content, is_read, sent_at`,
            [req.user.user_id, receiverId, content.trim()]
        );
        res.status(201).json({ message: rows[0] });
    } catch (err) {
        console.error('[CHAT] sendMessage error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function markRead(req, res) {
    const senderId = parseInt(req.params.userId);
    try {
        await db.query(
            `UPDATE messages SET is_read = TRUE
             WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE`,
            [senderId, req.user.user_id]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('[CHAT] markRead error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function unreadCounts(req, res) {
    try {
        const { rows } = await db.query(
            `SELECT sender_id, COUNT(*) AS count
             FROM messages
             WHERE receiver_id = $1 AND is_read = FALSE
             GROUP BY sender_id`,
            [req.user.user_id]
        );
        res.json({ unread: rows });
    } catch (err) {
        console.error('[CHAT] unreadCounts error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

module.exports = { getConversation, sendMessage, markRead, unreadCounts };
