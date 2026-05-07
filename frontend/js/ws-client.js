// ─────────────────────────────────────────────────────────────────────────────
//  PERSISTENT STATE  (survives page refresh)
// ─────────────────────────────────────────────────────────────────────────────
(function restoreLastState() {
    try {
        const saved = sessionStorage.getItem('gameState');
        window._gameState = saved ? JSON.parse(saved) : { players: {} };
    } catch {
        window._gameState = { players: {} };
    }
})();

window._myClientId = -1;
window._ws         = null;

// ─────────────────────────────────────────────────────────────────────────────
//  INPUT CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const ACTION_KEY     = 'Space';   // tap → attack | intentional hold → block
const ACTION_KEY_ALT = 'KeyG';   // alternate binding for ACTION_KEY

const DASH_TAP_MS    = 300;   // double-tap window for dash (ms)
const DASH_ATTACK_MS = 200;   // window after dash ends to trigger dash-attack (ms)

// Client-side hold threshold: determines tap vs. hold on keyup.
// Block activation and dash lockout are enforced server-side.
const ACTION_HOLD_MS = 350;

// ─────────────────────────────────────────────────────────────────────────────
//  KEYBOARD STATE
// ─────────────────────────────────────────────────────────────────────────────
/** Continuously held keys (true while key is pressed). */
const keys = {};

window.addEventListener('keydown', e => { keys[e.code] = true;  });
window.addEventListener('keyup',   e => { keys[e.code] = false; });

// ─────────────────────────────────────────────────────────────────────────────
//  PER-FRAME ONE-SHOT EVENTS
// ─────────────────────────────────────────────────────────────────────────────
/** Template for a clean frame — copied into frameEvents each tick. */
const EMPTY_FRAME = Object.freeze({
    jump: false, attack: false, dash: false, dashDir: 0, dashAttack: false,
});

/** Accumulates one-shot events between input-loop ticks. */
const frameEvents = { ...EMPTY_FRAME };

// ─────────────────────────────────────────────────────────────────────────────
//  ACTION KEY (ATTACK / BLOCK)
// ─────────────────────────────────────────────────────────────────────────────
let actionDownAt = 0;     // timestamp (ms) when the action key was pressed
let actionFired  = false; // prevents double-firing within a single press

function isActionKey(code) {
    return code === ACTION_KEY || code === ACTION_KEY_ALT;
}

window.addEventListener('keydown', (e) => {
    if (e.repeat || !isActionKey(e.code)) return;
    actionDownAt = Date.now();
    actionFired  = false;
});

window.addEventListener('keyup', (e) => {
    if (!isActionKey(e.code)) return;

    const heldMs = Date.now() - actionDownAt;

    // Short tap → attack (or dash-attack if within the post-dash window).
    if (!actionFired && heldMs < ACTION_HOLD_MS) {
        const sinceDash = Date.now() - dashEndTime;
        if (dashEndTime > 0 && sinceDash < DASH_ATTACK_MS) {
            frameEvents.dashAttack = true;
            dashEndTime = 0;   // consume the window — one shot only
        } else {
            frameEvents.attack = true;
        }
    }
    actionFired = false;
});

// ─────────────────────────────────────────────────────────────────────────────
//  BLOCK  (server owns all timing — client just forwards the held state)
// ─────────────────────────────────────────────────────────────────────────────
function isBlocking() {
    return !!(keys[ACTION_KEY] || keys[ACTION_KEY_ALT]);
}

// ─────────────────────────────────────────────────────────────────────────────
//  DASH  (double-tap left / right)
// ─────────────────────────────────────────────────────────────────────────────
let lastTap     = { code: '', time: 0 };
let dashEndTime = 0;   // client-side estimate of when the server dash ends

const DASH_KEYS = new Set(['ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD']);

window.addEventListener('keydown', (e) => {
    if (e.repeat || !DASH_KEYS.has(e.code)) return;

    const now = Date.now();
    if (e.code === lastTap.code && now - lastTap.time < DASH_TAP_MS) {
        frameEvents.dash    = true;
        frameEvents.dashDir = (e.code === 'ArrowRight' || e.code === 'KeyD') ? 1 : -1;
        // Approximate when the dash ends on the server (~DASH_DURATION s).
        dashEndTime = now + 120;
    }
    lastTap = { code: e.code, time: now };
});

// ─────────────────────────────────────────────────────────────────────────────
//  JUMP
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'KeyW' || e.code === 'ArrowUp') frameEvents.jump = true;
});

// ─────────────────────────────────────────────────────────────────────────────
//  60 Hz INPUT LOOP
// ─────────────────────────────────────────────────────────────────────────────
setInterval(() => {
    const moveX  = (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0)
                 - (keys['KeyA'] || keys['ArrowLeft']  ? 1 : 0);
    const crouch = !!(keys['KeyS'] || keys['ArrowDown']);
    const block  = isBlocking();

    sendInput({
        moveX,
        jump:       frameEvents.jump,
        attack:     frameEvents.attack,
        dash:       frameEvents.dash,
        dashDir:    frameEvents.dashDir,
        crouch,
        block,
        dashAttack: frameEvents.dashAttack,
    });

    Object.assign(frameEvents, EMPTY_FRAME);
}, 1000 / 60);

