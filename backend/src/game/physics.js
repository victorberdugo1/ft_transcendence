'use strict';

const {
    TICK_DT, TICK_RATE,
    GRAVITY, MOVE_SPEED, DASH_SPEED, DASH_DURATION, DASH_COOLDOWN,
    GROUND_Y, KNOCKBACK_DECAY, MIN_KNOCKBACK,
    STAGE_LEFT, STAGE_RIGHT, STAGE_BOTTOM,
    ATTACK_DURATION, ATTACK_COOLDOWN, ATTACK_RANGE, ATTACK_RANGE_Y,
    ATTACK_KNOCKBACK, ATTACK_KB_UP,
    VOLTAGE_MAX, VOLTAGE_PER_HIT, VOLTAGE_DRAIN_BLOCK,
    DASH_ATTACK_WINDOW, DASH_ATTACK_KB_MULT, DASH_ATTACK_RANGE_X,
    BLOCK_KB_MULTIPLIER, BLOCK_MOVE_FACTOR, BLOCK_HOLD_TICKS, BLOCK_DASH_LOCKOUT,
    ANIM_DURATIONS, COMBO_WINDOW,
    PLAYER_RADIUS, PLAYER_HEIGHT,
} = require('./constants');

// ─── Voltage helpers ──────────────────────────────────────────────────────────

function voltageMultiplier(v) {
    if (v >= VOLTAGE_MAX) return 6.0;
    return 1.0 + Math.log(1 + v / 40) * 0.38;
}

function calcHitstop(attackerVoltage) {
    const v = attackerVoltage;
    if (v >= 200) {
        return { durationFrames: 22, tier: 'ultra' };
    } else if (v >= 150) {
        const t = (v - 150) / 50;
        return { durationFrames: Math.round(15 + t * 7), tier: 'heavy' };
    } else if (v >= 80) {
        const t = (v - 80) / 70;
        return { durationFrames: Math.round(10 + t * 5), tier: 'medium' };
    } else if (v >= 30) {
        const t = (v - 30) / 50;
        return { durationFrames: Math.round(6 + t * 4), tier: 'light' };
    } else {
        return { durationFrames: 3, tier: 'micro' };
    }
}

// ─── Animation helpers ────────────────────────────────────────────────────────

function decideAnim(p) {
    if (!p.onGround) return 'jump';
    if (p.dashing)   return 'dash';
    if (p.crouching) return 'crouch';
    if (p.blocking)  return 'block';
    if (p.vx !== 0)  return 'walk';
    return 'idle';
}

function resolveAttackAnim(p, isDashAttack, crouch) {
    if (isDashAttack) { p.comboStep = 0; return 'attack_dash'; }
    if (!p.onGround)  { p.comboStep = 0; return 'attack_air'; }
    if (crouch)       { p.comboStep = 0; return 'attack_crouch'; }
    if (p.comboWindow > 0 && p.comboStep > 0) {
        p.comboStep = p.comboStep < 3 ? p.comboStep + 1 : 1;
        return `attack_combo_${p.comboStep}`;
    }
    p.comboStep = 1;
    return 'attack_combo_1';
}

// ─── Hit resolution ───────────────────────────────────────────────────────────

/**
 * ctx shape (from session.js hitCtx):
 *   players, playerSession, gameSessions, hitstopBySession,
 *   broadcastToSession, WebSocket,
 *   onHit(attackerClientId, targetClientId)
 *   onCombo3(attackerClientId)
 */
