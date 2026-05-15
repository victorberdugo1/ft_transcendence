// ─── NOTE ON window._ GLOBALS ─────────────────────────────────────────────────
// This file exposes state via window._ intentionally.
// main.c (compiled with Emscripten) reads these values through EM_JS macros —
// that is the ABI between C/WASM and JS. Do NOT refactor away from window._
// without also updating every EM_JS block in main.c and recompiling the WASM.
//
// Globals used by main.c (do not rename):
//   window._myClientId, window._isSpectator, window._gameState,
//   window._gameConfig, window._victoryActive, window._victoryConsumed,
//   window._victoryIsWinner, window._victoryWinner, window._overlayReady,
//   window._hitstopState, window._countdownStart, window._countdownDone,
//   window._canvasWidth, window._canvasHeight
//
// Globals used only by React UI (safe to rename with a coordinated frontend PR):
//   window._spectatorMode, window._matchSession, window._lastMatchResult,
//   window._tournamentResult, window._eliminatedFromSession,
//   window._charSelectData, window._charSelectConfirmed
// ──────────────────────────────────────────────────────────────────────────────

// HITSTOP_SHAKE is imported from constants so that shake amplitudes and
// hitstop tier thresholds are defined in a single place. Changing a tier's
// feel only requires editing constants.js — no need to touch this file.
//
// In the browser build, constants.js is loaded as a plain <script> before
// this file, so HITSTOP_SHAKE is available as a global. The Node/backend
// build uses require() and never loads this file.

(function restoreLastState() {
    try {
        const saved = sessionStorage.getItem('gameState');
        window._gameState = saved ? JSON.parse(saved) : { players: {} };
    } catch {
        window._gameState = { players: {} };
    }
})();

window._myClientId     = -1;
window._ws             = null;
window._charSelectData = null;

const ACTION_KEY     = 'Space';
const ACTION_KEY_ALT = 'KeyG';
const DASH_TAP_MS    = 300;
const DASH_ATTACK_MS = 200;
const ACTION_HOLD_MS = 350;

const keys = {};
window.addEventListener('keydown', e => { keys[e.code] = true;  });
window.addEventListener('keyup',   e => { keys[e.code] = false; });

const EMPTY_FRAME = Object.freeze({
    jump: false, attack: false, dash: false, dashDir: 0, dashAttack: false,
});

const frameEvents = { ...EMPTY_FRAME };

let actionDownAt = 0;
let actionFired  = false;

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
    if (!actionFired && heldMs < ACTION_HOLD_MS) {
        const sinceDash = Date.now() - dashEndTime;
        if (dashEndTime > 0 && sinceDash < DASH_ATTACK_MS) {
            frameEvents.dashAttack = true;
            dashEndTime = 0;
        } else {
            frameEvents.attack = true;
        }
    }
    actionFired = false;
});

function isBlocking() {
    return !!(keys[ACTION_KEY] || keys[ACTION_KEY_ALT]);
}

let lastTap     = { code: '', time: 0 };
let dashEndTime = 0;

const DASH_KEYS = new Set(['ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD']);

window.addEventListener('keydown', (e) => {
    if (e.repeat || !DASH_KEYS.has(e.code)) return;
    const now = Date.now();
    if (e.code === lastTap.code && now - lastTap.time < DASH_TAP_MS) {
        frameEvents.dash    = true;
        frameEvents.dashDir = (e.code === 'ArrowRight' || e.code === 'KeyD') ? 1 : -1;
        dashEndTime = now + 120;
    }
    lastTap = { code: e.code, time: now };
});

window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'KeyW' || e.code === 'ArrowUp') frameEvents.jump = true;
});

