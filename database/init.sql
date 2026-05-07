-- ============================================================
--  database/init.sql
--  Se ejecuta automáticamente al crear el contenedor PostgreSQL
--  (solo si el volumen está vacío)
-- ============================================================

-- ─── Extensión para UUIDs (sesiones) ──────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Usuarios ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50)  UNIQUE NOT NULL,
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,          -- bcrypt hash
    avatar_url    VARCHAR(500) DEFAULT '/avatars/default.png',
    is_online     BOOLEAN      DEFAULT FALSE,
    role          VARCHAR(20)  DEFAULT 'user',    -- 'user' | 'admin' | 'moderator'
    totp_secret   VARCHAR(64),                    -- 2FA (módulo opcional)
    totp_enabled  BOOLEAN      DEFAULT FALSE,
    created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- ─── Sesiones ─────────────────────────────────────────────
-- Sesiones simples: token opaco guardado en cookie HttpOnly.
-- El servidor valida token → user_id en cada request.
CREATE TABLE IF NOT EXISTS sessions (
    token      VARCHAR(128) PRIMARY KEY,          -- gen_random_uuid() o crypto.randomBytes
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Amigos ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friendships (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    friend_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
    status     VARCHAR(20) DEFAULT 'pending',     -- 'pending' | 'accepted' | 'blocked'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id)
);

-- ─── Mensajes de chat ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
    id          SERIAL PRIMARY KEY,
    sender_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    receiver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    content     TEXT NOT NULL,
    is_read     BOOLEAN   DEFAULT FALSE,
    sent_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Partidas ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS matches (
    id          SERIAL PRIMARY KEY,
    player1_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    player2_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    score1      INTEGER   DEFAULT 0,
    score2      INTEGER   DEFAULT 0,
    winner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    game_type   VARCHAR(50) DEFAULT 'brawler',    -- nombre del juego
    played_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Estadísticas de usuario (módulo Game Statistics) ────
CREATE TABLE IF NOT EXISTS user_stats (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    wins        INTEGER DEFAULT 0,
    losses      INTEGER DEFAULT 0,
    xp          INTEGER DEFAULT 0,
    level       INTEGER DEFAULT 1,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Torneos ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tournaments (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    status      VARCHAR(20) DEFAULT 'open',       -- 'open' | 'ongoing' | 'finished'
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tournament_players (
    tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
    user_id       INTEGER REFERENCES users(id)       ON DELETE CASCADE,
    eliminated    BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (tournament_id, user_id)
);

CREATE TABLE IF NOT EXISTS tournament_matches (
    id            SERIAL PRIMARY KEY,
    tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
    match_id      INTEGER REFERENCES matches(id)     ON DELETE SET NULL,
    round         INTEGER NOT NULL
);

-- ─── Logros / Gamificación ────────────────────────────────
CREATE TABLE IF NOT EXISTS achievements (
    id          SERIAL PRIMARY KEY,
    key         VARCHAR(50) UNIQUE NOT NULL,      -- 'first_win', 'combo_master', …
    name        VARCHAR(100) NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS user_achievements (
    user_id        INTEGER REFERENCES users(id)       ON DELETE CASCADE,
    achievement_id INTEGER REFERENCES achievements(id) ON DELETE CASCADE,
    earned_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, achievement_id)
);

-- ─── Notificaciones ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    type       VARCHAR(50) NOT NULL,              -- 'friend_request', 'match_invite', …
    payload    JSONB,
    is_read    BOOLEAN   DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Índices ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sessions_user      ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires   ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_matches_player1    ON matches(player1_id);
CREATE INDEX IF NOT EXISTS idx_matches_player2    ON matches(player2_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender    ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver  ON messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_notif_user         ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_tournament_matches ON tournament_matches(tournament_id);

-- ─── Logros de ejemplo ────────────────────────────────────
INSERT INTO achievements (key, name, description) VALUES
    ('first_win',    'Primera victoria',  'Gana tu primera partida'),
    ('combo_master', 'Maestro del combo', 'Ejecuta un combo completo'),
    ('social',       'Sociable',          'Añade a tu primer amigo')
ON CONFLICT DO NOTHING;

-- ─── Usuario de prueba (contraseña: "test1234") ───────────
-- Hash generado con bcrypt rounds=10.
-- ¡Borrar en producción o cambiar el hash!
INSERT INTO users (username, email, password_hash, role)
VALUES ('testuser', 'test@example.com', '$2b$10$placeholder_hash_change_me', 'admin')
ON CONFLICT DO NOTHING;

-- Estadísticas vacías para el usuario de prueba
INSERT INTO user_stats (user_id)
SELECT id FROM users WHERE username = 'testuser'
ON CONFLICT DO NOTHING;