function applyHit(attacker, target, ctx) {
    const { players, playerSession, gameSessions, hitstopBySession, broadcastToSession, WebSocket } = ctx;

    const dir          = target.x >= attacker.x ? 1 : -1;
    const attackerMult = voltageMultiplier(attacker.voltage);
    const defenderMult = voltageMultiplier(target.voltage);
    const dashMult     = attacker._isDashAttack ? DASH_ATTACK_KB_MULT : 1.0;
    const totalMult    = attackerMult * defenderMult * dashMult;
    let kbx = dir * (attacker.attackKnockback ?? ATTACK_KNOCKBACK) * totalMult;
    let kby = ATTACK_KB_UP * totalMult;

    const isBlocking = target.blocking && target.voltage < VOLTAGE_MAX;
    if (isBlocking) {
        kbx *= BLOCK_KB_MULTIPLIER;
        kby *= BLOCK_KB_MULTIPLIER;
        target.voltage = Math.min(VOLTAGE_MAX, target.voltage + VOLTAGE_PER_HIT * 0.25);
    } else {
        target.voltage = Math.min(VOLTAGE_MAX, target.voltage + VOLTAGE_PER_HIT);
        if (ctx.onHit) ctx.onHit(attacker.id, target.id);
    }

    if (target.voltage >= VOLTAGE_MAX) {
        target.voltage      = VOLTAGE_MAX;
        target.voltageMaxed = true;
    }

    target.kbx += kbx;
    target.kby += kby;
    target.hitId++;

    if (!isBlocking) {
        Object.assign(target, {
            animation: 'hurt',
            animTimer: ANIM_DURATIONS.hurt,
            dashing:   false,
            attacking: false,
            onGround:  false,
        });
    }

    attacker.hitTargets.add(target.id);

    const hs     = calcHitstop(attacker.voltage);
    const sessId = playerSession.get(attacker.id);
    if (sessId) {
        const existing = hitstopBySession[sessId];
        if (!existing || hs.durationFrames > existing.framesLeft) {
            hitstopBySession[sessId] = { framesLeft: hs.durationFrames, tier: hs.tier };
            const session = gameSessions.get(sessId);
            if (session) {
                broadcastToSession(session, {
                    type:       'hitstop',
                    tier:       hs.tier,
                    frames:     hs.durationFrames,
                    attackerId: attacker.id,
                    targetId:   target.id,
                });
            }
        }
    }
}

function resolveHits(p, players, ctx) {
    const alive  = Object.values(players).filter(t => !t.respawning);
    const rangeX = p._isDashAttack ? DASH_ATTACK_RANGE_X : (p.attackRange ?? ATTACK_RANGE);
    const hbCX   = p.x + p.facing * (rangeX / 2);
    const hbCY   = p.y + 0.5;
    const hbHW   = rangeX / 2;
    const hbHH   = ATTACK_RANGE_Y / 2;
    const hurtHW = 0.24;
    const hurtHH = 0.36;

    for (const target of alive) {
        if (target.id === p.id) continue;
        if (p.hitTargets.has(target.id)) continue;
        const tCX      = target.x;
        const tCY      = target.y + 0.36;
        const overlapX = Math.abs(hbCX - tCX) < (hbHW + hurtHW);
        const overlapY = Math.abs(hbCY - tCY) < (hbHH + hurtHH);
        if (!overlapX || !overlapY) continue;
        applyHit(p, target, ctx);
    }
}

// ─── Per-player tick ──────────────────────────────────────────────────────────

function tickBlock(p, moveX, attack, dash, dashAttack, block, crouch) {
    if (p.blockLockout > 0) p.blockLockout -= TICK_DT;

    const blockAllowed =
        p.onGround && !p.dashing && !p.attacking && !attack && !dashAttack
        && p.blockLockout  <= 0 && p.dashEndWindow <= 0 && !p.voltageMaxed;

    if (block && blockAllowed) {
        p.blockHoldTicks++;
    } else {
        p.blockHoldTicks = 0;
    }

    p.blocking = p.blockHoldTicks >= BLOCK_HOLD_TICKS;

    if (p.blocking && !p.voltageMaxed) {
        p.voltage = Math.max(0, p.voltage - VOLTAGE_DRAIN_BLOCK * TICK_DT);
    }
}

