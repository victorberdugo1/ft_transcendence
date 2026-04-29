-- ============================================================
--  database/init.sql
--  Se ejecuta automáticamente al crear el contenedor de PostgreSQL
--  (solo si el volumen está vacío)
-- ============================================================

-- ─── Usuarios ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50)  UNIQUE NOT NULL,
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    avatar_url    VARCHAR(500),
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Partidas ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS matches (
    id            SERIAL PRIMARY KEY,
    player1_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    player2_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    score1        INTEGER DEFAULT 0,
    score2        INTEGER DEFAULT 0,
    winner_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    played_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Amigos (User Management module) ──────────────────────
CREATE TABLE IF NOT EXISTS friendships (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    friend_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id)
);

-- ─── Mensajes de chat (Web module: User interaction) ──────
CREATE TABLE IF NOT EXISTS messages (
    id            SERIAL PRIMARY KEY,
    sender_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    receiver_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    content       TEXT NOT NULL,
    sent_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Índices ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_matches_player1  ON matches(player1_id);
CREATE INDEX IF NOT EXISTS idx_matches_player2  ON matches(player2_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender  ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);

-- Usuario de prueba (contraseña: "test1234")
-- Hash generado con bcrypt rounds=10
-- En producción: borrar esto
INSERT INTO users (username, email, password_hash)
VALUES ('testuser', 'test@example.com', '$2b$10$placeholder_hash_change_me')
ON CONFLICT DO NOTHING;