// FIX: Only send input once the server has assigned us a clientId (i.e. after
// receiving 'init' or 'spectator_mode'). Before that, window._myClientId is -1
// and sending inputs is wasteful noise that can also trigger unintended
// server-side promoteToPlayer calls.
setInterval(() => {
    if (window._myClientId === -1) {
        Object.assign(frameEvents, EMPTY_FRAME);
        return;
    }

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

        window._gameState      = { type: 'state', frameId: 0, players: {} };
        window._isSpectator    = false;
        window._spectatorMode  = null;
        window._eliminatedFromSession = null;
        // Limpiar stage confirmado para evitar que sessionStorage de partidas
        // anteriores haga saltar el SSS prematuramente.
        window._confirmedStageId = undefined;
        window._isHost           = undefined;
        try { sessionStorage.removeItem('confirmedStageId'); } catch(_) {}

        window._charSelectConfirmed = false;
        if (!savedId) {
            // Conexion nueva (no reconexion): borrar datos de partidas anteriores
            // para que el WASM arranque desde el SSS limpio.
            window._charSelectData = null;
            try {
                sessionStorage.removeItem('charSelectData');
                sessionStorage.removeItem('pendingCharSelect');
            } catch(_) {}
        } else {
            // Reconexion mid-match: restaurar char select para continuar donde estaba.
            try {
                const saved = sessionStorage.getItem('charSelectData');
                if (saved) {
                    window._charSelectData = JSON.parse(saved);
                    window._charSelectConfirmed = true;
                } else {
                    window._charSelectData = null;
                }
            } catch(e) {
                window._charSelectData = null;
            }

            const _pcs = sessionStorage.getItem('pendingCharSelect');
            if (_pcs) {
                try {
                    const { charId, charIdx, stageId } = JSON.parse(_pcs);
                    setTimeout(() => {
                        if (window._isSpectator) return;
                        if (window._ws && window._ws.readyState === WebSocket.OPEN)
                            sendCharSelect(charId, charIdx ?? 0, stageId ?? 0);
                    }, 300);
                } catch (e) {}
            }
        }

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

        } else if (msg.type === 'char_select_ack') {
            window._charSelectData = msg;
            if (msg.selectorClient === window._myClientId) {
                window._charSelectConfirmed = true;
                try { sessionStorage.setItem('charSelectData', JSON.stringify(msg)); } catch(e){}
            }
            window.dispatchEvent(new CustomEvent('char_select_ack', { detail: msg }));

        } else if (msg.type === 'spectator_mode') {
            window._myClientId  = msg.clientId;
            window._isSpectator = true;

            // FIX: limpiar estado de char select — los espectadores no seleccionan personaje.
            window._charSelectData      = null;
            window._charSelectConfirmed = false;
            try {
                sessionStorage.removeItem('charSelectData');
                sessionStorage.removeItem('pendingCharSelect');
            } catch(e) {}

            window._spectatorMode = {
                mode:            msg.mode,
                watchingSession: msg.watchingSession,
                activeSessions:  msg.activeSessions,
                eliminated:      msg.eliminated ?? false,
            };
            if (msg.eliminated) {
                window._eliminatedFromSession = msg.watchingSession ?? null;
            }
            sessionStorage.setItem('clientId', msg.clientId);
            if (!window._gameState || !window._gameState.players) {
                window._gameState = { type: 'state', frameId: 0, players: {} };
            }
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

        } else if (msg.type === 'hitstop') {
            // HITSTOP_SHAKE comes from constants.js — single source of truth.
            // If the global is missing (e.g. tests without a browser), fall back
            // to a safe default rather than silently producing NaN.
            const shakeTable = (typeof HITSTOP_SHAKE !== 'undefined')
                ? HITSTOP_SHAKE
                : { micro: 0.012, light: 0.028, medium: 0.055, heavy: 0.10, ultra: 0.18 };

            const shakeAmt = shakeTable[msg.tier] ?? 0.02;
            const existing = window._hitstopState;
            if (!existing || msg.frames > existing.framesLeft) {
                window._hitstopState = {
                    framesLeft:  msg.frames,
                    tier:        msg.tier,
                    shakeAmt,
                    attackerId:  msg.attackerId,
                    targetId:    msg.targetId,
                    startFrames: msg.frames,
                };
            }
            window.dispatchEvent(new CustomEvent('hitstop', { detail: window._hitstopState }));

        } else if (msg.type === 'stage_confirmed') {
            // El servidor confirma el stage elegido por el host.
            // ws_get_confirmed_stage() en C lo leerá desde window._confirmedStageId.
            window._confirmedStageId = msg.stageId | 0;
            try { sessionStorage.setItem('confirmedStageId', String(msg.stageId | 0)); } catch(_) {}

        } else if (msg.type === 'host_status') {
            // El servidor nos dice explícitamente si somos el host.
            // ws_is_host() en C lo comprobará primero antes de calcular por IDs.
            window._isHost = !!msg.isHost;

        } else if (msg.type === 'state') {
            window._gameState = msg;
            if (window._victoryActive && window._victoryWinner >= 0) {
                const wp = window._gameState.players[window._victoryWinner];
                if (wp) { wp.animation = 'victory'; wp.frozen = true; }
            }
            // Throttle sessionStorage writes to ~1/s — writing on every tick (60/s)
            // is synchronous I/O that blocks the main thread and causes lag.
            const now = Date.now();
            if (!window._lastGameStateSave || now - window._lastGameStateSave > 1000) {
                try { sessionStorage.setItem('gameState', JSON.stringify(msg)); } catch { }
                window._lastGameStateSave = now;
            }

        } else if (msg.type === 'match_start') {
            window._victoryState    = null;
            window._victoryConsumed = false;
            window._hitstopState    = null;

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
            if (window._isSpectator && window._eliminatedFromSession) {
                window._victoryWinner   = msg.winner | 0;
                window._victoryIsWinner = false;
                window._victoryActive   = true;
                window._victoryConsumed = false;
                window._overlayReady    = false;
                window._victoryState = {
                    winner:         msg.winner,
                    loser:          msg.loser,
                    isWinner:       false,
                    reloadRequired: msg.reloadRequired ?? true,
                };
                if (window._gameState && window._gameState.players) {
                    const wp = window._gameState.players[msg.winner];
                    if (wp) { wp.animation = 'victory'; wp.frozen = true; }
                }
                window.dispatchEvent(new CustomEvent('victory_spectator', { detail: {
                    winner: msg.winner, loser: msg.loser, isWinner: false, spectating: true,
                }}));
                setTimeout(() => {
                    window._overlayReady = true;
                    window.dispatchEvent(new CustomEvent('victory', { detail: window._victoryState }));
                }, window._victoryOverlayDelayMs ?? 3000);
                return;
            }

            const isWinner = (msg.winner === window._myClientId);
            window._victoryWinner   = msg.winner | 0;
            window._victoryIsWinner = isWinner;
            window._victoryActive   = true;
            window._victoryConsumed = false;
            window._victoryState = {
                winner:         msg.winner,
                loser:          msg.loser,
                isWinner,
                reloadRequired: msg.reloadRequired ?? true,
            };
            if (window._gameState && window._gameState.players) {
                const wp = window._gameState.players[msg.winner];
                if (wp) { wp.animation = 'victory'; wp.frozen = true; }
            }
            setTimeout(() => {
                window._overlayReady = true;  // FIX: faltaba esto — sin esto ws_overlay_ready() nunca
                                              // devolvía 1 para espectadores voluntarios, la animación
                                              // de victoria loopeaba infinito y el mensaje no aparecía.
                window.dispatchEvent(new CustomEvent('victory', { detail: window._victoryState }));
            }, window._victoryOverlayDelayMs ?? 3000);

        } else if (msg.type === 'match_finished') {
            try {
                sessionStorage.removeItem('clientId');
                sessionStorage.removeItem('charSelectData');
                sessionStorage.removeItem('pendingCharSelect');
                sessionStorage.removeItem('watchSession');
                sessionStorage.removeItem('gameState');
                sessionStorage.removeItem('confirmedStageId');
            } catch(e) {}
            window._myClientId          = -1;
            window._charSelectData      = null;
            window._charSelectConfirmed = false;
            window._victoryConsumed     = true;
            window._confirmedStageId    = undefined;
            window._isHost              = undefined;
            window.dispatchEvent(new CustomEvent('match_finished', { detail: { sessionId: msg.sessionId } }));

        } else if (msg.type === 'match_end') {
            const isWinnerMe = msg.winner === window._myClientId;
            window._lastMatchResult = { winner: msg.winner, loser: msg.loser, isWinner: isWinnerMe, matchId: msg.matchId };
            window._eliminatedFromSession = null;
            window.dispatchEvent(new CustomEvent('match_end', { detail: window._lastMatchResult }));
            window._matchSession = null;

        } else if (msg.type === 'player_eliminated') {
            window.dispatchEvent(new CustomEvent('player_eliminated', { detail: { clientId: msg.clientId } }));

        } else if (msg.type === 'tournament_waiting') {
            window.dispatchEvent(new CustomEvent('tournament_waiting', { detail: msg }));

        } else if (msg.type === 'tournament_end') {
            window._tournamentResult = msg;
            window.dispatchEvent(new CustomEvent('tournament_end', { detail: msg }));

        } else if (msg.type === 'players_joined') {
            // Nuevos jugadores se unieron a una sesion activa — no requiere accion en el cliente.
            window.dispatchEvent(new CustomEvent('players_joined', { detail: msg }));

        } else if (msg.type === 'player_disconnected') {
            // Un jugador se desconecto — hay un periodo de gracia para reconectar.
            window.dispatchEvent(new CustomEvent('player_disconnected', { detail: msg }));

        } else if (msg.type === 'player_reconnected') {
            // El jugador reconecto dentro del periodo de gracia.
            window.dispatchEvent(new CustomEvent('player_reconnected', { detail: msg }));

        } else {
            // FIX: unknown message types are logged and ignored. The previous
            // code did `window._gameState = msg` here, which would silently
            // corrupt the game state (and break the WASM ABI) whenever a new
            // or unexpected message type arrived from the server.
            console.warn('[WS] unhandled message type:', msg.type, msg);
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


function sendInput(frame) {
    if (!window._ws || window._ws.readyState !== WebSocket.OPEN) return;
    if (window._isSpectator) return;
    if (window._victoryActive) return;
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

window._sendInput = (moveX, jump, attack, dash, dashDir, crouch, block, dashAttack) =>
    sendInput({ moveX, jump, attack, dash, dashDir, crouch, block, dashAttack });

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
        } catch (e) { }
        window._spectatorAutoWatchTimer = setTimeout(attempt, 1000);
    }

    window._spectatorAutoWatchTimer = setTimeout(attempt, 500);
}