function tickDash(p, dash, dashDir, moveX, block, crouch) {
    if (p.dashEndWindow > 0) p.dashEndWindow -= TICK_DT;
    if (p.dashCooldown  > 0) p.dashCooldown  -= TICK_DT;

    if (dash && !p.dashing && p.dashCooldown <= 0 && !p.blocking) {
        p.dashing      = true;
        p.dashTimer    = DASH_DURATION;
        p.dashDir      = dashDir !== 0 ? Math.sign(dashDir) : p.facing;
        p.dashCooldown = DASH_COOLDOWN;
        p.kbx          = 0;
        p.kby          = 0;
        p.animation    = 'dash';
        p.animTimer    = ANIM_DURATIONS.dash;
    }

    if (p.dashing) {
        p.dashTimer -= TICK_DT;
        p.vx         = p.dashDir * (p.dashSpeed ?? DASH_SPEED);
        if (p.dashTimer <= 0) {
            p.dashing        = false;
            p.vx             = 0;
            p.dashEndWindow  = DASH_ATTACK_WINDOW;
            p.blockLockout   = BLOCK_DASH_LOCKOUT;
            p.blockHoldTicks = 0;
        }
    }
}

function tickMovement(p, moveX, jump, crouch) {
    if (!p.dashing) {
        if (p.blocking) {
            p.vx = moveX * (p.moveSpeed ?? MOVE_SPEED) * BLOCK_MOVE_FACTOR;
        } else if (crouch) {
            p.vx = 0;
        } else if (moveX !== 0) {
            p.vx     = moveX * (p.moveSpeed ?? MOVE_SPEED);
            p.facing = Math.sign(moveX);
        } else {
            p.vx = 0;
        }
    }

    p.crouching = p.onGround && !p.dashing && !p.attacking && !p.blocking && crouch;

    if (jump && p.jumpsLeft > 0 && !p.blocking) {
        p.vy        = 10.8;
        p.onGround  = false;
        p.jumpsLeft--;
        p.jumpId++;
        p.animation = 'jump';
        p.animTimer = ANIM_DURATIONS.jump;
        if (!p.dashing && moveX !== 0) {
            p.vx     = moveX * (p.moveSpeed ?? MOVE_SPEED);
            p.facing = Math.sign(moveX);
        }
    }
}

function tickAttack(p, attack, dashAttack, crouch, players, ctx) {
    if (p.attackCooldown > 0) p.attackCooldown -= TICK_DT;
    if (p.comboWindow    > 0) p.comboWindow    -= TICK_DT;

    const isDashAttack = (attack || dashAttack) && p.dashEndWindow > 0;
    const canAttack    = (attack || (dashAttack && p.dashEndWindow > 0))
                         && !p.attacking && p.attackCooldown <= 0;

    if (canAttack) {
        p.attacking     = true;
        p.attackTimer   = ATTACK_DURATION;
        p._isDashAttack = isDashAttack;
        const animName   = resolveAttackAnim(p, isDashAttack, crouch);
        p.animation      = animName;
        p.animTimer      = ANIM_DURATIONS[animName];
        p.comboWindow    = p.animTimer + COMBO_WINDOW;
        p.attackCooldown = p.comboStep > 0 ? 0.1 : ATTACK_COOLDOWN;
        p.hitTargets     = new Set();
        if (isDashAttack) p.dashEndWindow = 0;
        p._pendingCombo3 = (animName === 'attack_combo_3');
    }

    if (p.attackTimer > 0) {
        p.attackTimer -= TICK_DT;
        resolveHits(p, players, ctx);
        if (p.attackTimer <= 0) {
            if (p._pendingCombo3 && p.hitTargets.size > 0 && ctx.onCombo3) {
                ctx.onCombo3(p.id);
            }
            p._pendingCombo3 = false;
            p.attacking      = false;
            p._isDashAttack  = false;
        }
    }
}

// ─── Physics & collision ──────────────────────────────────────────────────────

