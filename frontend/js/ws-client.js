// NOTE: window._ globals are part of the ABI with main.c (Emscripten/EM_JS).
// Do NOT rename: _myClientId, _isSpectator, _gameState, _gameConfig,
// _victoryActive, _victoryConsumed, _victoryIsWinner, _victoryWinner,
// _overlayReady, _hitstopState, _countdownStart, _countdownDone,
// _canvasWidth, _canvasHeight.
// React-only (safe to rename with a coordinated PR):
// _spectatorMode, _matchSession, _lastMatchResult, _tournamentResult,
// _eliminatedFromSession, _charSelectData, _charSelectConfirmed.

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
const DASH_KEYS      = new Set(['ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD']);

const keys = {};
window.addEventListener('keydown', e => { keys[e.code] = true;  });
window.addEventListener('keyup',   e => { keys[e.code] = false; });

const EMPTY_FRAME  = Object.freeze({ jump: false, attack: false, dash: false, dashDir: 0, dashAttack: false });
const frameEvents  = { ...EMPTY_FRAME };

let actionDownAt = 0;
let actionFired  = false;
let lastTap      = { code: '', time: 0 };
let dashEndTime  = 0;

const isActionKey = code => code === ACTION_KEY || code === ACTION_KEY_ALT;

window.addEventListener('keydown', e => {
    if (e.repeat || !isActionKey(e.code)) return;
    actionDownAt = Date.now();
    actionFired  = false;
});