// ─────────────────────────────────────────────────────────────────────────────
//  WEBSOCKET
// ─────────────────────────────────────────────────────────────────────────────
(function connectWS() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws       = new WebSocket(`${protocol}//${location.host}/ws`);
    window._ws     = ws;

    function setStatus(text) {
        const el = document.getElementById('status');
        if (el) el.textContent = text;
    }

    ws.addEventListener('open', () => {
        setStatus('⬤ Connected');
        const savedId = sessionStorage.getItem('clientId');

        // Clear any stale game state from the previous session so C doesn't
        // try to render an inconsistent snapshot while we wait for the server.
        window._gameState     = { type: 'state', frameId: 0, players: {} };
        window._isSpectator   = false;
        window._spectatorMode = null;

        // The server always decides whether this client is a player or spectator
        // based on how many players are currently connected.  We never force
        // spectator mode from the client — if we were an overflow spectator last
        // time, we try to rejoin as a player now (the server will push us back to
        // spectator_mode if the room is still full).
        if (savedId) {
            ws.send(JSON.stringify({ type: 'rejoin', clientId: parseInt(savedId, 10) }));
        } else {
            ws.send(JSON.stringify({ type: 'join' }));
        }
    });

    ws.addEventListener('message', ({ data }) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === 'init') {
            window._myClientId = msg.clientId;
            window._gameConfig = msg.config;
            sessionStorage.setItem('clientId', msg.clientId);
            window._isSpectator = false;

        } else if (msg.type === 'spectator_mode') {
            window._myClientId  = msg.clientId;
            window._isSpectator = true;
            window._spectatorMode = {
                mode:            msg.mode,
                watchingSession: msg.watchingSession,
                activeSessions:  msg.activeSessions,
                eliminated:      msg.eliminated ?? false,
            };
            sessionStorage.setItem('clientId', msg.clientId);
            if (!window._gameState || !window._gameState.players) {
                window._gameState = { type: 'state', frameId: 0, players: {} };
            }
            // IMPORTANTE: NO tocar _victoryState aquí.
            // Si este cliente acaba de ser eliminado, puede llegar spectator_mode
            // justo después del victory — el C todavía no lo ha leído.
            window.dispatchEvent(new CustomEvent('spectator_mode', { detail: window._spectatorMode }));

            if (!msg.watchingSession) {
                _spectatorAutoWatch();
            }

        } else if (msg.type === 'spectator_session_changed') {
            if (window._spectatorMode) {
                window._spectatorMode.watchingSession = msg.watchingSession;
            }
            if (msg.activeSessions && window._spectatorMode) {
                window._spectatorMode.activeSessions = msg.activeSessions;
            }
            sessionStorage.setItem('watchSession', msg.watchingSession ?? '');
            if (!msg.watchingSession) {
                _spectatorAutoWatch();
            } else {
                if (window._spectatorAutoWatchTimer) {
                    clearTimeout(window._spectatorAutoWatchTimer);
                    window._spectatorAutoWatchTimer = null;
                }
            }
            window.dispatchEvent(new CustomEvent('spectator_session_changed', { detail: msg }));

        } else if (msg.type === 'state') {
            window._gameState = msg;
            try { sessionStorage.setItem('gameState', JSON.stringify(msg)); } catch { /* quota */ }

        } else if (msg.type === 'match_start') {
            // Nueva partida — limpiar cualquier victoria anterior
            window._victoryState    = null;
            window._victoryConsumed = false;
            window._matchSession = {
                sessionId:    msg.sessionId,
                mode:         msg.mode,
                tournamentId: msg.tournamentId ?? null,
                round:        msg.round ?? null,
            };
            if (msg.countdown) {
                window._countdownStart = performance.now();
                window._countdownDone  = false;
            } else {
                window._countdownStart = null;
                window._countdownDone  = true;
            }
            window.dispatchEvent(new CustomEvent('match_start', { detail: window._matchSession }));

        } else if (msg.type === 'victory') {
            // Guardamos en una variable separada que el C lee vía EM_JS.
            // Usamos _victoryWinner (int) y _victoryIsWinner (bool) para
            // evitar la dependencia de setValue/punteros en EM_JS.
            const isWinner = (msg.winner === window._myClientId);
            window._victoryWinner   = msg.winner | 0;
            window._victoryIsWinner = isWinner;
            window._victoryActive   = true;   // el C comprueba este flag
            window._victoryConsumed = false;

            // También mantener el objeto para el HUD/React
            window._victoryState = {
                winner:         msg.winner,
                loser:          msg.loser,
                isWinner,
                reloadRequired: msg.reloadRequired ?? true,
            };

            // Forzar animación 'victory' en el snapshot para el renderer
            if (window._gameState && window._gameState.players) {
                const wp = window._gameState.players[msg.winner];
                if (wp) {
                    wp.animation = 'victory';
                    wp.frozen    = true;
                }
            }

            window.dispatchEvent(new CustomEvent('victory', { detail: window._victoryState }));
            if (isWinner) console.log('[GAME] Victory! Reload para la próxima partida.');

        } else if (msg.type === 'match_end') {
            const isWinnerMe = msg.winner === window._myClientId;
            window._lastMatchResult = { winner: msg.winner, loser: msg.loser, isWinner: isWinnerMe, matchId: msg.matchId };
            window.dispatchEvent(new CustomEvent('match_end', { detail: window._lastMatchResult }));
            window._matchSession = null;

        } else if (msg.type === 'player_eliminated') {
            window.dispatchEvent(new CustomEvent('player_eliminated', { detail: { clientId: msg.clientId } }));

        } else if (msg.type === 'tournament_waiting') {
            window.dispatchEvent(new CustomEvent('tournament_waiting', { detail: msg }));

        } else if (msg.type === 'tournament_end') {
            window._tournamentResult = msg;
            window.dispatchEvent(new CustomEvent('tournament_end', { detail: msg }));

        } else {
            window._gameState = msg;
        }
    });

    ws.addEventListener('close', () => {
        window._myClientId    = -1;
        window._isSpectator   = false;
        window._spectatorMode = null;
        setStatus('⬤ Disconnected — reconnecting…');
        setTimeout(connectWS, 2000);
    });

    ws.addEventListener('error', (err) => {
        console.error('[WS] Error:', err);
        ws.close();
    });
})();

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Serialises and sends one input frame to the server.
 * @param {InputFrame} frame
 */
