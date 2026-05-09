#include "raylib.h"
#include "raymath.h"
#include "bones_core.h"

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_PLAYERS  8
#define ANIM_COUNT   15

#define STAGE_LEFT   -8.0f
#define STAGE_RIGHT   8.0f
#define STAGE_Y      -0.05f
#define PLATFORM_H    0.12f

static float ATTACK_RANGE   = 0.525f;
static float ATTACK_RANGE_Y = 0.5f;

static int    SCREEN_W   = 800;
static int    SCREEN_H   = 600;
static Camera scene_cam;

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
	"data/animations/crouch.json",  // crouch_loop
	"data/animations/hurt.json",
	"data/animations/block.json",
	"data/animations/attack_dash.json",
	"data/animations/victory.json",
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
	"data/animations/crouch.anim",  // crouch_loop
	"data/animations/hurt.anim",
	"data/animations/block.anim",
	"data/animations/attack_dash.anim",
	"data/animations/victory.anim",
};

static const char *ANIM_NAME[ANIM_COUNT] = {
	"idle", "walk", "jump",
	"attack_air", "attack_combo_1", "attack_combo_2", "attack_combo_3",
	"attack_crouch", "dash", "crouch", "crouch_loop",
	"hurt", "block", "attack_dash",
	"victory",
};

typedef struct {

	int  id;
	int  active;


	float wx, wy;
	float rotation;
	float visualRotation;


	char animation[24];
	int  animIndex;


	int   stocks;
	bool  respawning;
	bool  crouching;
	int   hitId;
	int   jumpId;
	float voltage;
	bool  voltageMaxed;
	bool  blocking;


	float attackFlashTimer;
	float attackFlashFacing;


	float hitShakeAmt;
	float hitShakeTimer;


	Vector3 referenceCenter;
	bool    hasReferenceCenter;
	float   anchorYOffset;
	bool    hasAnchorY;


	AnimatedCharacter *character;

	char charId[32];
	int  slotIndex;
} Player;

static Player players[MAX_PLAYERS];
static int    my_id            = -1;
static bool   is_spectator     = false;
static bool   game_ready       = false;
static bool   debug_mode       = false;

static int    no_id_frames     = 0;
#define NO_ID_SPECTATOR_FRAMES 180


static bool   match_over          = false;
static bool   victory_pending     = false;   // victory received, playing anim, overlay not yet shown
static int    winner_id           = -1;
static char   winner_message[80]  = {0};


static float  g_camShakeAmt   = 0.0f;
static float  g_camShakeTimer = 0.0f;


#define MAX_PENDING 8
static int pending_ids[MAX_PENDING];
static int pending_count = 0;

static void InitPlayer(Player *p, int id);
static void FreePlayer(Player *p);
static void FetchState(void);
static void DrawGame(void);


int   ws_get_victory_state(void);
int   ws_get_victory_winner(void);
void  ws_consume_victory(void);
int   ws_get_countdown(void);
float ws_get_countdown_elapsed(void);
int   ws_get_hitstop_frames_left(void);
float ws_get_hitstop_shake(void);
int   ws_get_hitstop_target_id(void);

EM_JS(int, js_canvas_width, (void), {
		return (window._canvasWidth > 0) ? (window._canvasWidth | 0) : 800;
		});
EM_JS(int, js_canvas_height, (void), {
		return (window._canvasHeight > 0) ? (window._canvasHeight | 0) : 600;
		});
EM_JS(int, ws_get_my_id, (void), {
		return (window._myClientId > 0) ? (window._myClientId | 0) : -1;
		});


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

EM_JS(int, ws_get_victory_state, (void), {
    if (!window._victoryActive || window._victoryConsumed) return 0;
    return window._victoryIsWinner ? 1 : 2;
});


EM_JS(int, ws_get_victory_winner, (void), {
    if (!window._victoryActive || window._victoryConsumed) return -1;
    return window._victoryWinner | 0;
});

EM_JS(void, ws_consume_victory, (void), {
    window._victoryConsumed = true;
});

EM_JS(int, ws_get_hitstop_frames_left, (void), {
    var hs = window._hitstopState;
    if (!hs || hs.framesLeft <= 0) {
        window._hitstopState = null;
        return 0;
    }
    var f = hs.framesLeft;
    hs.framesLeft--;
    return f;
});

EM_JS(float, ws_get_hitstop_shake, (void), {
    var hs = window._hitstopState;
    if (!hs || !hs.shakeAmt || hs.startFrames <= 0) return 0.0;

    var t = hs.framesLeft / hs.startFrames;
    if (t < 0.0) t = 0.0;
    return hs.shakeAmt * t;
});


EM_JS(int, ws_get_hitstop_target_id, (void), {
    var hs = window._hitstopState;
    if (!hs) return -1;
    return (hs.targetId | 0);
});

EM_JS(int, ws_get_countdown, (void), {
    if (!window._countdownStart || window._countdownDone) return 0;
    var elapsed = (performance.now() - window._countdownStart) / 1000.0;
    if (elapsed < 1.2) return 1;
    if (elapsed < 2.2) return 2;
    window._countdownDone = true;
    return 0;
});