window.addEventListener('keyup', e => {
    if (!isActionKey(e.code)) return;
    if (!actionFired && Date.now() - actionDownAt < ACTION_HOLD_MS) {
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

window.addEventListener('keydown', e => {
    if (e.repeat || !DASH_KEYS.has(e.code)) return;
    const now = Date.now();
    if (e.code === lastTap.code && now - lastTap.time < DASH_TAP_MS) {
        frameEvents.dash    = true;
        frameEvents.dashDir = (e.code === 'ArrowRight' || e.code === 'KeyD') ? 1 : -1;
        dashEndTime = now + 120;
    }
    lastTap = { code: e.code, time: now };
});

window.addEventListener('keydown', e => {
    if (!e.repeat && (e.code === 'KeyW' || e.code === 'ArrowUp')) frameEvents.jump = true;
});

setInterval(() => {
    if (window._myClientId === -1) { Object.assign(frameEvents, EMPTY_FRAME); return; }

    sendInput({
        moveX:      (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0) - (keys['KeyA'] || keys['ArrowLeft'] ? 1 : 0),
        jump:       frameEvents.jump,
        attack:     frameEvents.attack,
        dash:       frameEvents.dash,
        dashDir:    frameEvents.dashDir,
        crouch:     !!(keys['KeyS'] || keys['ArrowDown']),
        block:      !!(keys[ACTION_KEY] || keys[ACTION_KEY_ALT]),
        dashAttack: frameEvents.dashAttack,
    });

    Object.assign(frameEvents, EMPTY_FRAME);
}, 1000 / 60);

function _sssClear() {
    try {
        sessionStorage.removeItem('charSelectData');
        sessionStorage.removeItem('pendingCharSelect');
    } catch (_) {}
}

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

        Object.assign(window, {
            _gameState:              { type: 'state', frameId: 0, players: {} },
            _isSpectator:            false,
            _spectatorMode:          null,
            _eliminatedFromSession:  null,
            _confirmedStageId:       undefined,
            _isHost:                 undefined,
            _charSelectConfirmed:    false,
        });
        try { sessionStorage.removeItem('confirmedStageId'); } catch (_) {}

        if (!savedId) {
            window._charSelectData = null;
            _sssClear();
        } else {
            try {
                const saved = sessionStorage.getItem('charSelectData');
                window._charSelectData = saved ? JSON.parse(saved) : null;
                window._charSelectConfirmed = !!saved;
            } catch {
                window._charSelectData = null;
            }

            const _pcs = sessionStorage.getItem('pendingCharSelect');
            if (_pcs) {
                try {
                    const { charId, charIdx, stageId } = JSON.parse(_pcs);
                    setTimeout(() => {
                        if (!window._isSpectator && window._ws?.readyState === WebSocket.OPEN)
                            sendCharSelect(charId, charIdx ?? 0, stageId ?? 0);
                    }, 300);
                } catch {}
            }
        }

        ws.send(JSON.stringify(savedId
            ? { type: 'rejoin', clientId: parseInt(savedId, 10) }
            : { type: 'join' }
        ));
    });

    ws.addEventListener('message', ({ data }) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === 'init') {
            window._myClientId = msg.clientId;
            window._gameConfig = msg.config;
            window._isSpectator = false;
            sessionStorage.setItem('clientId', msg.clientId);

        } else if (msg.type === 'char_select_ack') {
            window._charSelectData = msg;
            if (msg.selectorClient === window._myClientId) {
                window._charSelectConfirmed = true;
                try { sessionStorage.setItem('charSelectData', JSON.stringify(msg)); } catch {}
            }
            window.dispatchEvent(new CustomEvent('char_select_ack', { detail: msg }));

        } else if (msg.type === 'spectator_mode') {
            window._myClientId          = msg.clientId;
            window._isSpectator         = true;
            window._charSelectData      = null;
            window._charSelectConfirmed = false;
            _sssClear();
            window._spectatorMode = {
                mode:            msg.mode,
                watchingSession: msg.watchingSession,
                activeSessions:  msg.activeSessions,
                eliminated:      msg.eliminated ?? false,
            };
            if (msg.eliminated) window._eliminatedFromSession = msg.watchingSession ?? null;
            sessionStorage.setItem('clientId', msg.clientId);
            if (!window._gameState?.players) window._gameState = { type: 'state', frameId: 0, players: {} };
            window.dispatchEvent(new CustomEvent('spectator_mode', { detail: window._spectatorMode }));
            if (!msg.watchingSession) _spectatorAutoWatch();

        } else if (msg.type === 'spectator_session_changed') {
            if (window._spectatorMode) {
                window._spectatorMode.watchingSession = msg.watchingSession;
                if (msg.activeSessions) window._spectatorMode.activeSessions = msg.activeSessions;
            }
            sessionStorage.setItem('watchSession', msg.watchingSession ?? '');
            if (!msg.watchingSession) {
                _spectatorAutoWatch();
            } else {
                clearTimeout(window._spectatorAutoWatchTimer);
                window._spectatorAutoWatchTimer = null;
            }
            window.dispatchEvent(new CustomEvent('spectator_session_changed', { detail: msg }));

        } else if (msg.type === 'hitstop') {
            const shakeTable = typeof HITSTOP_SHAKE !== 'undefined'
                ? HITSTOP_SHAKE
                : { micro: 0.012, light: 0.028, medium: 0.055, heavy: 0.10, ultra: 0.18 };
            const shakeAmt = shakeTable[msg.tier] ?? 0.02;
            const existing = window._hitstopState;
            if (!existing || msg.frames > existing.framesLeft) {
                window._hitstopState = {
                    framesLeft: msg.frames, tier: msg.tier, shakeAmt,
                    attackerId: msg.attackerId, targetId: msg.targetId, startFrames: msg.frames,
                };
            }
            window.dispatchEvent(new CustomEvent('hitstop', { detail: window._hitstopState }));

        } else if (msg.type === 'stage_confirmed') {
            window._confirmedStageId = msg.stageId | 0;
            try { sessionStorage.setItem('confirmedStageId', String(msg.stageId | 0)); } catch (_) {}

        } else if (msg.type === 'stage_reset') {
            window._confirmedStageId = undefined;
            window._isHost = undefined;
            try {
                sessionStorage.removeItem('confirmedStageId');
                _sssClear();
            } catch (_) {}

        } else if (msg.type === 'host_status') {
            window._isHost = !!msg.isHost;

        } else if (msg.type === 'state') {
            window._gameState = msg;
            if (window._victoryActive && window._victoryWinner >= 0) {
                const wp = window._gameState.players[window._victoryWinner];
                if (wp?.onGround) { wp.animation = 'victory'; wp.frozen = true; }
            }
            const now = Date.now();
            if (!window._lastGameStateSave || now - window._lastGameStateSave > 1000) {
                try { sessionStorage.setItem('gameState', JSON.stringify(msg)); } catch {}
                window._lastGameStateSave = now;
            }

        } else if (msg.type === 'match_start') {
            window._victoryState = null;
            window._victoryConsumed = false;
            window._hitstopState = null;
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
            const isWinner = !window._isSpectator && msg.winner === window._myClientId;
            window._victoryWinner   = msg.winner | 0;
            window._victoryIsWinner = isWinner;
            window._victoryActive   = true;
            window._victoryConsumed = false;
            window._victoryState = {
                winner: msg.winner, loser: msg.loser, isWinner,
                reloadRequired: msg.reloadRequired ?? true,
            };
            if (window._isSpectator && window._eliminatedFromSession) {
                window.dispatchEvent(new CustomEvent('victory_spectator', { detail: {
                    winner: msg.winner, loser: msg.loser, isWinner: false, spectating: true,
                }}));
            }
            setTimeout(() => {
                window._overlayReady = true;
                window.dispatchEvent(new CustomEvent('victory', { detail: window._victoryState }));
            }, window._victoryOverlayDelayMs ?? 3000);

        } else if (msg.type === 'match_finished') {
            try {
                ['clientId', 'charSelectData', 'pendingCharSelect', 'watchSession', 'gameState', 'confirmedStageId']
                    .forEach(k => sessionStorage.removeItem(k));
            } catch {}
            Object.assign(window, {
                _myClientId:          -1,
                _charSelectData:      null,
                _charSelectConfirmed: false,
                _victoryConsumed:     true,
                _confirmedStageId:    undefined,
                _isHost:              undefined,
            });
            window.dispatchEvent(new CustomEvent('match_finished', { detail: { sessionId: msg.sessionId } }));

        } else if (msg.type === 'match_end') {
            window._lastMatchResult = {
                winner: msg.winner, loser: msg.loser,
                isWinner: msg.winner === window._myClientId, matchId: msg.matchId,
            };
            window._eliminatedFromSession = null;
            window._matchSession          = null;
            window.dispatchEvent(new CustomEvent('match_end', { detail: window._lastMatchResult }));

        } else if (['player_eliminated', 'tournament_waiting', 'tournament_end', 'players_joined', 'player_disconnected', 'player_reconnected'].includes(msg.type)) {
            if (msg.type === 'tournament_end') window._tournamentResult = msg;
            window.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));

        } else {
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

    ws.addEventListener('error', err => { console.error('[WS] Error:', err); ws.close(); });
})();

