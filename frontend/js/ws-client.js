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


        window._charSelectConfirmed = false;
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
        if (_pcs) { try { const {charId,charIdx,stageId} = JSON.parse(_pcs); setTimeout(()=>{ if(window._ws&&window._ws.readyState===WebSocket.OPEN) sendCharSelect(charId,charIdx??0,stageId??0); },300); } catch(e){} }











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
            try { sessionStorage.setItem('charSelectData', JSON.stringify(msg)); } catch(e){}


            window._charSelectConfirmed = true;
            window.dispatchEvent(new CustomEvent('char_select_ack', { detail: msg }));

        } else if (msg.type === 'spectator_mode') {
            window._myClientId  = msg.clientId;
            window._isSpectator = true;
            window._spectatorMode = {
                mode:            msg.mode,
                watchingSession: msg.watchingSession,
                activeSessions:  msg.activeSessions,
                eliminated:      msg.eliminated ?? false,
            };
            // If we were just eliminated, mark it so victory events are treated
            // as "spectator watching the end" and not as personal defeat screen.
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




            const shakeByTier = { micro: 0.012, light: 0.028, medium: 0.055, heavy: 0.10, ultra: 0.18 };
            const shakeAmt = shakeByTier[msg.tier] ?? 0.02;

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

        } else if (msg.type === 'state') {
            window._gameState = msg;
            try { sessionStorage.setItem('gameState', JSON.stringify(msg)); } catch {   }

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
            // If this client was eliminated earlier and is now watching as a spectator,
            // we must NOT trigger the personal loss/victory screen. Instead we just
            // dispatch the event so the frontend can show a "X wins!" overlay.
            // Only activate _victoryState (which drives the reload/end-screen logic)
            // once the whole match is truly over (handled by match_end below).
            if (window._isSpectator && window._eliminatedFromSession) {
                // Broadcast a neutral victory notification for spectators/eliminated players
                window.dispatchEvent(new CustomEvent('victory_spectator', { detail: {
                    winner:   msg.winner,
                    loser:    msg.loser,
                    isWinner: false,
                    spectating: true,
                }}));
                // Freeze winner animation in local state so it renders correctly
                if (window._gameState && window._gameState.players) {
                    const wp = window._gameState.players[msg.winner];
                    if (wp) {
                        wp.animation = 'victory';
                        wp.frozen    = true;
                    }
                }
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
                if (wp) {
                    wp.animation = 'victory';
                    wp.frozen    = true;
                }
            }

            window.dispatchEvent(new CustomEvent('victory', { detail: window._victoryState }));
            if (isWinner) console.log('[GAME] Victory! Reload para la próxima partida.');

        } else if (msg.type === 'match_finished') {
            // The session is permanently over. Clear all persisted identity so that
            // any reload (winner or spectator) starts a brand-new connection instead
            // of trying to rejoin a session that no longer exists.
            try {
                sessionStorage.removeItem('clientId');
                sessionStorage.removeItem('charSelectData');
                sessionStorage.removeItem('pendingCharSelect');
                sessionStorage.removeItem('watchSession');
                sessionStorage.removeItem('gameState');
            } catch(e) {}
            window._myClientId         = -1;
            window._charSelectData     = null;
            window._charSelectConfirmed = false;
            window._victoryConsumed    = true;
            window.dispatchEvent(new CustomEvent('match_finished', { detail: { sessionId: msg.sessionId } }));

        } else if (msg.type === 'match_end') {
            const isWinnerMe = msg.winner === window._myClientId;
            window._lastMatchResult = { winner: msg.winner, loser: msg.loser, isWinner: isWinnerMe, matchId: msg.matchId };
            // Clear eliminated-spectator flag now that the match is fully over
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


function sendInput(frame) {
    if (!window._ws || window._ws.readyState !== WebSocket.OPEN) return;


    if (window._isSpectator) return;


    if (window._victoryState && !window._victoryConsumed) return;


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
        } catch (e) {   }
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