EM_JS(float, ws_get_countdown_elapsed, (void), {
    if (!window._countdownStart || window._countdownDone) return 0.0;
    return (performance.now() - window._countdownStart) / 1000.0;
});

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

// Read charId for a given clientId directly from the live game state.
// This works even for remote players because the server now broadcasts charId
// in every state snapshot, so we don't have to rely on _charSelectData
// (which only contains the local player's own selection).
EM_JS(int, ws_get_player_char_id_by_client, (int playerId, char *buf, int len), {
    buf = buf | 0;
    if (!window._gameState || !window._gameState.players) {
        stringToUTF8("", buf, len); return 0;
    }
    var p = window._gameState.players[playerId];
    if (!p || !p.charId) { stringToUTF8("", buf, len); return 0; }
    stringToUTF8(p.charId, buf, len);
    return 1;
});

typedef struct { const char *charId, *name, *texCfg, *texSets, *animBase, *portrait; } CharDef;

static const CharDef CHARS[4] = {
    { "eld", "Eldwin",  "data/textures/eld/bone_textures.txt", "data/textures/eld/texture_sets.txt", "data/animations/eld/", "data/eldwin_portrait.jpg"  },
    { "hil", "Hilda",   "data/textures/hil/bone_textures.txt", "data/textures/hil/texture_sets.txt", "data/animations/hil/", "data/hilda_portrait.jpg"   },
    { "qui", "Quimbur", "data/textures/qui/bone_textures.txt", "data/textures/qui/texture_sets.txt", "data/animations/qui/", "data/quimbur_portrait.jpg" },
    { "gab", "Gabriel", "data/textures/gab/bone_textures.txt", "data/textures/gab/texture_sets.txt", "data/animations/gab/", "data/gabriel_portrait.jpg" },
};
#define CHARS_COUNT 4


typedef enum { CSS_SELECTING, CSS_WAITING_ACK, CSS_WAITING_GAME, CSS_DONE } CssPhase;

static struct {
    CssPhase  phase;
    int       hovered;
    int       selected;
    Texture2D portraits[CHARS_COUNT];
    bool      portraitsLoaded;
    float     confirmTimer;
    char      savedCharId[32];
} g_css = { CSS_SELECTING, 0, -1, {0}, false, 0.0f, "" };


EM_JS(int, ws_char_select_ready, (void), {
    return (window._charSelectData && window._charSelectData.charId) ? 1 : 0;
});


EM_JS(int, ws_get_slot_char_id, (int slotIdx, char *buf, int len), {
    buf = buf | 0;
    if (!window._charSelectData || !window._charSelectData.players) { stringToUTF8("", buf, len); return 0; }
    var p = window._charSelectData.players[slotIdx];
    if (!p || !p.charId) { stringToUTF8("", buf, len); return 0; }
    stringToUTF8(p.charId, buf, len);
    return 1;
});


EM_JS(void, ws_send_char_select, (const char *charId, int charIdx, int stageId), {
    var id = UTF8ToString(charId);
    try { sessionStorage.setItem('pendingCharSelect', JSON.stringify({charId:id,charIdx:charIdx,stageId:stageId})); } catch(e){}
    if (typeof window.sendCharSelect === 'function') window.sendCharSelect(id, charIdx, stageId);
});


EM_JS(int, ws_match_started, (void), {
    return (window._countdownStart != null || window._countdownDone === true) ? 1 : 0;
});


EM_JS(int, ws_get_saved_char_id, (char *buf, int len), {
    buf = buf | 0;
    try {
        var raw = sessionStorage.getItem('charSelectData');
        if (!raw) { stringToUTF8("", buf, len); return 0; }
        var d = JSON.parse(raw);
        if (!d || !d.charId) { stringToUTF8("", buf, len); return 0; }

        window._charSelectData = d;
        stringToUTF8(d.charId, buf, len);
        return 1;
    } catch(e) { stringToUTF8("", buf, len); return 0; }
});

EM_JS(void, ws_clear_char_select, (void), {
    window._charSelectData = null;
    try { sessionStorage.removeItem('pendingCharSelect'); sessionStorage.removeItem('charSelectData'); } catch(e){}
});


static void strcpy_safe(char *dst, const char *src, size_t n) {
	strncpy(dst, src, n - 1);
	dst[n - 1] = '\0';
}


static int AnimIndex(const char *name) {
	for (int i = 0; i < ANIM_COUNT; i++)
		if (strcmp(name, ANIM_NAME[i]) == 0) return i;
	return 0;
}


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


static int FindBoneByName(const Person *person, const char *name) {
	if (!person || !name) return -1;
	for (int b = 0; b < person->boneCount; b++)
		if (strcmp(person->bones[b].name, name) == 0) return b;
	return -1;
}


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


static bool CalcAnkleMidPoint(const AnimationFrame *frame, Vector3 *outPos) {
	if (!frame || !outPos || !frame->valid) return false;
	Vector3 left = {0}, right = {0};
	bool hasL = GetBonePosition(frame, "LAnkle", &left);
	bool hasR = GetBonePosition(frame, "RAnkle", &right);
	if (!hasL || !hasR) return false;
	*outPos = Vector3Scale(Vector3Add(left, right), 0.5f);
	return true;
}


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

