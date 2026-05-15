'use strict';

const { TICK_DT } = require('./constants');

// CPU client IDs start here to never collide with real players.
const CPU_ID_OFFSET = 9000;
let   cpuCounter    = 0;

// Reaction delay range (seconds). Keeps the bot from being frame-perfect.
const REACT_MIN = 0.08;
const REACT_MAX = 0.22;

function randBetween(a, b) {
    return a + Math.random() * (b - a);
}

// ─── CPU player factory ───────────────────────────────────────────────────────

function createCpuPlayer(charId, characterDefs, groundY) {
    const id  = CPU_ID_OFFSET + cpuCounter++;
    const def = characterDefs[charId] ?? characterDefs.eld;

    return {
        id,
        isCpu:          true,
        charId,
        dbUserId:       null,
        x:              2.0,
        y:              groundY,
        vx: 0, vy: 0,
        kbx: 0, kby: 0,
        onGround:       true,
        jumpsLeft:      2,
        facing:         -1,
        dashing:        false,
        dashTimer:      0,
        dashDir:        0,
        dashCooldown:   0,
        dashEndWindow:  0,
        attacking:      false,
        attackTimer:    0,
        attackCooldown: 0,
        comboStep:      0,
        comboWindow:    0,
        _isDashAttack:  false,
        hitId:          0,
        hitTargets:     new Set(),
        jumpId:         0,
        crouching:      false,
        animation:      'idle',
        animTimer:      0,
        stocks:         3,
        prevSessionId:  null,
        respawning:     false,
        respawnTimer:   0,
        voltage:        0,
        voltageMaxed:   false,
        blocking:       false,
        blockLockout:   0,
        blockHoldTicks: 0,
        prevY:          groundY,
        moveSpeed:      def.moveSpeed,
        dashSpeed:      def.dashSpeed,
        attackKnockback:def.attackKnockback,
        attackRange:    def.attackRange,
        // ws is intentionally null — the CPU never sends messages.
        ws: { readyState: -1, send: () => {} },
        input: {
            moveX: 0, jump: false, attack: false,
            dash: false, dashDir: 0, crouch: false,
            block: false, dashAttack: false,
        },
        // Internal AI state
        _ai: {
            reactionTimer:  0,
            pendingInput:   null,
            actionCooldown: 0,
        },
    };
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

function tickCpu(cpu, target) {
    if (!target || cpu.respawning) return;

    const ai = cpu._ai;

    // Clear one-shot inputs from the previous tick.
    cpu.input.jump       = false;
    cpu.input.attack     = false;
    cpu.input.dash       = false;
    cpu.input.dashAttack = false;

    // Count down timers.
    if (ai.reactionTimer   > 0) { ai.reactionTimer   -= TICK_DT; return; }
    if (ai.actionCooldown  > 0) { ai.actionCooldown  -= TICK_DT; }

    // Apply a pending decision that just cleared its reaction delay.
    if (ai.pendingInput) {
        Object.assign(cpu.input, ai.pendingInput);
        ai.pendingInput   = null;
        ai.reactionTimer  = randBetween(REACT_MIN, REACT_MAX);
        ai.actionCooldown = randBetween(0.15, 0.35);
        return;
    }

    if (ai.actionCooldown > 0) return;

    const dx   = target.x - cpu.x;
    const dy   = target.y - cpu.y;
    const dist = Math.abs(dx);
    const dir  = Math.sign(dx) || 1;

    let next = { moveX: 0, jump: false, attack: false, dash: false, dashDir: 0, dashAttack: false };

    if (dist < 0.8) {
        // In attack range — hit.
        next.moveX  = 0;
        next.attack = true;
    } else if (dist < 3.0) {
        // Close — walk toward target, jump if target is above.
        next.moveX = dir;
        if (dy > 0.8 && cpu.jumpsLeft > 0) next.jump = true;
    } else {
        // Far — dash toward target.
        next.moveX  = dir;
        next.dash   = true;
        next.dashDir = dir;
    }

    ai.pendingInput  = next;
    ai.reactionTimer = randBetween(REACT_MIN, REACT_MAX);
}

module.exports = { createCpuPlayer, tickCpu };
