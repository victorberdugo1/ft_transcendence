'use strict';

// ─── Tick ─────────────────────────────────────────────────────────────────────
const TICK_RATE = 60;
const TICK_DT   = 1 / TICK_RATE;
const GHOST_TTL = 30_000;

// ─── Physics ──────────────────────────────────────────────────────────────────
const GRAVITY         = -28.0;
const JUMP_FORCE      =  10.8;
const MOVE_SPEED      =   5.0;
const DASH_SPEED      =  14.0;
const DASH_DURATION   =   0.12;
const DASH_COOLDOWN   =   0.5;
const GROUND_Y        =   0.0;
const KNOCKBACK_DECAY =   0.85;
const MIN_KNOCKBACK   =   0.05;

// ─── Stage ────────────────────────────────────────────────────────────────────
const STAGE_LEFT   = -8.0;
const STAGE_RIGHT  =  8.0;
const STAGE_BOTTOM = -6.0;

// ─── Attack ───────────────────────────────────────────────────────────────────
const ATTACK_DURATION  = 0.3;
const ATTACK_COOLDOWN  = 0.5;
const ATTACK_RANGE     = 0.525;
const ATTACK_RANGE_Y   = 0.5;
const ATTACK_KNOCKBACK = 14.0;
const ATTACK_KB_UP     =  6.0;

// ─── Voltage ──────────────────────────────────────────────────────────────────
const VOLTAGE_MAX         = 200;
const VOLTAGE_PER_HIT     =  12;
const VOLTAGE_DRAIN_BLOCK =   8;

// ─── Dash attack ──────────────────────────────────────────────────────────────
const DASH_ATTACK_WINDOW  = 0.18;
const DASH_ATTACK_KB_MULT = 1.65;
const DASH_ATTACK_RANGE_X = 1.65;

// ─── Block ────────────────────────────────────────────────────────────────────
const BLOCK_KB_MULTIPLIER = 0.15;
const BLOCK_MOVE_FACTOR   = 0.05;
const BLOCK_HOLD_TICKS    = 35;
const BLOCK_DASH_LOCKOUT  = 0.6;

// ─── Hitstop ──────────────────────────────────────────────────────────────────
// HITSTOP_SHAKE is also consumed by ws-client.js — single source of truth.
const HITSTOP_THRESHOLDS = {
    ultra:  { minVoltage: 200, frames: 22 },
    heavy:  { minVoltage: 150, frames: { min: 15, max: 22 } },
    medium: { minVoltage:  80, frames: { min: 10, max: 15 } },
    light:  { minVoltage:  30, frames: { min:  6, max: 10 } },
    micro:  { minVoltage:   0, frames:  3 },
};

const HITSTOP_SHAKE = {
    micro:  0.012,
    light:  0.028,
    medium: 0.055,
    heavy:  0.10,
    ultra:  0.18,
};

// ─── Animation durations ──────────────────────────────────────────────────────
const ANIM_DURATIONS = {
    attack_air:     0.5,
    attack_crouch:  0.5,
    attack_combo_1: 0.35,
    attack_combo_2: 0.35,
    attack_combo_3: 0.5,
    attack_dash:    0.4,
    dash:           0.15,
    hurt:           0.4,
    jump:           0.15,
    block:          0.0,
};

const COMBO_WINDOW = 0.25;

// ─── Stage geometry ───────────────────────────────────────────────────────────
const PLATFORMS = [
    { x:  0, y: GROUND_Y, hw: (STAGE_RIGHT - STAGE_LEFT) / 2 },
    { x: -4, y: 1.6,      hw: 1.2 },
    { x:  4, y: 1.6,      hw: 1.2 },
    { x:  0, y: 2.8,      hw: 1.2 },
];

const PLAYER_RADIUS = 0.24;
const PLAYER_HEIGHT = 0.72;
const MAX_PLAYERS   = 8;

// ─── Characters ───────────────────────────────────────────────────────────────
const CHARACTER_DEFS = {
    eld: { name: 'Eldwin',  moveSpeed: 4.5, dashSpeed: 13.0, attackKnockback: 16.0, attackRange: 0.55 },
    hil: { name: 'Hilda',   moveSpeed: 5.5, dashSpeed: 15.0, attackKnockback: 12.0, attackRange: 0.50 },
    qui: { name: 'Quimbur', moveSpeed: 3.8, dashSpeed: 11.0, attackKnockback: 18.0, attackRange: 0.60 },
    gab: { name: 'Gabriel', moveSpeed: 6.0, dashSpeed: 16.0, attackKnockback: 11.0, attackRange: 0.48 },
};

const CHARACTER_ASSETS = {
    eld: { texCfg: 'data/textures/eld/bone_textures.txt', texSets: 'data/textures/eld/texture_sets.txt', animBase: 'data/animations/eld/', portrait: 'data/eldwin_portrait.jpg'  },
    hil: { texCfg: 'data/textures/hil/bone_textures.txt', texSets: 'data/textures/hil/texture_sets.txt', animBase: 'data/animations/hil/', portrait: 'data/hilda_portrait.jpg'   },
    qui: { texCfg: 'data/textures/qui/bone_textures.txt', texSets: 'data/textures/qui/texture_sets.txt', animBase: 'data/animations/qui/', portrait: 'data/quimbur_portrait.jpg' },
    gab: { texCfg: 'data/textures/gab/bone_textures.txt', texSets: 'data/textures/gab/texture_sets.txt', animBase: 'data/animations/gab/', portrait: 'data/gabriel_portrait.jpg' },
};

const CHAR_IDS = ['eld', 'hil', 'qui', 'gab'];

module.exports = {
    TICK_RATE, TICK_DT, GHOST_TTL,
    GRAVITY, JUMP_FORCE, MOVE_SPEED, DASH_SPEED, DASH_DURATION, DASH_COOLDOWN,
    GROUND_Y, KNOCKBACK_DECAY, MIN_KNOCKBACK,
    STAGE_LEFT, STAGE_RIGHT, STAGE_BOTTOM,
    ATTACK_DURATION, ATTACK_COOLDOWN, ATTACK_RANGE, ATTACK_RANGE_Y,
    ATTACK_KNOCKBACK, ATTACK_KB_UP,
    VOLTAGE_MAX, VOLTAGE_PER_HIT, VOLTAGE_DRAIN_BLOCK,
    DASH_ATTACK_WINDOW, DASH_ATTACK_KB_MULT, DASH_ATTACK_RANGE_X,
    BLOCK_KB_MULTIPLIER, BLOCK_MOVE_FACTOR, BLOCK_HOLD_TICKS, BLOCK_DASH_LOCKOUT,
    HITSTOP_THRESHOLDS, HITSTOP_SHAKE,
    ANIM_DURATIONS, COMBO_WINDOW,
    PLATFORMS, PLAYER_RADIUS, PLAYER_HEIGHT, MAX_PLAYERS,
    CHARACTER_DEFS, CHARACTER_ASSETS, CHAR_IDS,
};