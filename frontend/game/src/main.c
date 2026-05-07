/**
 * main.c – Client renderer (Raylib + Emscripten)
 *
 * Responsibilities:
 *   • Reads game state written by ws-client.js into window._gameState.
 *   • Initialises / frees animated character objects per player.
 *   • Advances animation, applies physics-driven visual transforms, draws the scene.
 *   • Renders a HUD with stocks and a colour-coded voltage bar.
 *   • Supports spectator mode (no local player — camera follows action centroid).
 */

#include "raylib.h"
#include "raymath.h"
#include "bones_core.h"

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ─────────────────────────────────────────────────────────────────────────────
//  COMPILE-TIME CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
#define MAX_PLAYERS  8
#define ANIM_COUNT   15

#define STAGE_LEFT   -8.0f
#define STAGE_RIGHT   8.0f
#define STAGE_Y      -0.05f
#define PLATFORM_H    0.12f

// ─────────────────────────────────────────────────────────────────────────────
//  SERVER-SYNCED HITBOX DIMENSIONS  (overwritten on first 'init' message)
// ─────────────────────────────────────────────────────────────────────────────
static float ATTACK_RANGE   = 0.525f;
static float ATTACK_RANGE_Y = 0.5f;

// ─────────────────────────────────────────────────────────────────────────────
//  WINDOW / CAMERA
// ─────────────────────────────────────────────────────────────────────────────
static int    SCREEN_W   = 800;
static int    SCREEN_H   = 600;
static Camera scene_cam;

// ─────────────────────────────────────────────────────────────────────────────
//  ANIMATION ASSET TABLES
// ─────────────────────────────────────────────────────────────────────────────
static const char *ANIM_JSON[ANIM_COUNT] = {
	"data/animations/idle.json",
	"data/animations/walk.json",
	"data/animations/jump.json",
	"data/animations/attack_air.json",
	"data/animations/attack_combo_1.json",
	"data/animations/attack_combo_2.json",
	"data/animations/attack_combo_3.json",
	"data/animations/attack_crouch.json",
	"data/animations/dash.json",
	"data/animations/crouch.json",
	"data/animations/crouch.json",
	"data/animations/hurt.json",
	"data/animations/block.json",
	"data/animations/attack_dash.json",
	"data/animations/victory.json",      /* índice 14 */
};

static const char *ANIM_META[ANIM_COUNT] = {
	"data/animations/idle.anim",
	"data/animations/walk.anim",
	"data/animations/jump.anim",
	"data/animations/attack_air.anim",
	"data/animations/attack_combo_1.anim",
	"data/animations/attack_combo_2.anim",
	"data/animations/attack_combo_3.anim",
	"data/animations/attack_crouch.anim",
	"data/animations/dash.anim",
	"data/animations/crouch.anim",
	"data/animations/crouch.anim",
	"data/animations/hurt.anim",
	"data/animations/block.anim",
	"data/animations/attack_dash.anim",
	"data/animations/victory.anim",      /* índice 14 */
};

static const char *ANIM_NAME[ANIM_COUNT] = {
	"idle", "walk", "jump",
	"attack_air", "attack_combo_1", "attack_combo_2", "attack_combo_3",
	"attack_crouch", "dash", "crouch", "crouch_loop",
	"hurt", "block", "attack_dash",
	"victory",                            /* índice 14 */
};

// ─────────────────────────────────────────────────────────────────────────────
//  PLAYER  (client-side representation)
// ─────────────────────────────────────────────────────────────────────────────
typedef struct {
	/* Identity */
	int  id;
	int  active;     /* 0 = empty, 1 = alive, 2 = pending asset load */

	/* World transform */
	float wx, wy;
	float rotation;
	float visualRotation;  /* smoothly interpolated toward rotation */

	/* Animation */
	char animation[24];
	int  animIndex;

	/* Game state mirrored from server */
	int   stocks;
	bool  respawning;
	bool  crouching;
	int   hitId;
	int   jumpId;
	float voltage;        /* 0.0 – 200.0 */
	bool  voltageMaxed;
	bool  blocking;

	/* Attack hit-flash (debug / visual feedback) */
	float attackFlashTimer;
	float attackFlashFacing;

	/* Skeleton reference frame for stable foot placement */
	Vector3 referenceCenter;
	bool    hasReferenceCenter;
	float   anchorYOffset;
	bool    hasAnchorY;

	/* Bones animation controller */
	AnimatedCharacter *character;
} Player;

// ─────────────────────────────────────────────────────────────────────────────
//  GLOBAL STATE
// ─────────────────────────────────────────────────────────────────────────────
static Player players[MAX_PLAYERS];
static int    my_id            = -1;
static bool   is_spectator     = false;
static bool   game_ready       = false;
static bool   debug_mode       = false;
/* Cuenta frames sin ID — si supera el umbral y hay jugadores en gameState,
   forzamos modo espectador para no quedarnos en "Connecting..." eternamente */
static int    no_id_frames     = 0;
#define NO_ID_SPECTATOR_FRAMES 180   /* ~3 segundos a 60fps */

/* Estado de fin de partida */
static bool   match_over          = false;
static int    winner_id           = -1;
static char   winner_message[80]  = {0};

/* Deferred player-init queue — one InitPlayer per frame to avoid hitches. */
#define MAX_PENDING 8
static int pending_ids[MAX_PENDING];
static int pending_count = 0;

// ─────────────────────────────────────────────────────────────────────────────
//  FORWARD DECLARATIONS
// ─────────────────────────────────────────────────────────────────────────────
static void InitPlayer(Player *p, int id);
static void FreePlayer(Player *p);
static void FetchState(void);
static void DrawGame(void);

/* EM_JS forward declarations */
int   ws_get_victory_state(void);
int   ws_get_victory_winner(void);
void  ws_consume_victory(void);
int   ws_get_countdown(void);
float ws_get_countdown_elapsed(void);

// ─────────────────────────────────────────────────────────────────────────────
//  JAVASCRIPT BRIDGE  (EM_JS — inline JS called from C)
// ─────────────────────────────────────────────────────────────────────────────
EM_JS(int, js_canvas_width, (void), {
		return (window._canvasWidth > 0) ? (window._canvasWidth | 0) : 800;
		});
EM_JS(int, js_canvas_height, (void), {
		return (window._canvasHeight > 0) ? (window._canvasHeight | 0) : 600;
		});
EM_JS(int, ws_get_my_id, (void), {
		return (window._myClientId > 0) ? (window._myClientId | 0) : -1;
		});