static void StabilizeAnimX(BonesAnimation *anim) {
	if (!anim || !anim->isLoaded || anim->frameCount < 2) return;


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

		Vector3 xzOffset = { -thisCenter.x, 0.0f, -thisCenter.z };
		if (fabsf(xzOffset.x) > 0.001f || fabsf(xzOffset.z) > 0.001f)
			ApplyOffsetToAnim(anim, xzOffset);


		hasCtr = CalcAnkleMidPoint(&anim->frames[0], &thisCenter);
		if (!hasCtr) thisCenter = CalcAnimCenter(&anim->frames[0]);

		p->referenceCenter    = thisCenter;
		p->hasReferenceCenter = true;
		p->anchorYOffset      = thisCenter.y;
		p->hasAnchorY         = true;
	} else {

		Vector3 delta = Vector3Subtract(p->referenceCenter, thisCenter);
		if (Vector3Length(delta) > 0.001f)
			ApplyOffsetToAnim(anim, delta);
	}

	p->character->forceUpdate = true;
	return true;
}

static void QueuePlayerInit(int id) {
	for (int i = 0; i < pending_count; i++)
		if (pending_ids[i] == id) return;
	if (pending_count < MAX_PENDING)
		pending_ids[pending_count++] = id;
}


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

static const CharDef *FindCharDef(const char *id) {
    if (!id || !id[0]) return NULL;
    for (int i = 0; i < CHARS_COUNT; i++)
        if (strcmp(id, CHARS[i].charId) == 0) return &CHARS[i];
    return NULL;
}

static void LoadPlayerAnim(Player *p, int animIdx) {
    const CharDef *cd = FindCharDef(p->charId);
    const char *base  = (cd && cd->animBase[0]) ? cd->animBase : NULL;
    const char *origJson = ANIM_JSON[animIdx];
    const char *origMeta = ANIM_META[animIdx];
    if (base) {
        const char *jf = strrchr(origJson, '/'); jf = jf ? jf+1 : origJson;
        const char *mf = strrchr(origMeta, '/'); mf = mf ? mf+1 : origMeta;
        static char aj[256], am[256];
        snprintf(aj, sizeof(aj), "%s%s", base, jf);
        snprintf(am, sizeof(am), "%s%s", base, mf);
        if (FileExists(aj) && FileExists(am)) { LoadAnimWithOffset(p, aj, am); return; }
    }
    LoadAnimWithOffset(p, origJson, origMeta);
}