function sendInput(frame) {
    if (!window._ws || window._ws.readyState !== WebSocket.OPEN) return;
    // Espectadores no mandan input
    if (window._isSpectator) return;
    // Partida terminada — ninguna tecla debe llegar al servidor
    if (window._victoryState && !window._victoryConsumed) return;
    // Durante el countdown tampoco se manda input
    if (window._countdownStart && !window._countdownDone) return;

    window._ws.send(JSON.stringify({
        type:       'input',
        moveX:      frame.moveX,
        jump:       frame.jump       ? 1 : 0,
        attack:     frame.attack     ? 1 : 0,
        dash:       frame.dash       ? 1 : 0,
        dashDir:    frame.dashDir    ?? 0,
        crouch:     frame.crouch     ? 1 : 0,
        block:      frame.block      ? 1 : 0,
        dashAttack: frame.dashAttack ? 1 : 0,
    }));
}

// Expose for legacy callers (Emscripten EM_JS bridge).
window._sendInput = (moveX, jump, attack, dash, dashDir, crouch, block, dashAttack) =>
    sendInput({ moveX, jump, attack, dash, dashDir, crouch, block, dashAttack });

// ─────────────────────────────────────────────────────────────────────────────
//  SPECTATOR AUTO-WATCH
//  Busca sesiones activas cada segundo hasta encontrar una y unirse.
//  Se cancela cuando llega spectator_session_changed con sesión válida.
// ─────────────────────────────────────────────────────────────────────────────
window._spectatorAutoWatchTimer = null;

function _spectatorAutoWatch() {
    if (window._spectatorMode?.watchingSession) return;
    if (window._spectatorAutoWatchTimer) {
        clearTimeout(window._spectatorAutoWatchTimer);
        window._spectatorAutoWatchTimer = null;
    }

    async function attempt() {
        if (window._spectatorMode?.watchingSession) return;
        if (!window._isSpectator) return;
        try {
            const { sessions } = await fetchActiveSessions();
            if (sessions && sessions.length > 0) {
                watchSession(sessions[0].sessionId);
                return;
            }
        } catch (e) { /* red caída, reintentar */ }
        window._spectatorAutoWatchTimer = setTimeout(attempt, 1000);
    }

    window._spectatorAutoWatchTimer = setTimeout(attempt, 500);
}

window._spectatorAutoWatch = _spectatorAutoWatch;

// ─────────────────────────────────────────────────────────────────────────────
//  SPECTATOR API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Switch to spectator mode voluntarily, optionally watching a specific session.
 * Call this from the lobby / match-browser UI.
 *
 * @param {string|null} sessionId  – the sessionId to watch, or null for lobby view
 *
 * Usage examples:
 *   watchSession('3');           // watch session 3
 *   watchSession(null);          // lobby — see all sessions overview
 */
function watchSession(sessionId) {
    if (!window._ws || window._ws.readyState !== WebSocket.OPEN) return;
    window._ws.send(JSON.stringify({ type: 'watch', sessionId: sessionId ?? null }));
}

window.watchSession = watchSession;

/**
 * Fetch the list of active sessions from the REST API.
 * Returns a Promise resolving to { sessions, lobbySpectators, totalSpectators }.
 *
 * Usage: const { sessions } = await fetchActiveSessions();
 */
async function fetchActiveSessions() {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(`fetchActiveSessions: ${res.status}`);
    return res.json();
}

window.fetchActiveSessions = fetchActiveSessions;