/* FIX: returns 1 if the local client is confirmed as spectator.
   Requires both _isSpectator=true AND _myClientId to be set,
   so we don't flip to spectator before the handshake completes. */
EM_JS(int, ws_is_spectator, (void), {
		return (window._isSpectator && window._myClientId > 0) ? 1 : 0;
		});

EM_JS(float, ws_get_attack_range, (void), {
		return (window._gameConfig && window._gameConfig.attackRange)
		? window._gameConfig.attackRange : 0.525;
		});
EM_JS(float, ws_get_attack_range_y, (void), {
		return (window._gameConfig && window._gameConfig.attackRangeY)
		? window._gameConfig.attackRangeY : 0.5;
		});
EM_JS(int, ws_player_count, (void), {
		if (!window._gameState || !window._gameState.players) return 0;
		return Object.keys(window._gameState.players).length;
		});

/**
 * Lee el estado de victoria desde variables JS planas (sin punteros).
 * Devuelve:
 *   0  → sin victoria
 *   1  → yo gané
 *   2  → yo perdí / espectador
 */
EM_JS(int, ws_get_victory_state, (void), {
    if (!window._victoryActive || window._victoryConsumed) return 0;
    return window._victoryIsWinner ? 1 : 2;
});

/** Devuelve el clientId del ganador, o -1 si no hay victoria activa. */
EM_JS(int, ws_get_victory_winner, (void), {
    if (!window._victoryActive || window._victoryConsumed) return -1;
    return window._victoryWinner | 0;
});

EM_JS(void, ws_consume_victory, (void), {
    window._victoryConsumed = true;
});

/**
 * Devuelve la fase del countdown:
 *   0 = sin countdown / terminado
 *   1 = READY  (0 – 1.2 s)
 *   2 = FIGHT  (1.2 – 2.2 s)
 * Al superar 2.2 s marca _countdownDone = true automáticamente.
 */
EM_JS(int, ws_get_countdown, (void), {
    if (!window._countdownStart || window._countdownDone) return 0;
    var elapsed = (performance.now() - window._countdownStart) / 1000.0;
    if (elapsed < 1.2) return 1;
    if (elapsed < 2.2) return 2;
    window._countdownDone = true;
    return 0;
});

/** Devuelve el tiempo transcurrido en el countdown (segundos), o 0. */
EM_JS(float, ws_get_countdown_elapsed, (void), {
    if (!window._countdownStart || window._countdownDone) return 0.0;
    return (performance.now() - window._countdownStart) / 1000.0;
});

/**
 * Devuelve 1 si hay resultados de partida pendientes en la UI legacy
 * (match_end — se mantiene por compatibilidad con HUD de torneos).
 */
EM_JS(int, ws_get_match_overlay, (char *buf, int len), {
		buf = buf | 0;
		if (window._lastMatchResult && !window._matchResultConsumed) {
		const r = window._lastMatchResult;
		const msg = r.isWinner ? 'YOU WIN!' : 'YOU LOSE';
		stringToUTF8(msg, buf, len);
		return r.isWinner ? 1 : 2;
		}
		if (window._waitingForNextMatch) {
		stringToUTF8('Waiting for next match...', buf, len);
		return 3;
		}
		stringToUTF8('', buf, len);
		return 0;
		});

EM_JS(void, ws_consume_match_result, (void), {
		window._lastMatchResult        = null;
		window._matchResultConsumed    = true;
		window._waitingForNextMatch    = false;
		});

/**
 * Lee el mensaje match_winner del servidor.
 * Devuelve el clientId del ganador (>0) o -1 si no hay ganador todavía.
 * Escribe el mensaje en buf.
 */
EM_JS(int, ws_get_match_winner, (char *buf, int len), {
		buf = buf | 0;
		if (!window._lastMatchResult || window._matchResultConsumed) {
		stringToUTF8('', buf, len);
		return -1;
		}
		const msg = window._lastMatchResult.message || '';
		stringToUTF8(msg, buf, len);
		return (window._lastMatchResult.winner | 0);
		});

/**
 * Serialises player[idx] from the JS game-state into a pipe-delimited string.
 * Fields: id|x|y|rotation|animation|stocks|respawning|hitId|crouching|jumpId
 *        |voltage|blocking|voltageMaxed
 */
EM_JS(int, ws_get_player, (int idx, char *buf, int len), {
		if (!window._gameState || !window._gameState.players) return 0;
		const ids = Object.keys(window._gameState.players);
		if (idx >= ids.length) return 0;
		const p = window._gameState.players[ids[idx]];
		if (!p) return 0;
		const fields = [
		p.id | 0,
		(p.x        ?? 0).toFixed(3),
		(p.y        ?? 0).toFixed(3),
		(p.rotation ?? 0).toFixed(4),
		p.animation || 'idle',
		p.stocks    ?? 3,
		p.respawning    ? 1 : 0,
		p.hitId     ?? 0,
		p.crouching     ? 1 : 0,
		p.jumpId    ?? 0,
		(p.voltage  ?? 0).toFixed(1),
		p.blocking      ? 1 : 0,
		p.voltageMaxed  ? 1 : 0,
		].join('|');
		stringToUTF8(fields, buf, len);
		return 1;
});

// ─────────────────────────────────────────────────────────────────────────────
//  UTILITY
// ─────────────────────────────────────────────────────────────────────────────
/** Null-safe, always-null-terminated string copy. */
static void strcpy_safe(char *dst, const char *src, size_t n) {
	strncpy(dst, src, n - 1);
	dst[n - 1] = '\0';
}

