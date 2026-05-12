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
    password_hash VARCHAR(255) NOT NULL,
    avatar_url    VARCHAR(500) DEFAULT '/avatars/default.png',
    is_online     BOOLEAN      DEFAULT FALSE,
    role          VARCHAR(20)  DEFAULT 'user'    CHECK (role IN ('user', 'admin', 'moderator')),
    totp_secret   VARCHAR(64),                    -- 2FA (módulo opcional)
    totp_enabled  BOOLEAN      DEFAULT FALSE,
    created_at    TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP,
    -- Garantiza coherencia: si totp_enabled=TRUE, debe existir totp_secret
    CONSTRAINT chk_totp CHECK (totp_enabled = FALSE OR totp_secret IS NOT NULL)
);

-- Actualiza updated_at automáticamente en cada UPDATE
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Sesiones ─────────────────────────────────────────────
-- Token opaco guardado en cookie HttpOnly.
-- El servidor valida token → user_id en cada request.
CREATE TABLE IF NOT EXISTS sessions (
    token      VARCHAR(128) PRIMARY KEY,
    user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ  NOT NULL,
    created_at TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ─── Amigos ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friendships (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status     VARCHAR(20) NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'accepted', 'blocked')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id),
    -- Evita duplicados simétricos (A→B y B→A al mismo tiempo)
    CONSTRAINT chk_friendship_no_self CHECK (user_id <> friend_id)
);

CREATE TRIGGER trg_friendships_updated_at
    BEFORE UPDATE ON friendships
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Mensajes de chat ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
    id          SERIAL PRIMARY KEY,
    sender_id   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
    receiver_id INTEGER     REFERENCES users(id) ON DELETE SET NULL,
    content     TEXT        NOT NULL CHECK (content <> ''),
    is_read     BOOLEAN     DEFAULT FALSE,
    sent_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_sender   ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);
-- Índice compuesto útil para cargar conversaciones ordenadas
CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id), sent_at);

-- ─── Partidas ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS matches (
    id         SERIAL PRIMARY KEY,
    player1_id INTEGER     REFERENCES users(id) ON DELETE SET NULL,
    player2_id INTEGER     REFERENCES users(id) ON DELETE SET NULL,
    score1     INTEGER     DEFAULT 0 CHECK (score1 >= 0),
    score2     INTEGER     DEFAULT 0 CHECK (score2 >= 0),
    winner_id  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
    game_type  VARCHAR(50) DEFAULT 'brawler',
    played_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    ended_at   TIMESTAMPTZ,
    duration_s INTEGER     CHECK (duration_s IS NULL OR duration_s >= 0),
    -- El ganador debe ser uno de los dos jugadores (o NULL si empate/inacabada)
    CONSTRAINT chk_winner CHECK (
        winner_id IS NULL OR winner_id = player1_id OR winner_id = player2_id
    ),
    -- ended_at no puede ser anterior a played_at
    CONSTRAINT chk_match_dates CHECK (
        ended_at IS NULL OR ended_at >= played_at
    )
);

CREATE INDEX IF NOT EXISTS idx_matches_player1   ON matches(player1_id);
CREATE INDEX IF NOT EXISTS idx_matches_player2   ON matches(player2_id);
CREATE INDEX IF NOT EXISTS idx_matches_played_at ON matches(played_at DESC);

-- ─── Estadísticas de usuario ──────────────────────────────
CREATE TABLE IF NOT EXISTS user_stats (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    wins        INTEGER     DEFAULT 0 CHECK (wins >= 0),
    losses      INTEGER     DEFAULT 0 CHECK (losses >= 0),
    draws       INTEGER     DEFAULT 0 CHECK (draws >= 0),
    win_streak  INTEGER     DEFAULT 0 CHECK (win_streak >= 0),
    best_streak INTEGER     DEFAULT 0 CHECK (best_streak >= 0),
    xp          INTEGER     DEFAULT 0 CHECK (xp >= 0),
    level       INTEGER     DEFAULT 1 CHECK (level >= 1),
    updated_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    -- La racha actual nunca puede superar la mejor racha histórica
    CONSTRAINT chk_streak CHECK (win_streak <= best_streak)
);