function tickPhysics(alive) {
    const decayFactor = Math.pow(KNOCKBACK_DECAY, TICK_DT * TICK_RATE);
    for (const p of alive) {
        p.kbx *= decayFactor;
        p.kby *= decayFactor;
        if (Math.abs(p.kbx) < MIN_KNOCKBACK) p.kbx = 0;
        if (Math.abs(p.kby) < MIN_KNOCKBACK) p.kby = 0;
        if (!p.onGround) p.vy += GRAVITY * TICK_DT;
        p.prevY = p.y;
        p.x += (p.vx + p.kbx) * TICK_DT;
        p.y += (p.vy + p.kby) * TICK_DT;
    }
}

function tickCollisions(alive) {
    for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
            resolvePlayerCollision(alive[i], alive[j]);
        }
    }
}

function resolvePlayerCollision(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const overlapX = 2 * PLAYER_RADIUS - Math.abs(dx);
    const overlapY = PLAYER_HEIGHT - Math.abs(dy);
    if (overlapX <= 0 || overlapY <= 0) return;

    const dir      = dx >= 0 ? 1 : -1;
    const va       = a.vx + a.kbx;
    const vb       = b.vx + b.kbx;
    const aMoving  = Math.abs(a.vx) > 0.1 || Math.abs(a.kbx) > 0.5;
    const bMoving  = Math.abs(b.vx) > 0.1 || Math.abs(b.kbx) > 0.5;
    const opposite = Math.sign(va) !== Math.sign(vb) && aMoving && bMoving;

    if (opposite) {
        a.kbx -= dir * 1.5;
        b.kbx += dir * 1.5;
    } else if (aMoving && !bMoving) {
        b.kbx += dir * Math.abs(va) * 0.5;
    } else if (bMoving && !aMoving) {
        a.kbx -= dir * Math.abs(vb) * 0.5;
    }

    const sep = overlapX * 0.5 + 0.01;
    a.x -= dir * sep;
    b.x += dir * sep;
}

function tickPlatforms(alive, handleElimination, platforms) {
    for (const p of alive) {
        let landed = false;
        for (const plat of platforms) {
            const inRange  = Math.abs(p.x - plat.x) <= plat.hw;
            const wasAbove = p.prevY >= plat.y;
            const crossed  = p.y <= plat.y && (p.vy + p.kby) <= 0;
            if (inRange && wasAbove && crossed) {
                p.y         = plat.y;
                p.vy        = 0;
                p.kby       = 0;
                p.onGround  = true;
                p.jumpsLeft = 2;
                landed      = true;
                if (p.animation === 'jump') {
                    p.animTimer = 0;
                    p.animation = decideAnim(p);
                }
                break;
            }
        }

        if (!landed) p.onGround = false;

        const outOfBounds =
            p.y < STAGE_BOTTOM
            || p.x < STAGE_LEFT  - 2
            || p.x > STAGE_RIGHT + 2;

        if (outOfBounds) {
            p.stocks = Math.max(0, p.stocks - 1);
            if (p.stocks === 0) {
                const intercepted = handleElimination(p);
                if (!intercepted) return;
                // Winner fell into the void — restore 1 stock so the normal
                // respawn below runs correctly (stocks were already decremented).
                p.stocks = 1;
            }
            Object.assign(p, {
                respawning:   true,
                respawnTimer: 1.5,
                vx: 0, vy: 0, kbx: 0, kby: 0,
                animation:    'idle',
                voltageMaxed: false,
            });
        }
    }
}

function tickAnimations(alive) {
    for (const p of alive) {
        if (p.respawning) continue;
        if (p.animTimer > 0) {
            p.animTimer -= TICK_DT;
            if (p.animTimer <= 0) p.animation = decideAnim(p);
        } else if (p.animation !== 'hurt') {
            p.animation = decideAnim(p);
        }
    }
}

module.exports = {
    voltageMultiplier,
    calcHitstop,
    decideAnim,
    tickBlock,
    tickDash,
    tickMovement,
    tickAttack,
    tickPhysics,
    tickCollisions,
    tickPlatforms,
    tickAnimations,
};