/** Returns the animation-table index for the named clip, or 0 (idle) as fallback. */
static int AnimIndex(const char *name) {
	for (int i = 0; i < ANIM_COUNT; i++)
		if (strcmp(name, ANIM_NAME[i]) == 0) return i;
	return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SKELETON UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
/** Computes the mean position of all valid bone positions in a frame. */
static Vector3 CalcAnimCenter(const AnimationFrame *frame) {
	if (!frame || !frame->valid || frame->personCount == 0)
		return (Vector3){ 0, 0, 0 };

	Vector3 sum  = { 0, 0, 0 };
	int     n    = 0;
	for (int pi = 0; pi < frame->personCount; pi++) {
		const Person *person = &frame->persons[pi];
		if (!person->active) continue;
		for (int b = 0; b < person->boneCount; b++) {
			const Bone *bone = &person->bones[b];
			if (!bone->position.valid) continue;
			sum = Vector3Add(sum, bone->position.position);
			n++;
		}
	}
	return n > 0 ? Vector3Scale(sum, 1.0f / (float)n) : (Vector3){ 0, 0, 0 };
}

/** Finds a bone by name within one person's skeleton. Returns -1 if not found. */
static int FindBoneByName(const Person *person, const char *name) {
	if (!person || !name) return -1;
	for (int b = 0; b < person->boneCount; b++)
		if (strcmp(person->bones[b].name, name) == 0) return b;
	return -1;
}

/** Writes a named bone's world position into *outPos. Returns false if absent. */
static bool GetBonePosition(const AnimationFrame *frame, const char *name, Vector3 *outPos) {
	if (!frame || !outPos || !frame->valid) return false;
	for (int pi = 0; pi < frame->personCount; pi++) {
		const Person *person = &frame->persons[pi];
		if (!person->active) continue;
		int idx = FindBoneByName(person, name);
		if (idx >= 0 && person->bones[idx].position.valid) {
			*outPos = person->bones[idx].position.position;
			return true;
		}
	}
	return false;
}

/** Computes the mid-point between LAnkle and RAnkle. Returns false if either is missing. */
static bool CalcAnkleMidPoint(const AnimationFrame *frame, Vector3 *outPos) {
	if (!frame || !outPos || !frame->valid) return false;
	Vector3 left = {0}, right = {0};
	bool hasL = GetBonePosition(frame, "LAnkle", &left);
	bool hasR = GetBonePosition(frame, "RAnkle", &right);
	if (!hasL || !hasR) return false;
	*outPos = Vector3Scale(Vector3Add(left, right), 0.5f);
	return true;
}

/** Translates every bone in every frame of an animation by `offset`. */
static void ApplyOffsetToAnim(BonesAnimation *anim, Vector3 offset) {
	if (!anim || !anim->isLoaded) return;
	for (int f = 0; f < anim->frameCount; f++) {
		AnimationFrame *frame = &anim->frames[f];
		if (!frame->valid) continue;
		for (int pi = 0; pi < frame->personCount; pi++) {
			Person *person = &frame->persons[pi];
			if (!person->active) continue;
			for (int b = 0; b < person->boneCount; b++) {
				Bone *bone = &person->bones[b];
				if (bone->position.valid)
					bone->position.position = Vector3Add(bone->position.position, offset);
			}
		}
	}
}

/**
 * Removes lateral drift from an animation by aligning every frame's
 * horizontal centroid to that of frame 0.
 */
static void StabilizeAnimX(BonesAnimation *anim) {
	if (!anim || !anim->isLoaded || anim->frameCount < 2) return;

	/* Compute frame-0 centroid X. */
	float baseX = 0.0f;
	int   n0    = 0;
	AnimationFrame *f0 = &anim->frames[0];
	for (int pi = 0; pi < f0->personCount; pi++) {
		const Person *person = &f0->persons[pi];
		if (!person->active) continue;
		for (int b = 0; b < person->boneCount; b++)
			if (person->bones[b].position.valid) {
				baseX += person->bones[b].position.position.x;
				n0++;
			}
	}
	if (n0 == 0) return;
	baseX /= (float)n0;

	/* Shift frames 1..N to match frame-0 X. */
	for (int f = 1; f < anim->frameCount; f++) {
		AnimationFrame *frame = &anim->frames[f];
		if (!frame->valid) continue;
		float cx = 0.0f; int n = 0;
		for (int pi = 0; pi < frame->personCount; pi++) {
			const Person *person = &frame->persons[pi];
			if (!person->active) continue;
			for (int b = 0; b < person->boneCount; b++)
				if (person->bones[b].position.valid) { cx += person->bones[b].position.position.x; n++; }
		}
		if (n == 0) continue;
		float dx = baseX - (cx / (float)n);
		if (fabsf(dx) < 0.0001f) continue;
		for (int pi = 0; pi < frame->personCount; pi++) {
			Person *person = &frame->persons[pi];
			if (!person->active) continue;
			for (int b = 0; b < person->boneCount; b++)
				if (person->bones[b].position.valid)
					person->bones[b].position.position.x += dx;
		}
	}
}

/** Returns the blend transition duration (seconds) appropriate for the named clip. */
static float TransitionDuration(const char *anim) {
	if (!anim)                               return 0.10f;
	if (strncmp(anim, "idle",        4) == 0) return 0.10f;
	if (strncmp(anim, "walk",        4) == 0) return 0.10f;
	if (strncmp(anim, "jump",        4) == 0) return 0.08f;
	if (strncmp(anim, "crouch",      6) == 0) return 0.10f;
	if (strncmp(anim, "dash",        4) == 0) return 0.06f;
	if (strncmp(anim, "hurt",        4) == 0) return 0.10f;
	if (strncmp(anim, "block",       5) == 0) return 0.08f;
	if (strncmp(anim, "attack_dash", 11) == 0) return 0.06f;
	return 0.12f;
}

/**
 * Loads an animation, applies foot-anchor stabilisation, and optionally
 * snaps or offsets it to align with the reference centre established by
 * the first animation loaded for this player.
 */
static bool LoadAnimWithOffset(Player *p, const char *jsonPath, const char *metaPath) {
	if (!p || !p->character) return false;
	if (!LoadAnimation(p->character, jsonPath, metaPath)) return false;

	SetAnimationTransitionDuration(p->character, TransitionDuration(p->animation));

	BonesAnimation *anim = &p->character->animation;
	if (!anim->isLoaded || anim->frameCount == 0) return true;

	StabilizeAnimX(anim);

	Vector3 thisCenter = {0};
	bool    hasCtr     = CalcAnkleMidPoint(&anim->frames[0], &thisCenter);
	if (!hasCtr) thisCenter = CalcAnimCenter(&anim->frames[0]);

	if (!p->hasReferenceCenter) {
		/* First animation loaded — zero XZ drift and record anchor. */
		Vector3 xzOffset = { -thisCenter.x, 0.0f, -thisCenter.z };
		if (fabsf(xzOffset.x) > 0.001f || fabsf(xzOffset.z) > 0.001f)
			ApplyOffsetToAnim(anim, xzOffset);

		/* Re-sample after offset. */
		hasCtr = CalcAnkleMidPoint(&anim->frames[0], &thisCenter);
		if (!hasCtr) thisCenter = CalcAnimCenter(&anim->frames[0]);

		p->referenceCenter    = thisCenter;
		p->hasReferenceCenter = true;
		p->anchorYOffset      = thisCenter.y;
		p->hasAnchorY         = true;
	} else {
		/* Subsequent animations — align to the stored reference. */
		Vector3 delta = Vector3Subtract(p->referenceCenter, thisCenter);
		if (Vector3Length(delta) > 0.001f)
			ApplyOffsetToAnim(anim, delta);
	}

	p->character->forceUpdate = true;
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  DEFERRED PLAYER INIT QUEUE
// ─────────────────────────────────────────────────────────────────────────────
static void QueuePlayerInit(int id) {
	for (int i = 0; i < pending_count; i++)
		if (pending_ids[i] == id) return;   /* already queued */
	if (pending_count < MAX_PENDING)
		pending_ids[pending_count++] = id;
}

/** Pops one player from the queue and calls InitPlayer — called once per frame. */
static void FlushOnePlayerInit(void) {
	if (pending_count == 0) return;

	int id = pending_ids[0];
	memmove(pending_ids, pending_ids + 1, (size_t)(pending_count - 1) * sizeof(int));
	pending_count--;

	for (int s = 0; s < MAX_PLAYERS; s++) {
		if (players[s].id == id && players[s].active == 2) {
			InitPlayer(&players[s], id);
			break;
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
//  PLAYER LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────
static void InitPlayer(Player *p, int id) {
	/* Preserve visual state across re-init (e.g. re-connection). */
	const Player prev = *p;

	memset(p, 0, sizeof(Player));
	p->id                 = id;
	p->active             = 1;
	p->animIndex          = prev.animIndex;
	p->wx                 = prev.wx;
	p->wy                 = prev.wy;
	p->rotation           = prev.rotation;
	p->visualRotation     = prev.visualRotation;
	p->stocks             = prev.stocks > 0 ? prev.stocks : 3;
	p->hitId              = prev.hitId;
	p->anchorYOffset      = prev.anchorYOffset;
	p->hasAnchorY         = prev.hasAnchorY;
	p->referenceCenter    = prev.referenceCenter;
	p->hasReferenceCenter = prev.hasReferenceCenter;
	strcpy_safe(p->animation, prev.animation, sizeof(p->animation));

	p->character = CreateAnimatedCharacter(
			"data/textures/zeta/bone_textures.txt",
			"data/textures/zeta/texture_sets.txt"
			);

	if (p->character) {
		LockAnimationRootXZ(p->character, true);
		SetCharacterBillboards(p->character, true, true);
		SetCharacterAutoPlay(p->character, true);
		LoadAnimWithOffset(p, ANIM_JSON[p->animIndex], ANIM_META[p->animIndex]);
	}
}

static void FreePlayer(Player *p) {
	if (p->character) {
		DestroyAnimatedCharacter(p->character);
		p->character = NULL;
	}
	p->active = 0;
	p->id     = -1;
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATE PARSING
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Parses a pipe-delimited player record produced by ws_get_player().
 * Returns 1 on success, 0 on parse failure.
 */
static int ParsePlayer(const char *buf,
		int *id, float *x, float *y, float *rot,
		char *anim, int animLen,
		int *stocks, int *respawning, int *hitId,
		int *crouching, int *jumpId,
		float *voltage, int *blocking, int *voltageMaxed)
{
	char  tmp[256];
	char *tok;
	strncpy(tmp, buf, 255); tmp[255] = '\0';

	tok = strtok(tmp,  "|"); if (!tok) return 0; *id         = atoi(tok);
	tok = strtok(NULL, "|"); if (!tok) return 0; *x          = (float)atof(tok);
	tok = strtok(NULL, "|"); if (!tok) return 0; *y          = (float)atof(tok);
	tok = strtok(NULL, "|"); if (!tok) return 0; *rot        = (float)atof(tok);

	tok = strtok(NULL, "|");
	strncpy(anim, tok ? tok : "idle", (size_t)(animLen - 1));
	anim[animLen - 1] = '\0';

	tok = strtok(NULL, "|"); *stocks       = tok ? atoi(tok) : 3;
	tok = strtok(NULL, "|"); *respawning   = tok ? atoi(tok) : 0;
	tok = strtok(NULL, "|"); *hitId        = tok ? atoi(tok) : 0;
	tok = strtok(NULL, "|"); *crouching    = tok ? atoi(tok) : 0;
	tok = strtok(NULL, "|"); *jumpId       = tok ? atoi(tok) : 0;
	tok = strtok(NULL, "|"); *voltage      = tok ? (float)atof(tok) : 0.0f;
	tok = strtok(NULL, "|"); *blocking     = tok ? atoi(tok) : 0;
	tok = strtok(NULL, "|"); *voltageMaxed = tok ? atoi(tok) : 0;

	return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATE FETCH  (called every frame before Draw)
// ─────────────────────────────────────────────────────────────────────────────
static void FetchState(void) {
	/* Always process whatever state JS has — even during the connecting phase.
	   Cached gameState from sessionStorage will render immediately on refresh
	   while we wait for the server handshake.  The ghost guard below keeps
	   stale slots from appearing. */

	int  count = ws_player_count();
	char buf[256];
	int  seen[MAX_PLAYERS] = {0};

	for (int i = 0; i < count && i < MAX_PLAYERS; i++) {
		if (!ws_get_player(i, buf, sizeof(buf))) continue;

		int   pid, pstocks, prespawning, phitId, pcrouching, pjumpId, pblocking, pvoltageMaxed;
		float px, py, prot, pvoltage;
		char  panim[24];

		if (!ParsePlayer(buf, &pid, &px, &py, &prot, panim, sizeof(panim),
					&pstocks, &prespawning, &phitId, &pcrouching, &pjumpId,
					&pvoltage, &pblocking, &pvoltageMaxed)) continue;

		/* Spectators must not instantiate a player object for their own
		   clientId — they have no player entry on the server. */
		if (is_spectator && my_id > 0 && pid == my_id) continue;

		/* Buscar o crear un slot para este jugador */
		int slot = -1;
		for (int s = 0; s < MAX_PLAYERS; s++)
			if (players[s].active && players[s].id == pid) { slot = s; break; }
		if (slot < 0)
			for (int s = 0; s < MAX_PLAYERS; s++)
				if (!players[s].active) { slot = s; break; }
		if (slot < 0) continue;

		/* Jugador nuevo → encolar carga de assets */
		if (!players[slot].active) {
			players[slot].id        = pid;
			players[slot].active    = 2;
			players[slot].animIndex = AnimIndex(panim);
			strcpy_safe(players[slot].animation, panim, sizeof(players[slot].animation));
			QueuePlayerInit(pid);
		}

		seen[slot] = 1;

		/* Actualizar transformación y estado del juego */
		players[slot].wx           = px;
		players[slot].wy           = py;
		players[slot].rotation     = prot;
		if (players[slot].active == 2) players[slot].visualRotation = prot;
		players[slot].stocks       = pstocks;
		players[slot].respawning   = (bool)prespawning;
		players[slot].crouching    = (bool)pcrouching;
		players[slot].voltage      = pvoltage;
		players[slot].voltageMaxed = (bool)pvoltageMaxed;
		players[slot].blocking     = (bool)pblocking;

		/* Prioridad: hurt > jump > animación normal */
		if (phitId != players[slot].hitId) {
			players[slot].hitId = phitId;
			if (players[slot].character) {
				int ai = AnimIndex("hurt");
				LoadAnimWithOffset(&players[slot], ANIM_JSON[ai], ANIM_META[ai]);
				SetCharacterAutoPlay(players[slot].character, true);
				players[slot].animIndex = ai;
				strcpy_safe(players[slot].animation, "hurt", sizeof(players[slot].animation));
			}
		} else if (pjumpId != players[slot].jumpId) {
			players[slot].jumpId = pjumpId;
			if (players[slot].character) {
				int ai = AnimIndex("jump");
				LoadAnimWithOffset(&players[slot], ANIM_JSON[ai], ANIM_META[ai]);
				SetCharacterAutoPlay(players[slot].character, true);
				players[slot].animIndex = ai;
				strcpy_safe(players[slot].animation, "jump", sizeof(players[slot].animation));
			}
		} else if (strncmp(players[slot].animation, panim, sizeof(players[slot].animation)) != 0) {
			int ai = AnimIndex(panim);
			if (ai != players[slot].animIndex && players[slot].character) {
				LoadAnimWithOffset(&players[slot], ANIM_JSON[ai], ANIM_META[ai]);
				SetCharacterAutoPlay(players[slot].character, true);
				players[slot].animIndex = ai;
			}
			/* Hit-flash cuando comienza un nuevo ataque */
			if (strncmp(panim, "attack", 6) == 0 &&
					strncmp(players[slot].animation, "attack", 6) != 0) {
				players[slot].attackFlashTimer  = 0.3f;
				players[slot].attackFlashFacing = (prot > 1.0f) ? -1.0f : 1.0f;
			}
			strcpy_safe(players[slot].animation, panim, sizeof(players[slot].animation));
		}
	}

	/* Eliminar jugadores que ya no están en la snapshot del servidor */
	for (int s = 0; s < MAX_PLAYERS; s++) {
		if (!players[s].active || seen[s]) continue;

		/* Expulsar de la cola pendiente primero */
		for (int q = 0; q < pending_count; q++) {
			if (pending_ids[q] != players[s].id) continue;
			memmove(pending_ids + q, pending_ids + q + 1,
					(size_t)(pending_count - q - 1) * sizeof(int));
			pending_count--;
			break;
		}

		if (players[s].active == 1) FreePlayer(&players[s]);
		else { players[s].active = 0; players[s].id = -1; }
	}
}

// ─────────────────────────────────────────────────────────────────────────────
//  HUD HELPERS
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Linearly interpolates between two colours (component-wise, u in [0, 1]).
 */
static Color LerpColor(Color a, Color b, float u) {
	return (Color){
		(unsigned char)(a.r + (b.r - a.r) * u),
			(unsigned char)(a.g + (b.g - a.g) * u),
			(unsigned char)(a.b + (b.b - a.b) * u),
			(unsigned char)(a.a + (b.a - a.a) * u),
	};
}

/* Voltage bar colour stops */
static const Color VOLTAGE_COL_BLUE   = { 20,  80, 255, 230 };
static const Color VOLTAGE_COL_YELLOW = {255, 220,   0, 230 };
static const Color VOLTAGE_COL_RED    = {255,   0,   0, 230 };

/**
 * Returns the voltage-bar fill colour for the given normalised voltage [0, 1].
 * Blue (0%) → Yellow (50%) → Red (100%).
 */
static Color VoltageBarColor(float t) {
	if (t <= 0.5f) return LerpColor(VOLTAGE_COL_BLUE,   VOLTAGE_COL_YELLOW, t * 2.0f);
	else           return LerpColor(VOLTAGE_COL_YELLOW, VOLTAGE_COL_RED,    (t - 0.5f) * 2.0f);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SPECTATOR CAMERA HELPER
//  FIX: when no local player exists, compute centroid of all active players
//  and use that as the camera target so the view is never blank.
// ─────────────────────────────────────────────────────────────────────────────
static float SpectatorCamX(float currentCamX, float dt) {
	float sumX = 0.0f;
	int   n    = 0;
	for (int s = 0; s < MAX_PLAYERS; s++) {
		if (players[s].active == 1 && !players[s].respawning) {
			sumX += players[s].wx;
			n++;
		}
	}
	/* If nobody is in the game yet, stay centered. */
	float targetX = (n > 0) ? (sumX / (float)n) : 0.0f;

	/* Smooth follow — slightly slower than player cam for a broadcast feel. */
	float newX = currentCamX + (targetX - currentCamX) * 0.05f;

	const float CAM_HALF_W = 5.0f;
	if (newX - CAM_HALF_W < STAGE_LEFT)  newX = STAGE_LEFT  + CAM_HALF_W;
	if (newX + CAM_HALF_W > STAGE_RIGHT) newX = STAGE_RIGHT - CAM_HALF_W;
	return newX;
}

// ─────────────────────────────────────────────────────────────────────────────
//  DRAW
// ─────────────────────────────────────────────────────────────────────────────
static void DrawGame(void) {
	static float camX      = 0.0f;
	static float blinkTimer = 0.0f;
	static bool  blinkOn    = true;

	const float dt = GetFrameTime();

	/* ── Camera ── */
	if (is_spectator) {
		/* FIX: spectator camera follows centroid of all players */
		camX = SpectatorCamX(camX, dt);
	} else {
		/* Player camera: smooth follow of local player, clamped to stage. */
		for (int s = 0; s < MAX_PLAYERS; s++) {
			if (!players[s].active || players[s].id != my_id) continue;
			camX += (players[s].wx - camX) * 0.08f;
			break;
		}
		const float CAM_HALF_W = 5.0f;
		if (camX - CAM_HALF_W < STAGE_LEFT)  camX = STAGE_LEFT  + CAM_HALF_W;
		if (camX + CAM_HALF_W > STAGE_RIGHT) camX = STAGE_RIGHT - CAM_HALF_W;
	}

	scene_cam.position = (Vector3){ camX, 1.2f, 9.0f };
	scene_cam.target   = (Vector3){ camX, 1.2f, 0.0f };
	scene_cam.up       = (Vector3){ 0.0f, 1.0f, 0.0f };

	/* ── Background ── */
	BeginDrawing();
	ClearBackground((Color){ 10, 10, 28, 255 });

	/* ── Stage geometry ── */
	BeginMode3D(scene_cam);
	{
		const float stageW = STAGE_RIGHT - STAGE_LEFT;
		DrawCube     ((Vector3){ 0.0f, STAGE_Y, 0.0f }, stageW, PLATFORM_H, 0.6f, (Color){ 60,  60,  90, 255 });
		DrawCubeWires((Vector3){ 0.0f, STAGE_Y, 0.0f }, stageW, PLATFORM_H, 0.6f, (Color){100, 100, 160, 200 });

		const float platW = 2.4f, platH = 0.1f;
		DrawCube((Vector3){-4.0f, 1.6f, 0.0f}, platW, platH, 0.5f, (Color){ 50, 70, 110, 255 });
		DrawCube((Vector3){ 4.0f, 1.6f, 0.0f}, platW, platH, 0.5f, (Color){ 50, 70, 110, 255 });
		DrawCube((Vector3){ 0.0f, 2.8f, 0.0f}, platW, platH, 0.5f, (Color){ 50, 70, 110, 255 });
	}
	EndMode3D();

	/* ── Characters ── */
	const float TURN_SPEED = 12.0f;

	for (int s = 0; s < MAX_PLAYERS; s++) {
		Player *p = &players[s];
		if (p->active != 1 || !p->character || p->respawning) continue;
		/* Never render a ghost of our own clientId when we are a spectator. */
		if (is_spectator && my_id > 0 && p->id == my_id) continue;

		/* Guard against stale frame index. */
		if (p->character->currentFrame < 0 ||
				p->character->currentFrame >= p->character->animation.frameCount) {
			p->character->currentFrame = 0;
			p->character->forceUpdate  = true;
		}

		UpdateAnimatedCharacter(p->character, dt);

		/* Handle end-of-clip: freeze on last frame (crouch/jump/victory) or return to idle. */
		if (p->character->animController && !p->character->animController->playing) {
			/* Ganador en victoria: congelar para siempre en el último frame */
			if (match_over && p->id == winner_id) {
				int last = p->character->animation.frameCount - 1;
				if (last < 0) last = 0;
				p->character->currentFrame = last;
				p->character->forceUpdate  = true;
				SetCharacterAutoPlay(p->character, false);
			} else if (p->animIndex == AnimIndex("crouch") || p->animIndex == AnimIndex("jump")) {
				int last = p->character->animation.frameCount - 1;
				if (last < 0) last = 0;
				p->character->currentFrame = last;
				p->character->forceUpdate  = true;
				SetCharacterAutoPlay(p->character, false);
			} else if (p->animIndex != AnimIndex("idle")) {
				strcpy_safe(p->animation, "idle", sizeof(p->animation));
				p->animIndex = AnimIndex("idle");
				LoadAnimWithOffset(p, ANIM_JSON[0], ANIM_META[0]);
				SetCharacterAutoPlay(p->character, true);
			}
		}

		if (p->character->autoCenterCalculated) {
			p->character->autoCenter.x = 0.0f;
			p->character->autoCenter.z = 0.0f;
		}

		/* Smooth rotation. */
		{
			float target = p->rotation;
			float cur    = p->visualRotation;
			float diff   = target - cur;
			while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
			while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;
			float step = TURN_SPEED * dt;
			p->visualRotation = (fabsf(diff) <= step) ? target : cur + (diff > 0 ? step : -step);
		}

		float    visualY  = p->wy - (p->hasAnchorY ? p->anchorYOffset : 0.0f);
		Vector3  worldPos = { p->wx, visualY, 0.0f };
		float    drawRot  = p->visualRotation + (float)M_PI_2;

		DrawAnimatedCharacterTransformed(p->character, scene_cam, worldPos, drawRot);
	}

	/* ── Debug overlay (toggle with U) ── */
	if (IsKeyPressed(KEY_U)) debug_mode = !debug_mode;
	if (debug_mode) {
		BeginMode3D(scene_cam);

		/* Stage bounds */
		DrawCubeWires((Vector3){ 0.0f,  0.0f, 0.0f }, 16.0f, 0.05f, 0.1f, (Color){  0, 200, 255, 160 });
		DrawCubeWires((Vector3){-4.0f,  1.6f, 0.0f },  2.4f, 0.05f, 0.1f, (Color){  0, 200, 255, 160 });
		DrawCubeWires((Vector3){ 4.0f,  1.6f, 0.0f },  2.4f, 0.05f, 0.1f, (Color){  0, 200, 255, 160 });
		DrawCubeWires((Vector3){ 0.0f,  2.8f, 0.0f },  2.4f, 0.05f, 0.1f, (Color){  0, 200, 255, 160 });
		DrawLine3D((Vector3){-8.0f, -6.0f, 0}, (Vector3){-8.0f, 4.0f, 0}, (Color){255,  60,  60, 180 });
		DrawLine3D((Vector3){ 8.0f, -6.0f, 0}, (Vector3){ 8.0f, 4.0f, 0}, (Color){255,  60,  60, 180 });
		DrawLine3D((Vector3){-10.f, -6.0f, 0}, (Vector3){10.0f,-6.0f, 0}, (Color){255,  60,  60, 180 });

		for (int s = 0; s < MAX_PLAYERS; s++) {
			Player *p = &players[s];
			if (p->active != 1 || p->respawning) continue;
			if (is_spectator && my_id > 0 && p->id == my_id) continue; /* no ghost hitbox */

			Vector3 wp = { p->wx, p->wy, 0.0f };
			Color   cc = (p->id == my_id) ? (Color){ 0, 255, 100, 220 }
			: (Color){255,  80,  80, 220 };

			DrawCubeWires((Vector3){ wp.x, wp.y + 0.36f, 0.0f }, 0.48f, 0.72f, 0.05f, cc);
			DrawSphere(wp, 0.06f, cc);

			if (p->attackFlashTimer > 0.0f) {
				p->attackFlashTimer -= dt;
				if (p->attackFlashTimer > 0.0f) {
					DrawCubeWires(
							(Vector3){ wp.x + p->attackFlashFacing * (ATTACK_RANGE * 0.5f), wp.y + 0.5f, 0.0f },
							ATTACK_RANGE, ATTACK_RANGE_Y, 0.05f,
							(Color){ 255, 255, 0, 220 }
							);
				}
			}
		}
		EndMode3D();
	}

	/* ── HUD ── */
	blinkTimer += dt;
	if (blinkTimer > 0.18f) { blinkTimer = 0.0f; blinkOn = !blinkOn; }

	const int BAR_W  = 120;
	const int BAR_H  = 8;
	int       hudY   = 8;

	for (int s = 0; s < MAX_PLAYERS; s++) {
		Player *p = &players[s];
		if (!p->active) continue;

		const bool isMe    = (!is_spectator && p->id == my_id);
		const Color nameCol = isMe ? YELLOW : WHITE;

		/* Stocks label */
		char hud[48];
		snprintf(hud, sizeof(hud), "P%d: %d stocks", p->id, p->stocks);
		DrawText(hud, 8, hudY, 12, nameCol);
		hudY += 14;

		/* Voltage bar background */
		DrawRectangle(8, hudY, BAR_W, BAR_H, (Color){ 30, 30, 50, 200 });

		/* Voltage fill */
		float t = p->voltage / 200.0f;
		Color fillCol;
		if (p->voltageMaxed) {
			fillCol = blinkOn ? (Color){ 255, 30, 30, 255 } : (Color){ 255, 160, 0, 255 };
		} else {
			fillCol = VoltageBarColor(t);
		}
		int fillW = (int)(BAR_W * t);
		if (fillW > 0) DrawRectangle(8, hudY, fillW, BAR_H, fillCol);

		/* Critical border */
		if (p->voltageMaxed && blinkOn)
			DrawRectangleLines(8, hudY, BAR_W, BAR_H, (Color){ 255, 80, 80, 255 });

		/* Voltage % label */
		char vLabel[12];
		snprintf(vLabel, sizeof(vLabel), "%.0f%%", p->voltage);
		Color vLabelCol = (p->voltageMaxed && blinkOn) ? (Color){ 255, 80, 80, 255 } : nameCol;
		DrawText(vLabel, 8 + BAR_W + 4, hudY, 10, vLabelCol);

		/* Block indicator */
		if (p->blocking)
			DrawText("[BLK]", 8 + BAR_W + 38, hudY, 10, (Color){ 80, 200, 255, 255 });

		hudY += BAR_H + 6;
	}

	/* FIX: Corner label — shows "SPECTATOR" badge, player ID, or connecting state */
	if (is_spectator) {
		DrawText("SPECTATOR", SCREEN_W - 90, 8, 12, (Color){ 80, 200, 255, 255 });
	} else if (my_id > 0) {
		char txt[24];
		snprintf(txt, sizeof(txt), "Player %d", my_id);
		DrawText(txt, SCREEN_W - 80, 8, 12, YELLOW);
	} else if (no_id_frames > 60) {
		/* Ha pasado más de 1 segundo sin ID ni confirmación de espectador —
		   mostrar estado de espera en lugar de nada */
		DrawText("Connecting...", SCREEN_W - 100, 8, 12, (Color){ 220, 140, 40, 255 });
		/* Si hay datos en gameState pero aún no tenemos rol, mostrar hint */
		if (ws_player_count() > 0) {
			DrawText("Waiting for server...", SCREEN_W / 2 - 80, SCREEN_H / 2, 16,
					(Color){ 200, 200, 200, 180 });
		}
	} else {
		DrawText("Connecting...", SCREEN_W - 100, 8, 12, (Color){ 220, 140, 40, 255 });
	}

	/* ── Overlay de VICTORIA ── */
	if (match_over && winner_message[0] != '\0') {
		const bool iWon = (!is_spectator && my_id == winner_id);

		/* Fondo completo oscuro semitransparente */
		DrawRectangle(0, 0, SCREEN_W, SCREEN_H, (Color){ 0, 0, 0, 180 });

		/* Caja central grande */
		const int BOX_W = 420;
		const int BOX_H = iWon ? 160 : 130;
		const int BOX_X = (SCREEN_W - BOX_W) / 2;
		const int BOX_Y = (SCREEN_H - BOX_H) / 2;

		Color borderCol = iWon
			? (Color){ 255, 215,   0, 255 }   /* dorado para el ganador */
			: (Color){  80, 200, 255, 255 };   /* azul para los demás   */
		Color bgCol     = iWon
			? (Color){  40,  30,   0, 240 }
			: (Color){  20,  20,  40, 240 };

		DrawRectangle    (BOX_X, BOX_Y, BOX_W, BOX_H, bgCol);
		DrawRectangleLines(BOX_X, BOX_Y, BOX_W, BOX_H, borderCol);
		/* Segundo borde interior para efecto de brillo */
		DrawRectangleLines(BOX_X+2, BOX_Y+2, BOX_W-4, BOX_H-4,
		                   (Color){ borderCol.r, borderCol.g, borderCol.b, 120 });

		if (iWon) {
			/* ── GANADOR ── */
			const char *line1 = "*** VICTORY ***";
			int l1w = MeasureText(line1, 36);
			DrawText(line1, BOX_X + (BOX_W - l1w) / 2, BOX_Y + 16, 36,
			         (Color){ 255, 215, 0, 255 });

			const char *line2 = "¡Eres el último en pie!";
			int l2w = MeasureText(line2, 18);
			DrawText(line2, BOX_X + (BOX_W - l2w) / 2, BOX_Y + 64, 18, WHITE);

			/* Parpadeo en el mensaje de reload */
			static float blinkV = 0.0f;
			blinkV += GetFrameTime() * 3.0f;
			unsigned char alpha = (unsigned char)(180 + 75 * sinf(blinkV));
			const char *line3 = "Recarga la página para volver a jugar";
			int l3w = MeasureText(line3, 14);
			DrawText(line3, BOX_X + (BOX_W - l3w) / 2, BOX_Y + 100, 14,
			         (Color){ 255, 215, 0, alpha });

			const char *line4 = "(F5 / Ctrl+R)";
			int l4w = MeasureText(line4, 12);
			DrawText(line4, BOX_X + (BOX_W - l4w) / 2, BOX_Y + 120, 12,
			         (Color){ 200, 180, 80, 180 });

		} else {
			/* ── PERDEDOR / ESPECTADOR ── */
			const char *line1 = is_spectator ? "FIN DE LA PARTIDA" : "DERROTA";
			int fsize1 = is_spectator ? 26 : 34;
			int l1w = MeasureText(line1, fsize1);
			DrawText(line1, BOX_X + (BOX_W - l1w) / 2, BOX_Y + 16, fsize1,
			         (Color){ 80, 200, 255, 255 });

			/* Mostrar quién ganó */
			char wline[48];
			snprintf(wline, sizeof(wline), "Ganador: Player %d", winner_id);
			int wlw = MeasureText(wline, 18);
			DrawText(wline, BOX_X + (BOX_W - wlw) / 2, BOX_Y + 62, 18, YELLOW);

			const char *line3 = "Recarga para jugar la próxima partida";
			int l3w = MeasureText(line3, 13);
			DrawText(line3, BOX_X + (BOX_W - l3w) / 2, BOX_Y + 96, 13,
			         (Color){ 160, 160, 160, 200 });
		}
	}

	/* ── Overlay READY / FIGHT ── */
	if (!match_over) {
		int   cd_phase   = ws_get_countdown();
		float cd_elapsed = ws_get_countdown_elapsed();

		if (cd_phase == 1 || cd_phase == 2) {
			float phase_t = (cd_phase == 1)
				? (cd_elapsed / 1.2f)
				: ((cd_elapsed - 1.2f) / 1.0f);
			if (phase_t > 1.0f) phase_t = 1.0f;

			const char *word = (cd_phase == 1) ? "READY?" : "FIGHT!";

			/* Escala: entra grande y se encoge */
			float scale = 1.0f + 0.6f * (1.0f - phase_t);

			/* Fade: aparece de golpe, desaparece al final */
			float fade = (phase_t > 0.7f) ? (1.0f - (phase_t - 0.7f) / 0.3f) : 1.0f;
			if (fade < 0.0f) fade = 0.0f;
			unsigned char alpha = (unsigned char)(255.0f * fade);

			int size = (int)(64.0f * scale);
			int tw   = MeasureText(word, size);
			int tx   = (SCREEN_W - tw) / 2;
			int ty   = SCREEN_H / 2 - size / 2 - 30;

			/* Sombra */
			DrawText(word, tx + 4, ty + 4, size,
			         (Color){ 0, 0, 0, (unsigned char)(alpha / 2) });

			Color wordCol = (cd_phase == 1)
				? (Color){ 255, 240, 80,  alpha }
				: (Color){ 255,  60, 30,  alpha };
			DrawText(word, tx, ty, size, wordCol);
		}
	}

	EndDrawing();
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN LOOP  (called by Emscripten each browser frame)
// ─────────────────────────────────────────────────────────────────────────────
static void MainLoop(void) {
	if (!game_ready) return;

	/* Leer estado de espectador desde JS cada frame */
	is_spectator = (bool)ws_is_spectator();

	if (is_spectator) {
		/* Espectador confirmado por JS — my_id no tiene sentido aquí */
		my_id      = -1;
		no_id_frames = 0;
	} else if (my_id > 0) {
		/* Ya tenemos ID de jugador — nada que hacer */
		no_id_frames = 0;
	} else {
		/* Todavía sin ID — intentar obtenerlo */
		my_id = ws_get_my_id();
		if (my_id > 0) {
			ATTACK_RANGE   = ws_get_attack_range();
			ATTACK_RANGE_Y = ws_get_attack_range_y();
			no_id_frames   = 0;
		} else {
			/* Sin ID y sin confirmación de espectador todavía.
			   Si llevamos demasiados frames así Y hay jugadores en la snapshot,
			   es porque somos espectador pero el mensaje WS llegó tarde.
			   Forzar modo espectador para que el render arranque. */
			no_id_frames++;
			if (no_id_frames >= NO_ID_SPECTATOR_FRAMES && ws_player_count() > 0) {
				is_spectator = true;
				my_id        = -1;
			}
		}
	}

	/* Responder a cambio de tamaño del canvas */
	int newW = js_canvas_width();
	int newH = js_canvas_height();
	if (newW != SCREEN_W || newH != SCREEN_H) {
		SCREEN_W = newW;
		SCREEN_H = newH;
		SetWindowSize(SCREEN_W, SCREEN_H);
	}

	FetchState();
	FlushOnePlayerInit();

	/* ── Comprobar victoria (mensaje 'victory' del servidor) ── */
	if (!match_over) {
		int vstate = ws_get_victory_state();
		if (vstate != 0) {
			int wid = ws_get_victory_winner();
			match_over = true;
			winner_id  = wid;

			if (vstate == 1)
				snprintf(winner_message, sizeof(winner_message), "VICTORY");
			else
				snprintf(winner_message, sizeof(winner_message), "DERROTA");

			ws_consume_victory();

			/* Cargar animación 'victory' en el ganador y congelar en último frame */
			int vi = AnimIndex("victory");
			for (int s = 0; s < MAX_PLAYERS; s++) {
				if (!players[s].active || players[s].id != winner_id) continue;
				if (players[s].character) {
					bool loaded = LoadAnimWithOffset(&players[s],
					                                ANIM_JSON[vi], ANIM_META[vi]);
					if (!loaded) {
						vi = AnimIndex("idle");
						LoadAnimWithOffset(&players[s], ANIM_JSON[0], ANIM_META[0]);
					}
					SetCharacterAutoPlay(players[s].character, false);
					int last = players[s].character->animation.frameCount - 1;
					if (last < 0) last = 0;
					players[s].character->currentFrame = last;
					players[s].character->forceUpdate  = true;
				}
				players[s].animIndex = vi;
				strcpy_safe(players[s].animation, ANIM_NAME[vi],
				            sizeof(players[s].animation));
				break;
			}
		}
	}

	DrawGame();
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
int main(void) {
	memset(players, 0, sizeof(players));

	SetTraceLogLevel(LOG_NONE);
	InitWindow(SCREEN_W, SCREEN_H, "Voltage Fighter");
	SetTargetFPS(60);

	scene_cam = (Camera){
		.position   = { 0.0f, 1.2f,  9.0f },
			.target     = { 0.0f, 1.2f,  0.0f },
			.up         = { 0.0f, 1.0f,  0.0f },
			.fovy       = 50.0f,
			.projection = CAMERA_PERSPECTIVE,
	};

	game_ready = true;
	emscripten_set_main_loop(MainLoop, 0, 1);

	/* Cleanup (unreachable in browser, but correct for native builds). */
	for (int i = 0; i < MAX_PLAYERS; i++)
		if (players[i].active) FreePlayer(&players[i]);
	CloseWindow();
	return 0;
}