function sendInput(frame) {
    if (!window._ws || window._ws.readyState !== WebSocket.OPEN) return;
    if (window._isSpectator || window._victoryActive) return;
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
    clearTimeout(window._spectatorAutoWatchTimer);

    async function attempt() {
        if (window._spectatorMode?.watchingSession || !window._isSpectator) return;
        try {
            const { sessions } = await fetchActiveSessions();
            if (sessions?.length > 0) { watchSession(sessions[0].sessionId); return; }
        } catch {}
        window._spectatorAutoWatchTimer = setTimeout(attempt, 1000);
    }

    window._spectatorAutoWatchTimer = setTimeout(attempt, 500);
}

window._spectatorAutoWatch = _spectatorAutoWatch;

function watchSession(sessionId) {
    if (window._ws?.readyState === WebSocket.OPEN)
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
    window._confirmedStageId = stageId | 0;
    try { sessionStorage.setItem('confirmedStageId', String(stageId | 0)); } catch (_) {}
    if (window._ws?.readyState === WebSocket.OPEN)
        window._ws.send(JSON.stringify({ type: 'stage_select', stageId: stageId | 0 }));
}
window.sendStageSelect = sendStageSelect;

function sendCharSelect(charId, charIdx, stageId) {
    if (window._ws?.readyState === WebSocket.OPEN)
        window._ws.send(JSON.stringify({ type: 'char_select', charId, charIdx: charIdx ?? 0, stageId: stageId ?? 0 }));
}
window.sendCharSelect = sendCharSelect;

function getCharSelectData() { return window._charSelectData ?? null; }
window.getCharSelectData = getCharSelectData;

function clearCharSelectData() {
    window._charSelectData      = null;
    window._charSelectConfirmed = false;
    _sssClear();
}
window.clearCharSelectData = clearCharSelectData;