static void InitPlayer(Player *p, int id) {

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
	strncpy(p->charId, prev.charId, sizeof(p->charId)-1);
	p->slotIndex = prev.slotIndex;


	if (!p->charId[0]) {
		char cid[32] = {0};
		// Try state snapshot first (has charId for all players, not just local)
		if (ws_get_player_char_id_by_client(p->id, cid, sizeof(cid)) && cid[0])
			strncpy(p->charId, cid, sizeof(p->charId)-1);
		else if (ws_get_slot_char_id(p->slotIndex, cid, sizeof(cid)) && cid[0])
			strncpy(p->charId, cid, sizeof(p->charId)-1);
	}

	const CharDef *cd   = FindCharDef(p->charId);
	const char *texCfg  = cd ? cd->texCfg  : "data/textures/eld/bone_textures.txt";
	const char *texSets = cd ? cd->texSets : "data/textures/eld/texture_sets.txt";

	p->character = CreateAnimatedCharacter(texCfg, texSets);

	if (p->character) {
		LockAnimationRootXZ(p->character, true);
		SetCharacterBillboards(p->character, true, true);
		SetCharacterAutoPlay(p->character, true);
		LoadPlayerAnim(p, p->animIndex);
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

static void FetchState(void) {


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


		if (is_spectator && my_id > 0 && pid == my_id) continue;


		int slot = -1;
		for (int s = 0; s < MAX_PLAYERS; s++)
			if (players[s].active && players[s].id == pid) { slot = s; break; }
		if (slot < 0)
			for (int s = 0; s < MAX_PLAYERS; s++)
				if (!players[s].active) { slot = s; break; }
		if (slot < 0) continue;


		if (!players[slot].active) {
			players[slot].id        = pid;
			players[slot].active    = 2;
			players[slot].slotIndex = slot;
			{
				char _cid[32] = {0};
				// Priority 1: read charId from the server state snapshot (works for all players)
				if (ws_get_player_char_id_by_client(pid, _cid, sizeof(_cid)) && _cid[0]) {
					strncpy(players[slot].charId, _cid, sizeof(players[slot].charId)-1);
				// Priority 2: fallback to char_select_ack data (only reliable for local player)
				} else if (ws_get_slot_char_id(slot, _cid, sizeof(_cid)) && _cid[0]) {
					strncpy(players[slot].charId, _cid, sizeof(players[slot].charId)-1);
				}
			}
			players[slot].animIndex = AnimIndex(panim);
			strcpy_safe(players[slot].animation, panim, sizeof(players[slot].animation));
			QueuePlayerInit(pid);
		}

		seen[slot] = 1;


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


		if (phitId != players[slot].hitId) {
			players[slot].hitId = phitId;
			if (players[slot].character) {
				int ai = AnimIndex("hurt");
				LoadPlayerAnim(&players[slot], ai);
				SetCharacterAutoPlay(players[slot].character, true);
				players[slot].animIndex = ai;
				strcpy_safe(players[slot].animation, "hurt", sizeof(players[slot].animation));
			}
		} else if (pjumpId != players[slot].jumpId) {
			players[slot].jumpId = pjumpId;
			if (players[slot].character) {
				int ai = AnimIndex("jump");
				LoadPlayerAnim(&players[slot], ai);
				SetCharacterAutoPlay(players[slot].character, true);
				players[slot].animIndex = ai;
				strcpy_safe(players[slot].animation, "jump", sizeof(players[slot].animation));
			}
		} else if (strncmp(players[slot].animation, panim, sizeof(players[slot].animation)) != 0) {
			int ai = AnimIndex(panim);
			if (ai != players[slot].animIndex && players[slot].character) {
				LoadPlayerAnim(&players[slot], ai);
				SetCharacterAutoPlay(players[slot].character, true);
				players[slot].animIndex = ai;
			}

			if (strncmp(panim, "attack", 6) == 0 &&
					strncmp(players[slot].animation, "attack", 6) != 0) {
				players[slot].attackFlashTimer  = 0.3f;
				players[slot].attackFlashFacing = (prot > 1.0f) ? -1.0f : 1.0f;
			}
			strcpy_safe(players[slot].animation, panim, sizeof(players[slot].animation));
		}
	}


	for (int s = 0; s < MAX_PLAYERS; s++) {
		if (!players[s].active || seen[s]) continue;


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


static Color LerpColor(Color a, Color b, float u) {
	return (Color){
		(unsigned char)(a.r + (b.r - a.r) * u),
			(unsigned char)(a.g + (b.g - a.g) * u),
			(unsigned char)(a.b + (b.b - a.b) * u),
			(unsigned char)(a.a + (b.a - a.a) * u),
	};
}


static const Color VOLTAGE_COL_BLUE   = { 20,  80, 255, 230 };
static const Color VOLTAGE_COL_YELLOW = {255, 220,   0, 230 };
static const Color VOLTAGE_COL_RED    = {255,   0,   0, 230 };

static Color VoltageBarColor(float t) {
	if (t <= 0.5f) return LerpColor(VOLTAGE_COL_BLUE,   VOLTAGE_COL_YELLOW, t * 2.0f);
	else           return LerpColor(VOLTAGE_COL_YELLOW, VOLTAGE_COL_RED,    (t - 0.5f) * 2.0f);
}

static float SpectatorCamX(float currentCamX) {
	float sumX = 0.0f;
	int   n    = 0;
	for (int s = 0; s < MAX_PLAYERS; s++) {
		if (players[s].active == 1 && !players[s].respawning) {
			sumX += players[s].wx;
			n++;
		}
	}

	float targetX = (n > 0) ? (sumX / (float)n) : 0.0f;


	float newX = currentCamX + (targetX - currentCamX) * 0.05f;

	const float CAM_HALF_W = 5.0f;
	if (newX - CAM_HALF_W < STAGE_LEFT)  newX = STAGE_LEFT  + CAM_HALF_W;
	if (newX + CAM_HALF_W > STAGE_RIGHT) newX = STAGE_RIGHT - CAM_HALF_W;
	return newX;
}

static void DrawGame(void) {
	static float camX      = 0.0f;
	static float blinkTimer = 0.0f;
	static bool  blinkOn    = true;

	const float dt = GetFrameTime();


	int   hitstopFrames = ws_get_hitstop_frames_left();
	float shakeAmt      = ws_get_hitstop_shake();
	int   targetId      = ws_get_hitstop_target_id();


	float animDt = (hitstopFrames > 0) ? 0.0f : dt;


	if (shakeAmt > 0.0f && shakeAmt > g_camShakeAmt) {
		g_camShakeAmt   = shakeAmt;
		g_camShakeTimer = 0.18f;
	}


	if (shakeAmt > 0.0f && targetId >= 0) {
		for (int s = 0; s < MAX_PLAYERS; s++) {
			if (!players[s].active || players[s].id != targetId) continue;
			if (shakeAmt > players[s].hitShakeAmt) {
				players[s].hitShakeAmt   = shakeAmt * 1.6f;
				players[s].hitShakeTimer = 0.22f;
			}
			break;
		}
	}


	float camShakeOffX = 0.0f, camShakeOffY = 0.0f;
	if (g_camShakeTimer > 0.0f) {
		g_camShakeTimer -= dt;
		if (g_camShakeTimer < 0.0f) {
			g_camShakeTimer = 0.0f;
			g_camShakeAmt   = 0.0f;
		} else {

			float decay = g_camShakeTimer / 0.18f;
			float amp   = g_camShakeAmt * decay * decay;

			float t = (float)GetTime();
			camShakeOffX = amp * sinf(t * 97.3f);
			camShakeOffY = amp * sinf(t * 113.7f + 1.4f) * 0.5f;
		}
	}


	if (is_spectator) {

		camX = SpectatorCamX(camX);
	} else {

		for (int s = 0; s < MAX_PLAYERS; s++) {
			if (!players[s].active || players[s].id != my_id) continue;
			camX += (players[s].wx - camX) * 0.08f;
			break;
		}
		const float CAM_HALF_W = 5.0f;
		if (camX - CAM_HALF_W < STAGE_LEFT)  camX = STAGE_LEFT  + CAM_HALF_W;
		if (camX + CAM_HALF_W > STAGE_RIGHT) camX = STAGE_RIGHT - CAM_HALF_W;
	}

	scene_cam.position = (Vector3){ camX + camShakeOffX, 1.2f + camShakeOffY, 9.0f };
	scene_cam.target   = (Vector3){ camX + camShakeOffX, 1.2f + camShakeOffY, 0.0f };
	scene_cam.up       = (Vector3){ 0.0f, 1.0f, 0.0f };


	BeginDrawing();
	ClearBackground((Color){ 10, 10, 28, 255 });


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


	const float TURN_SPEED = 12.0f;

	for (int s = 0; s < MAX_PLAYERS; s++) {
		Player *p = &players[s];
		if (p->active != 1 || !p->character || p->respawning) continue;

		if (is_spectator && my_id > 0 && p->id == my_id) continue;


		if (p->character->currentFrame < 0 ||
				p->character->currentFrame >= p->character->animation.frameCount) {
			p->character->currentFrame = 0;
			p->character->forceUpdate  = true;
		}

		UpdateAnimatedCharacter(p->character, animDt);


		if (p->character->animController && !p->character->animController->playing) {

			if (victory_pending && p->id == winner_id) {
				// Victory animation just finished — now show the overlay
				match_over      = true;
				victory_pending = false;
				ws_consume_victory();
				int last = p->character->animation.frameCount - 1;
				if (last < 0) last = 0;
				p->character->currentFrame = last;
				p->character->forceUpdate  = true;
				SetCharacterAutoPlay(p->character, false);
			} else if (match_over && p->id == winner_id) {
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
				LoadPlayerAnim(p, 0);
				SetCharacterAutoPlay(p->character, true);
			}
		}

		if (p->character->autoCenterCalculated) {
			p->character->autoCenter.x = 0.0f;
			p->character->autoCenter.z = 0.0f;
		}


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


		float playerShakeX = 0.0f, playerShakeY = 0.0f;
		if (p->hitShakeTimer > 0.0f) {
			p->hitShakeTimer -= dt;
			if (p->hitShakeTimer < 0.0f) {
				p->hitShakeTimer = 0.0f;
				p->hitShakeAmt   = 0.0f;
			} else {
				float decay = p->hitShakeTimer / 0.22f;
				float amp   = p->hitShakeAmt * decay * decay;
				float t     = (float)GetTime();

				playerShakeX = amp * sinf(t * 141.2f + (float)p->id * 2.3f);
				playerShakeY = amp * sinf(t * 127.8f + (float)p->id * 3.7f) * 0.4f;
			}
		}

		Vector3  worldPos = { p->wx + playerShakeX, visualY + playerShakeY, 0.0f };
		float    drawRot  = p->visualRotation + (float)M_PI_2;

		DrawAnimatedCharacterTransformed(p->character, scene_cam, worldPos, drawRot);
	}


	if (IsKeyPressed(KEY_U)) debug_mode = !debug_mode;
	if (debug_mode) {
		BeginMode3D(scene_cam);


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
			if (is_spectator && my_id > 0 && p->id == my_id) continue;

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


		char hud[48];
		snprintf(hud, sizeof(hud), "P%d: %d stocks", p->id, p->stocks);
		DrawText(hud, 8, hudY, 12, nameCol);
		hudY += 14;


		DrawRectangle(8, hudY, BAR_W, BAR_H, (Color){ 30, 30, 50, 200 });


		float t = p->voltage / 200.0f;
		Color fillCol;
		if (p->voltageMaxed) {
			fillCol = blinkOn ? (Color){ 255, 30, 30, 255 } : (Color){ 255, 160, 0, 255 };
		} else {
			fillCol = VoltageBarColor(t);
		}
		int fillW = (int)(BAR_W * t);
		if (fillW > 0) DrawRectangle(8, hudY, fillW, BAR_H, fillCol);


		if (p->voltageMaxed && blinkOn)
			DrawRectangleLines(8, hudY, BAR_W, BAR_H, (Color){ 255, 80, 80, 255 });


		char vLabel[12];
		snprintf(vLabel, sizeof(vLabel), "%.0f%%", p->voltage);
		Color vLabelCol = (p->voltageMaxed && blinkOn) ? (Color){ 255, 80, 80, 255 } : nameCol;
		DrawText(vLabel, 8 + BAR_W + 4, hudY, 10, vLabelCol);


		if (p->blocking)
			DrawText("[BLK]", 8 + BAR_W + 38, hudY, 10, (Color){ 80, 200, 255, 255 });

		hudY += BAR_H + 6;
	}


	if (is_spectator) {
		DrawText("SPECTATOR", SCREEN_W - 90, 8, 12, (Color){ 80, 200, 255, 255 });
	} else if (my_id > 0) {
		char txt[24];
		snprintf(txt, sizeof(txt), "Player %d", my_id);
		DrawText(txt, SCREEN_W - 80, 8, 12, YELLOW);
	} else if (no_id_frames > 60) {

		DrawText("Connecting...", SCREEN_W - 100, 8, 12, (Color){ 220, 140, 40, 255 });

		if (ws_player_count() > 0) {
			DrawText("Waiting for server...", SCREEN_W / 2 - 80, SCREEN_H / 2, 16,
					(Color){ 200, 200, 200, 180 });
		}
	} else {
		DrawText("Connecting...", SCREEN_W - 100, 8, 12, (Color){ 220, 140, 40, 255 });
	}


	if (match_over && winner_message[0] != '\0') {
		const bool iWon = (!is_spectator && my_id == winner_id);


		DrawRectangle(0, 0, SCREEN_W, SCREEN_H, (Color){ 0, 0, 0, 180 });


		const int BOX_W = 420;
		const int BOX_H = iWon ? 160 : 130;
		const int BOX_X = (SCREEN_W - BOX_W) / 2;
		const int BOX_Y = (SCREEN_H - BOX_H) / 2;

		Color borderCol = iWon
			? (Color){ 255, 215,   0, 255 }
			: (Color){  80, 200, 255, 255 };
		Color bgCol     = iWon
			? (Color){  40,  30,   0, 240 }
			: (Color){  20,  20,  40, 240 };

		DrawRectangle    (BOX_X, BOX_Y, BOX_W, BOX_H, bgCol);
		DrawRectangleLines(BOX_X, BOX_Y, BOX_W, BOX_H, borderCol);

		DrawRectangleLines(BOX_X+2, BOX_Y+2, BOX_W-4, BOX_H-4,
		                   (Color){ borderCol.r, borderCol.g, borderCol.b, 120 });

		if (iWon) {

			const char *line1 = "*** VICTORY ***";
			int l1w = MeasureText(line1, 36);
			DrawText(line1, BOX_X + (BOX_W - l1w) / 2, BOX_Y + 16, 36,
			         (Color){ 255, 215, 0, 255 });

			const char *line2 = "¡Eres el último en pie!";
			int l2w = MeasureText(line2, 18);
			DrawText(line2, BOX_X + (BOX_W - l2w) / 2, BOX_Y + 64, 18, WHITE);


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

			const char *line1 = is_spectator ? "FIN DE LA PARTIDA" : "DERROTA";
			int fsize1 = is_spectator ? 26 : 34;
			int l1w = MeasureText(line1, fsize1);
			DrawText(line1, BOX_X + (BOX_W - l1w) / 2, BOX_Y + 16, fsize1,
			         (Color){ 80, 200, 255, 255 });


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


	if (!match_over) {
		int   cd_phase   = ws_get_countdown();
		float cd_elapsed = ws_get_countdown_elapsed();

		if (cd_phase == 1 || cd_phase == 2) {
			float phase_t = (cd_phase == 1)
				? (cd_elapsed / 1.2f)
				: ((cd_elapsed - 1.2f) / 1.0f);
			if (phase_t > 1.0f) phase_t = 1.0f;

			const char *word = (cd_phase == 1) ? "READY?" : "FIGHT!";


			float scale = 1.0f + 0.6f * (1.0f - phase_t);


			float fade = (phase_t > 0.7f) ? (1.0f - (phase_t - 0.7f) / 0.3f) : 1.0f;
			if (fade < 0.0f) fade = 0.0f;
			unsigned char alpha = (unsigned char)(255.0f * fade);

			int size = (int)(64.0f * scale);
			int tw   = MeasureText(word, size);
			int tx   = (SCREEN_W - tw) / 2;
			int ty   = SCREEN_H / 2 - size / 2 - 30;


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

static void CSS_LoadPortraits(void) {
    if (g_css.portraitsLoaded) return;
    for (int i = 0; i < CHARS_COUNT; i++) g_css.portraits[i] = LoadTexture(CHARS[i].portrait);
    g_css.portraitsLoaded = true;
}

static void CSS_UnloadPortraits(void) {
    if (!g_css.portraitsLoaded) return;
    for (int i = 0; i < CHARS_COUNT; i++) UnloadTexture(g_css.portraits[i]);
    g_css.portraitsLoaded = false;
}


static bool CSS_UpdateAndDraw(void) {


    if (g_css.phase == CSS_SELECTING && !g_css.savedCharId[0]) {
        char saved[32] = {0};
        if (ws_get_saved_char_id(saved, sizeof(saved)) && saved[0]) {
            strncpy(g_css.savedCharId, saved, sizeof(g_css.savedCharId)-1);

            for (int i = 0; i < CHARS_COUNT; i++) {
                if (strcmp(CHARS[i].charId, saved) == 0) { g_css.selected = i; break; }
            }

            ws_send_char_select(saved, g_css.selected >= 0 ? g_css.selected : 0, 0);
            g_css.phase = CSS_WAITING_ACK;
        }
    }


    if (g_css.phase == CSS_WAITING_ACK && ws_char_select_ready()) {

        for (int s = 0; s < MAX_PLAYERS; s++) {
            if (players[s].active && players[s].id == my_id) {
                if (g_css.selected >= 0)
                    strncpy(players[s].charId, CHARS[g_css.selected].charId, sizeof(players[s].charId)-1);
                else if (g_css.savedCharId[0])
                    strncpy(players[s].charId, g_css.savedCharId, sizeof(players[s].charId)-1);
                break;
            }
        }
        g_css.phase = CSS_DONE;
        CSS_UnloadPortraits();
        return true;
    }


    if (g_css.phase == CSS_WAITING_GAME) {
        if (ws_match_started()) {
            for (int s = 0; s < MAX_PLAYERS; s++) {
                if (players[s].active && players[s].id == my_id) {
                    if (g_css.selected >= 0)
                        strncpy(players[s].charId, CHARS[g_css.selected].charId, sizeof(players[s].charId)-1);
                    else if (g_css.savedCharId[0])
                        strncpy(players[s].charId, g_css.savedCharId, sizeof(players[s].charId)-1);
                    break;
                }
            }
            g_css.phase = CSS_DONE;
            CSS_UnloadPortraits();
            return true;
        }

        {
            ClearBackground((Color){10, 10, 20, 255});
            const char *sel = (g_css.selected >= 0) ? CHARS[g_css.selected].name
                                                     : (g_css.savedCharId[0] ? g_css.savedCharId : "?");
            char line[64];
            snprintf(line, sizeof(line), "Listo: %s", sel);
            int sw2 = GetScreenWidth(), sh2 = GetScreenHeight();
            DrawText(line, (sw2 - MeasureText(line, 28)) / 2, sh2/2, 28, GOLD);
        }
        return false;
    }


    CSS_LoadPortraits();

    int sw = GetScreenWidth(), sh = GetScreenHeight();
    ClearBackground((Color){10, 10, 20, 255});
    const char *title = (g_css.phase == CSS_WAITING_ACK)
                      ? "Confirmando seleccion..."
                      : "Elige tu personaje";
    // All sizes scale with the actual canvas resolution.
    // Card width ~13% of screen, clamped to a sensible range.
    int cardW = (int)(sw * 0.13f);
    if (cardW < 100) cardW = 100;
    if (cardW > 280) cardW = 280;
    // Portraits are 720x1280 (9:16). Card = portrait area + name label.
    int labelH = (int)(cardW * 0.20f); if (labelH < 22) labelH = 22;
    int cardH  = (int)(cardW * (1280.0f / 720.0f)) + labelH;
    int gap    = (int)(cardW * 0.12f); if (gap < 10) gap = 10;

    // Font sizes proportional to screen width
    int titleSz = (int)(sw * 0.030f); if (titleSz < 20) titleSz = 20; if (titleSz > 56) titleSz = 56;
    int nameSz  = (int)(sw * 0.016f); if (nameSz  < 13) nameSz  = 13; if (nameSz  > 32) nameSz  = 32;
    int hintSz  = (int)(sw * 0.013f); if (hintSz  < 11) hintSz  = 11; if (hintSz  > 24) hintSz  = 24;

    int titleY = (int)(sh * 0.04f);
    DrawText(title, (sw - MeasureText(title, titleSz)) / 2, titleY, titleSz, WHITE);

    int totalW = CHARS_COUNT * cardW + (CHARS_COUNT - 1) * gap;
    int startX = (sw - totalW) / 2;
    int startY = titleY + titleSz + (int)(sh * 0.04f);
    // Prevent cards from running off the bottom edge
    int bottomLimit = sh - hintSz - (int)(sh * 0.06f);
    if (startY + cardH > bottomLimit) startY = bottomLimit - cardH;
    if (startY < titleY + titleSz + 8) startY = titleY + titleSz + 8;

    Vector2 mouse = GetMousePosition();
    if (g_css.phase == CSS_SELECTING) {
        for (int i = 0; i < CHARS_COUNT; i++) {
            Rectangle card = { startX + i*(cardW+gap), startY, cardW, cardH };
            if (CheckCollisionPointRec(mouse, card)) g_css.hovered = i;
        }
        if (IsKeyPressed(KEY_LEFT)  || IsKeyPressed(KEY_A)) g_css.hovered = (g_css.hovered + CHARS_COUNT - 1) % CHARS_COUNT;
        if (IsKeyPressed(KEY_RIGHT) || IsKeyPressed(KEY_D)) g_css.hovered = (g_css.hovered + 1) % CHARS_COUNT;
    }

    for (int i = 0; i < CHARS_COUNT; i++) {
        Rectangle card = { startX + i*(cardW+gap), startY, cardW, cardH };
        bool hover  = (g_css.phase == CSS_SELECTING && i == g_css.hovered);
        bool chosen = (i == g_css.selected);
        Color border = chosen ? GOLD : (hover ? WHITE : (Color){80,80,80,255});
        Color bg     = chosen ? (Color){40,30,10,255} : (hover ? (Color){30,30,50,255} : (Color){20,20,35,255});
        DrawRectangleRec(card, bg);
        DrawRectangleLinesEx(card, chosen ? 3.0f : 2.0f, border);

        // Portrait: contain scaling so the full 720x1280 image is visible.
        Texture2D tex = g_css.portraits[i];
        int portraitAreaH = cardH - labelH;
        if (tex.id > 0) {
            float scaleW = (float)(cardW - 4) / tex.width;
            float scaleH = (float)(portraitAreaH - 4) / tex.height;
            float scale  = (scaleW < scaleH) ? scaleW : scaleH;
            int   pw     = (int)(tex.width  * scale);
            int   ph     = (int)(tex.height * scale);
            int   px     = card.x + (cardW - pw) / 2;          // centred horizontally
            int   py     = card.y + (portraitAreaH - ph) / 2;  // centred vertically
            Rectangle src = { 0, 0, tex.width, tex.height };
            Rectangle dst = { px, py, pw, ph };
            DrawTexturePro(tex, src, dst, (Vector2){0,0}, 0.0f, WHITE);
        }
        // Name label centred in the bottom label row
        const char *nm = CHARS[i].name;
        int nmY = card.y + cardH - labelH + (labelH - nameSz) / 2;
        DrawText(nm, card.x + (cardW - MeasureText(nm, nameSz)) / 2, nmY, nameSz, border);

        if (chosen && g_css.phase == CSS_WAITING_ACK) {
            g_css.confirmTimer += GetFrameTime();
            if ((int)(g_css.confirmTimer * 4) % 2 == 0)
                DrawRectangleLinesEx(card, 4.0f, GOLD);
        }
    }

    if (g_css.phase == CSS_SELECTING) {
        const char *hint = "Click o ENTER para confirmar";
        DrawText(hint, (sw - MeasureText(hint, hintSz)) / 2, sh - (int)(sh * 0.05f), hintSz, GRAY);

        Rectangle hcard = { startX + g_css.hovered*(cardW+gap), startY, cardW, cardH };
        bool click = IsMouseButtonPressed(MOUSE_LEFT_BUTTON) && CheckCollisionPointRec(mouse, hcard);
        bool enter = IsKeyPressed(KEY_ENTER) || IsKeyPressed(KEY_SPACE);
        if (click || enter) {
            g_css.selected     = g_css.hovered;
            g_css.confirmTimer = 0.0f;
            g_css.phase        = CSS_WAITING_ACK;
            ws_send_char_select(CHARS[g_css.selected].charId, g_css.selected, 0);
        }
    }

    return false;
}

static void MainLoop(void) {
	if (!game_ready) return;

	// Resize every frame (including char select) so canvas matches App.jsx.
	{
		int newW = js_canvas_width();
		int newH = js_canvas_height();
		if (newW > 0 && newH > 0 && (newW != SCREEN_W || newH != SCREEN_H)) {
			SCREEN_W = newW;
			SCREEN_H = newH;
			SetWindowSize(SCREEN_W, SCREEN_H);
		}
	}

	if (g_css.phase != CSS_DONE) {
		BeginDrawing();
		CSS_UpdateAndDraw();
		EndDrawing();
		return;
	}


	is_spectator = (bool)ws_is_spectator();

	if (is_spectator) {

		my_id      = -1;
		no_id_frames = 0;
	} else if (my_id > 0) {

		no_id_frames = 0;
	} else {

		my_id = ws_get_my_id();
		if (my_id > 0) {
			ATTACK_RANGE   = ws_get_attack_range();
			ATTACK_RANGE_Y = ws_get_attack_range_y();
			no_id_frames   = 0;
		} else {

			no_id_frames++;
			if (no_id_frames >= NO_ID_SPECTATOR_FRAMES && ws_player_count() > 0) {
				is_spectator = true;
				my_id        = -1;
			}
		}
	}


	FetchState();
	FlushOnePlayerInit();


	if (!match_over && !victory_pending) {
		int vstate = ws_get_victory_state();
		if (vstate != 0) {
			int wid = ws_get_victory_winner();
			victory_pending = true;
			winner_id  = wid;

			if (vstate == 1)
				snprintf(winner_message, sizeof(winner_message), "VICTORY");
			else
				snprintf(winner_message, sizeof(winner_message), "DERROTA");

			// Start victory animation from the beginning with autoplay.
			// match_over and ws_consume_victory() are called only once
			// the animation finishes (in the DrawGame animation loop).
			int vi = AnimIndex("victory");
			for (int s = 0; s < MAX_PLAYERS; s++) {
				if (!players[s].active || players[s].id != winner_id) continue;
				if (players[s].character) {
					LoadPlayerAnim(&players[s], vi);
					SetCharacterAutoPlay(players[s].character, true);
					players[s].character->currentFrame = 0;
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

int main(void) {
	memset(players, 0, sizeof(players));

	SetTraceLogLevel(LOG_NONE);
	InitWindow(SCREEN_W, SCREEN_H, "Enuma Fighter");
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


	for (int i = 0; i < MAX_PLAYERS; i++)
		if (players[i].active) FreePlayer(&players[i]);
	CloseWindow();
	return 0;
}