window._spectatorAutoWatch = _spectatorAutoWatch;


function watchSession(sessionId) {
    if (!window._ws || window._ws.readyState !== WebSocket.OPEN) return;
    window._ws.send(JSON.stringify({ type: 'watch', sessionId: sessionId ?? null }));
}

window.watchSession = watchSession;


async function fetchActiveSessions() {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(`fetchActiveSessions: ${res.status}`);
    return res.json();
}

window.fetchActiveSessions = fetchActiveSessions;


function sendStageSelect(stageId) {
    // Confirmar localmente (el host sale del SSS de inmediato).
    window._confirmedStageId = stageId | 0;
    try { sessionStorage.setItem('confirmedStageId', String(stageId | 0)); } catch(_) {}
    // Enviar al servidor para que lo broadcastee a los demás jugadores.
    if (window._ws && window._ws.readyState === WebSocket.OPEN)
        window._ws.send(JSON.stringify({ type: 'stage_select', stageId: stageId | 0 }));
}

window.sendStageSelect = sendStageSelect;

function sendCharSelect(charId, charIdx, stageId) {
    if (!window._ws || window._ws.readyState !== WebSocket.OPEN) return;
    window._ws.send(JSON.stringify({ type: 'char_select', charId, charIdx: charIdx ?? 0, stageId: stageId ?? 0 }));
}

window.sendCharSelect = sendCharSelect;

function getCharSelectData() { return window._charSelectData ?? null; }
window.getCharSelectData = getCharSelectData;

function clearCharSelectData() {
    window._charSelectData      = null;
    window._charSelectConfirmed = false;
    try {
        sessionStorage.removeItem('pendingCharSelect');
        sessionStorage.removeItem('charSelectData');
    } catch(e) {}
}

window.clearCharSelectData = clearCharSelectData;