-- ─── Torneos ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tournaments (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(100) NOT NULL CHECK (name <> ''),
    status     VARCHAR(20)  NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'ongoing', 'finished')),
    created_by INTEGER      REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tournament_players (
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
    eliminated    BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (tournament_id, user_id)
);

CREATE TABLE IF NOT EXISTS tournament_matches (
    id            SERIAL  PRIMARY KEY,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    match_id      INTEGER REFERENCES matches(id) ON DELETE SET NULL,
    round         INTEGER NOT NULL CHECK (round >= 1),
    match_order   INTEGER DEFAULT 0 CHECK (match_order >= 0)
);

CREATE INDEX IF NOT EXISTS idx_tournament_matches ON tournament_matches(tournament_id);

-- ─── Logros / Gamificación ────────────────────────────────
CREATE TABLE IF NOT EXISTS achievements (
    id          SERIAL PRIMARY KEY,
    key         VARCHAR(50)  UNIQUE NOT NULL CHECK (key <> ''),
    name        VARCHAR(100) NOT NULL        CHECK (name <> ''),
    description TEXT
);

CREATE TABLE IF NOT EXISTS user_achievements (
    user_id        INTEGER NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
    achievement_id INTEGER NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    earned_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, achievement_id)
);

-- ─── Espectadores ─────────────────────────────────────────
-- overflow   = redirigido porque la sesión estaba llena
-- voluntary  = eligió ver la partida
CREATE TABLE IF NOT EXISTS spectators (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id    VARCHAR(50) NOT NULL,
    tournament_id INTEGER     REFERENCES tournaments(id) ON DELETE SET NULL,
    mode          VARCHAR(20) NOT NULL DEFAULT 'overflow'
                              CHECK (mode IN ('overflow', 'voluntary')),
    joined_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    left_at       TIMESTAMPTZ,
    CONSTRAINT chk_spectator_dates CHECK (
        left_at IS NULL OR left_at >= joined_at
    )
);

CREATE INDEX IF NOT EXISTS idx_spectators_session ON spectators(session_id);
CREATE INDEX IF NOT EXISTS idx_spectators_user    ON spectators(user_id);

-- ─── Notificaciones ───────────────────────────────────────
-- FIX: añadido 'tournament_end' al CHECK para cubrir el evento WS homónimo
CREATE TABLE IF NOT EXISTS notifications (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       VARCHAR(50) NOT NULL
                           CHECK (type IN (
                               'friend_request',
                               'match_invite',
                               'player_eliminated',
                               'match_end',
                               'tournament_end'   -- evento WS documentado en API_ENDPOINTS.md
                           )),
    payload    JSONB,
    is_read    BOOLEAN     DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notif_user   ON notifications(user_id);
-- Índice parcial: solo notificaciones no leídas (las que más se consultan)
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(user_id) WHERE is_read = FALSE;

-- ─── Logros de ejemplo ────────────────────────────────────
-- FIX: añadido 'veteran' que faltaba (referenciado en achievements.js y API_ENDPOINTS.md)
INSERT INTO achievements (key, name, description) VALUES
    ('first_win',    'Primera victoria',  'Gana tu primera partida'),
    ('veteran',      'Veterano',          'Consigue 10 victorias'),
    ('combo_master', 'Maestro del combo', 'Ejecuta un combo completo'),
    ('social',       'Sociable',          'Añade a tu primer amigo')
ON CONFLICT (key) DO NOTHING;

-- ─── Usuario de prueba ────────────────────────────────────
-- ADVERTENCIA: eliminar o reemplazar el hash antes de desplegar en producción.
-- Para generar un hash válido: node -e "require('bcrypt').hash('test1234',10).then(console.log)"
DO $$
BEGIN
    IF current_setting('server_version_num')::int >= 150000
       AND current_database() = 'postgres' THEN
        RAISE WARNING 'Recuerda eliminar el usuario de prueba antes de producción.';
    END IF;
END;
$$;

INSERT INTO users (username, email, password_hash, role)
VALUES ('testuser', 'test@example.com', '$2b$10$placeholder_hash_change_me', 'admin')
ON CONFLICT (username) DO NOTHING;

INSERT INTO user_stats (user_id)
SELECT id FROM users WHERE username = 'testuser'
ON CONFLICT (user_id) DO NOTHING;