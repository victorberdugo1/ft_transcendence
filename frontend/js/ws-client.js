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

const keys           = {};
// ── Voltage system input constants ───────────────────────────────────────────
const ACTION_KEY       = 'Space';   // tap = attack, intentional hold = block
const ACTION_KEY_ALT   = 'KeyG';
const DASH_TAP_MS      = 300;       // double-tap window for dash
const DASH_ATTACK_MS   = 200;       // window after dash to trigger dash attack
// Client uses ACTION_HOLD_MS only to decide tap vs hold on keyup.
// Block activation threshold and dash lockout are enforced server-side.
const ACTION_HOLD_MS   = 350;       // tap shorter than this → attack; longer → block

// ── Per-frame one-shot events ────────────────────────────────────────────────
const EMPTY_FRAME = { jump: false, attack: false, dash: false, dashDir: 0, dashAttack: false };
const frameEvents = { ...EMPTY_FRAME };

let lastTap       = { code: '', time: 0 };
let dashEndTime   = 0;   // ms timestamp of when the dash input was sent (client estimate)
let actionDownAt  = 0;
let actionFired   = false;

window.addEventListener('keydown', e => { keys[e.code] = true;  });
window.addEventListener('keyup',   e => { keys[e.code] = false; });

// Jump
window.addEventListener('keydown', (e) => {
	if (e.repeat) return;
	if (e.code === 'KeyW' || e.code === 'ArrowUp') frameEvents.jump = true;
});

// Action button down: record timestamp only
window.addEventListener('keydown', (e) => {
	if (e.repeat) return;
	if (e.code === ACTION_KEY || e.code === ACTION_KEY_ALT) {
		actionDownAt = Date.now();
		actionFired  = false;
	}
});

// Action button up: short tap → attack (or dash attack if timing was right)
window.addEventListener('keyup', (e) => {
	if (e.code === ACTION_KEY || e.code === ACTION_KEY_ALT) {
		const held = Date.now() - actionDownAt;
		// Only fire attack if released before the block threshold kicks in
		if (!actionFired && held < ACTION_HOLD_MS) {
			const sinceDash = Date.now() - dashEndTime;
			if (dashEndTime > 0 && sinceDash < DASH_ATTACK_MS) {
				frameEvents.dashAttack = true;
				dashEndTime = 0;  // consume window — one shot
			} else {
				frameEvents.attack = true;
			}
		}
		actionFired = false;
	}
});

// Dash: double-tap left/right
window.addEventListener('keydown', (e) => {
	if (e.repeat) return;
	if (e.code === 'ArrowLeft'  || e.code === 'KeyA' ||
		e.code === 'ArrowRight' || e.code === 'KeyD') {
		const now = Date.now();
		if (e.code === lastTap.code && now - lastTap.time < DASH_TAP_MS) {
			frameEvents.dash    = true;
			frameEvents.dashDir = (e.code === 'ArrowRight' || e.code === 'KeyD') ? 1 : -1;
			// Record when dash started; block is locked out for BLOCK_DASH_LOCKOUT_MS
			dashEndTime = now + (0.12 * 1000);  // approx when dash ends server-side
		}
		lastTap = { code: e.code, time: now };
	}
});

// ── Block: just send raw held state — server owns all timing logic ────────────
function isBlocking() {
	return !!(keys[ACTION_KEY] || keys[ACTION_KEY_ALT]);
}

// ── 60 Hz input loop ──────────────────────────────────────────────────────────
setInterval(() => {
	const moveX = (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0)
		- (keys['KeyA'] || keys['ArrowLeft']  ? 1 : 0);
	const crouch = !!(keys['KeyS'] || keys['ArrowDown']);
	const block  = isBlocking();

	window._sendInput(
		moveX,
		frameEvents.jump,
		frameEvents.attack,
		frameEvents.dash,
		frameEvents.dashDir,
		crouch,
		block,
		frameEvents.dashAttack
	);

	Object.assign(frameEvents, EMPTY_FRAME);
}, 1000 / 60);

// ── WebSocket ─────────────────────────────────────────────────────────────────
(function connectWS() {
	const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const ws = new WebSocket(`${protocol}//${location.host}/ws`);
	window._ws = ws;

	function setStatus(text) {
		const el = document.getElementById('status');
		if (el) el.textContent = text;
	}

	ws.addEventListener('open', () => {
		setStatus('⬤ Conectado');
		const savedId = sessionStorage.getItem('clientId');
		if (savedId) ws.send(JSON.stringify({ type: 'rejoin', clientId: parseInt(savedId, 10) }));
	});

	ws.addEventListener('message', ({ data }) => {
		let msg; try { msg = JSON.parse(data); } catch { return; }
		if (msg.type === 'init') {
			window._myClientId = msg.clientId;
			window._gameConfig = msg.config;   // ← config del servidor
			sessionStorage.setItem('clientId', msg.clientId);
		} else if (msg.type === 'state') {
			window._gameState = msg;
			try { sessionStorage.setItem('gameState', JSON.stringify(msg)); } catch {}
		} else {
			window._gameState = msg;
		}
	});

	ws.addEventListener('close', () => {
		window._myClientId = -1;
		setStatus('⬤ Desconectado (reconectando...)');
		setTimeout(connectWS, 2000);
	});

	ws.addEventListener('error', err => { console.error('[WS] Error:', err); ws.close(); });
})();

window._sendInput = function(moveX, jump, attack, dash, dashDir, crouch, block, dashAttack) {
	if (window._ws && window._ws.readyState === WebSocket.OPEN) {
		window._ws.send(JSON.stringify({
			type:       'input',
			moveX,
			jump:       jump       ? 1 : 0,
			attack:     attack     ? 1 : 0,
			dash:       dash       ? 1 : 0,
			dashDir:    dashDir    ?? 0,
			crouch:     crouch     ? 1 : 0,
			block:      block      ? 1 : 0,   // ← NEW
			dashAttack: dashAttack ? 1 : 0,   // ← NEW
		}));
	}
};