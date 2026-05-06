#include "raylib.h"
#include "raymath.h"
#include "bones_core.h"
#include <emscripten/emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#define MAX_PLAYERS 8
#define ANIM_COUNT  14

#define STAGE_LEFT    -8.0f
#define STAGE_RIGHT    8.0f
#define STAGE_Y       -0.05f
#define PLATFORM_H     0.12f

/* Hitbox — se sobreescriben con los valores reales del servidor al conectar */
static float ATTACK_RANGE   = 0.525f;
static float ATTACK_RANGE_Y = 0.5f;

static int SCREEN_W = 800;
static int SCREEN_H = 600;

static const char* ANIM_JSON[ANIM_COUNT] = {
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
};
static const char* ANIM_META[ANIM_COUNT] = {
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
};
static const char* ANIM_NAME[ANIM_COUNT] = {
	"idle", "walk", "jump",
	"attack_air", "attack_combo_1", "attack_combo_2", "attack_combo_3",
	"attack_crouch", "dash", "crouch", "crouch_loop", "hurt", "block", "attack_dash",
};

typedef struct {
	int   id;
	float wx, wy;
	float rotation;
	char  animation[24];
	int   active;
	int   animIndex;
	int   stocks;
	bool  respawning;
	bool  crouching;
	int   hitId;
	int   jumpId;
	float visualRotation;
	float attackFlashTimer;
	float attackFlashFacing;
	float voltage;      /* 0.0 – 200.0 */
	bool  voltageMaxed; /* true cuando voltage == 200 */
	bool  blocking;
	AnimatedCharacter* character;
	Vector3 referenceCenter;
	bool    hasReferenceCenter;
	float   anchorYOffset;
	bool    hasAnchorY;
} Player;

static Player players[MAX_PLAYERS];
static int    my_id      = -1;
static bool   game_ready = false;
static bool   debug_mode = false;
static Camera scene_cam;

#define MAX_PENDING 8
static int pending_ids[MAX_PENDING];
static int pending_count = 0;

static void InitPlayer(Player* p, int id);

static int AnimIndex(const char* name) {
	for (int i = 0; i < ANIM_COUNT; i++)
		if (strcmp(name, ANIM_NAME[i]) == 0) return i;
	return 0;
}

static void QueuePlayerInit(int id) {
	for (int i = 0; i < pending_count; i++)
		if (pending_ids[i] == id) return;
	if (pending_count < MAX_PENDING) pending_ids[pending_count++] = id;
}

static void FlushOnePlayerInit(void) {
	if (pending_count == 0) return;
	int id = pending_ids[0];
	for (int i = 1; i < pending_count; i++) pending_ids[i - 1] = pending_ids[i];
	pending_count--;
	int slot = -1;
	for (int s = 0; s < MAX_PLAYERS; s++)
		if (players[s].id == id && players[s].active == 2) { slot = s; break; }
	if (slot >= 0) InitPlayer(&players[slot], id);
}

static Vector3 CalcAnimCenter(const AnimationFrame* frame) {
	if (!frame || !frame->valid || frame->personCount == 0) return (Vector3){0, 0, 0};
	Vector3 sum = {0, 0, 0};
	int valid = 0;
	for (int p = 0; p < frame->personCount; p++) {
		const Person* person = &frame->persons[p];
		if (!person->active) continue;
		for (int b = 0; b < person->boneCount; b++) {
			const Bone* bone = &person->bones[b];
			if (!bone->position.valid) continue;
			sum = Vector3Add(sum, bone->position.position);
			valid++;
		}
	}
	return valid > 0 ? Vector3Scale(sum, 1.0f / (float)valid) : (Vector3){0, 0, 0};
}

static int FindBoneIndexByName(const Person* person, const char* name) {
	if (!person || !name) return -1;
	for (int b = 0; b < person->boneCount; b++)
		if (strcmp(person->bones[b].name, name) == 0) return b;
	return -1;
}

static bool GetBonePosByName(const AnimationFrame* frame, const char* name, Vector3* outPos) {
	if (!frame || !outPos || !frame->valid) return false;
	for (int p = 0; p < frame->personCount; p++) {
		const Person* person = &frame->persons[p];
		if (!person->active) continue;
		int idx = FindBoneIndexByName(person, name);
		if (idx >= 0 && person->bones[idx].position.valid) {
			*outPos = person->bones[idx].position.position;
			return true;
		}
	}
	return false;
}

static bool CalcAnkleMidPoint(const AnimationFrame* frame, Vector3* outPos) {
	if (!frame || !outPos || !frame->valid) return false;
	Vector3 left = {0, 0, 0}, right = {0, 0, 0};
	bool hasL = GetBonePosByName(frame, "LAnkle", &left);
	bool hasR = GetBonePosByName(frame, "RAnkle", &right);
	if (!hasL || !hasR) return false;
	*outPos = Vector3Scale(Vector3Add(left, right), 0.5f);
	return true;
}

static void ApplyOffsetToAnim(BonesAnimation* anim, Vector3 offset) {
	if (!anim || !anim->isLoaded) return;
	for (int f = 0; f < anim->frameCount; f++) {
		AnimationFrame* frame = &anim->frames[f];
		if (!frame->valid) continue;
		for (int p = 0; p < frame->personCount; p++) {
			Person* person = &frame->persons[p];
			if (!person->active) continue;
			for (int b = 0; b < person->boneCount; b++) {
				Bone* bone = &person->bones[b];
				if (bone->position.valid)
					bone->position.position = Vector3Add(bone->position.position, offset);
			}
		}
	}
}

static void StabilizeAnimX(BonesAnimation* anim) {
	if (!anim || !anim->isLoaded || anim->frameCount < 2) return;
	float baseX = 0.0f;
	int   n0    = 0;
	AnimationFrame* f0 = &anim->frames[0];
	for (int p = 0; p < f0->personCount; p++) {
		const Person* person = &f0->persons[p];
		if (!person->active) continue;
		for (int b = 0; b < person->boneCount; b++)
			if (person->bones[b].position.valid) { baseX += person->bones[b].position.position.x; n0++; }
	}
	if (n0 == 0) return;
	baseX /= (float)n0;

	for (int f = 1; f < anim->frameCount; f++) {
		AnimationFrame* frame = &anim->frames[f];
		if (!frame->valid) continue;
		float cx = 0.0f; int n = 0;
		for (int p = 0; p < frame->personCount; p++) {
			const Person* person = &frame->persons[p];
			if (!person->active) continue;
			for (int b = 0; b < person->boneCount; b++)
				if (person->bones[b].position.valid) { cx += person->bones[b].position.position.x; n++; }
		}
		if (n == 0) continue;
		float dx = baseX - (cx / (float)n);
		if (fabsf(dx) < 0.0001f) continue;
		for (int p = 0; p < frame->personCount; p++) {
			Person* person = &frame->persons[p];
			if (!person->active) continue;
			for (int b = 0; b < person->boneCount; b++)
				if (person->bones[b].position.valid)
					person->bones[b].position.position.x += dx;
		}
	}
}

static float TransitionDurationForAnim(const char* anim) {
	if (!anim)                          return 0.10f;
	if (strncmp(anim, "idle",   4) == 0) return 0.10f;
	if (strncmp(anim, "walk",   4) == 0) return 0.10f;
	if (strncmp(anim, "jump",   4) == 0) return 0.08f;
	if (strncmp(anim, "crouch", 6) == 0) return 0.10f;
	if (strncmp(anim, "dash",   4) == 0) return 0.06f;
	if (strncmp(anim, "hurt",   4) == 0) return 0.10f;
	if (strncmp(anim, "block",  5) == 0) return 0.08f;
	if (strncmp(anim, "attack_dash", 11) == 0) return 0.06f;
	return 0.12f;
}

static bool LoadAnimWithOffset(Player* p, const char* jsonPath, const char* metaPath) {
	if (!p || !p->character) return false;
	if (!LoadAnimation(p->character, jsonPath, metaPath)) return false;

	SetAnimationTransitionDuration(p->character, TransitionDurationForAnim(p->animation));

	if (p->character->animation.isLoaded && p->character->animation.frameCount > 0) {
		BonesAnimation* anim = &p->character->animation;
		StabilizeAnimX(anim);

		Vector3 thisCenter = {0, 0, 0};
		bool hasCtr = CalcAnkleMidPoint(&anim->frames[0], &thisCenter);
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
	}
	return true;
}

EM_JS(int, js_canvas_width,  (void), { return (window._canvasWidth  > 0) ? (window._canvasWidth  | 0) : 800; });
EM_JS(int, js_canvas_height, (void), { return (window._canvasHeight > 0) ? (window._canvasHeight | 0) : 600; });
EM_JS(int, ws_get_my_id,     (void), { return (window._myClientId   > 0) ? (window._myClientId   | 0) : -1;  });

EM_JS(float, ws_get_attack_range,   (void), {
	return (window._gameConfig && window._gameConfig.attackRange)  ? window._gameConfig.attackRange  : 0.525;
});
EM_JS(float, ws_get_attack_range_y, (void), {
	return (window._gameConfig && window._gameConfig.attackRangeY) ? window._gameConfig.attackRangeY : 0.5;
});

EM_JS(int, ws_player_count, (void), {
		if (!window._gameState || !window._gameState.players) return 0;
		return Object.keys(window._gameState.players).length;
		});

EM_JS(int, ws_get_player, (int idx, char* buf, int len), {
		if (!window._gameState || !window._gameState.players) return 0;
		const keys = Object.keys(window._gameState.players);
		if (idx >= keys.length) return 0;
		const p = window._gameState.players[keys[idx]];
		if (!p) return 0;
		const s = [
		p.id | 0,
		(p.x        ?? 0).toFixed(3),
		(p.y        ?? 0).toFixed(3),
		(p.rotation ?? 0).toFixed(4),
		p.animation || 'idle',
		p.stocks    ?? 3,
		p.respawning ? 1 : 0,
		p.hitId     ?? 0,
		p.crouching ? 1 : 0,
		p.jumpId    ?? 0,
		(p.voltage  ?? 0).toFixed(1),
		p.blocking      ? 1 : 0,
		p.voltageMaxed  ? 1 : 0,
		].join('|');
		stringToUTF8(s, buf, len);
		return 1;
		});

static void strcpy_safe(char* dst, const char* src, size_t n) {
	strncpy(dst, src, n - 1);
	dst[n - 1] = '\0';
}

static void InitPlayer(Player* p, int id) {
	const Player prev = *p;

	memset(p, 0, sizeof(Player));
	p->id                 = id;
	p->active             = 1;
	p->animIndex          = prev.animIndex;
	p->wx                 = prev.wx;
	p->wy                 = prev.wy;
	p->rotation           = prev.rotation;
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

static void FreePlayer(Player* p) {
	if (p->character) {
		DestroyAnimatedCharacter(p->character);
		p->character = NULL;
	}
	p->active = 0;
	p->id     = -1;
}

static int ParsePlayer(const char* buf,
		int* id, float* x, float* y, float* rot,
		char* anim, int animLen,
		int* stocks, int* respawning, int* hitId, int* crouching, int* jumpId,
		float* voltage, int* blocking, int* voltageMaxed)
{
	char tmp[256];
	strncpy(tmp, buf, 255); tmp[255] = '\0';
	char* tok;
	tok = strtok(tmp,  "|"); if (!tok) return 0; *id         = atoi(tok);
	tok = strtok(NULL, "|"); if (!tok) return 0; *x          = (float)atof(tok);
	tok = strtok(NULL, "|"); if (!tok) return 0; *y          = (float)atof(tok);
	tok = strtok(NULL, "|"); if (!tok) return 0; *rot        = (float)atof(tok);
	tok = strtok(NULL, "|");
	strncpy(anim, tok ? tok : "idle", animLen - 1);
	anim[animLen - 1] = '\0';
	tok = strtok(NULL, "|"); *stocks     = tok ? atoi(tok) : 3;
	tok = strtok(NULL, "|"); *respawning = tok ? atoi(tok) : 0;
	tok = strtok(NULL, "|"); *hitId      = tok ? atoi(tok) : 0;
	tok = strtok(NULL, "|"); *crouching  = tok ? atoi(tok) : 0;
	tok = strtok(NULL, "|"); *jumpId     = tok ? atoi(tok) : 0;
	tok = strtok(NULL, "|"); *voltage    = tok ? (float)atof(tok) : 0.0f;
	tok = strtok(NULL, "|"); *blocking   = tok ? atoi(tok) : 0;
	tok = strtok(NULL, "|"); *voltageMaxed = tok ? atoi(tok) : 0;
	return 1;
}

static void FetchState(void) {
	if (my_id < 0) return;

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
			players[slot].animIndex = AnimIndex(panim);
			strcpy_safe(players[slot].animation, panim, sizeof(players[slot].animation));
			QueuePlayerInit(pid);
		}

		seen[slot]               = 1;
		players[slot].wx         = px;
		players[slot].wy         = py;
		players[slot].rotation   = prot;
		if (players[slot].active == 2) players[slot].visualRotation = prot;
		players[slot].stocks     = pstocks;
		players[slot].respawning = prespawning;
		players[slot].crouching  = pcrouching;
		players[slot].voltage    = pvoltage;      /* NEW */
		players[slot].voltageMaxed = pvoltageMaxed; /* NEW */
		players[slot].blocking   = pblocking;  /* NEW */

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
			if (strncmp(panim, "attack", 6) == 0 &&
					strncmp(players[slot].animation, "attack", 6) != 0) {
				players[slot].attackFlashTimer  = 0.3f;
				players[slot].attackFlashFacing = (prot > 1.0f) ? -1.0f : 1.0f;
			}
			strcpy_safe(players[slot].animation, panim, sizeof(players[slot].animation));
		}
	}

	for (int s = 0; s < MAX_PLAYERS; s++) {
		if (players[s].active && !seen[s]) {
			for (int q = 0; q < pending_count; q++) {
				if (pending_ids[q] == players[s].id) {
					for (int r = q + 1; r < pending_count; r++) pending_ids[r - 1] = pending_ids[r];
					pending_count--;
					break;
				}
			}
			if (players[s].active == 1) FreePlayer(&players[s]);
			else { players[s].active = 0; players[s].id = -1; }
		}
	}
}

static void DrawGame(void) {
	static float camX = 0.0f;

	for (int s = 0; s < MAX_PLAYERS; s++) {
		if (!players[s].active || players[s].id != my_id) continue;
		camX += (players[s].wx - camX) * 0.08f;
		break;
	}

	float halfW = 5.0f;
	if (camX - halfW < STAGE_LEFT)  camX = STAGE_LEFT  + halfW;
	if (camX + halfW > STAGE_RIGHT) camX = STAGE_RIGHT - halfW;

	scene_cam.position = (Vector3){ camX, 1.2f,  9.0f };
	scene_cam.target   = (Vector3){ camX, 1.2f,  0.0f };
	scene_cam.up       = (Vector3){ 0.0f, 1.0f,  0.0f };

	BeginDrawing();
	ClearBackground((Color){10, 10, 28, 255});

	BeginMode3D(scene_cam);

	DrawCube((Vector3){0.0f, STAGE_Y, 0.0f},
			STAGE_RIGHT - STAGE_LEFT, PLATFORM_H, 0.6f,
			(Color){60, 60, 90, 255});
	DrawCubeWires((Vector3){0.0f, STAGE_Y, 0.0f},
			STAGE_RIGHT - STAGE_LEFT, PLATFORM_H, 0.6f,
			(Color){100, 100, 160, 200});

	float platW = 2.4f, platH = 0.1f;
	DrawCube((Vector3){-4.0f, 1.6f, 0.0f}, platW, platH, 0.5f, (Color){50, 70, 110, 255});
	DrawCube((Vector3){ 4.0f, 1.6f, 0.0f}, platW, platH, 0.5f, (Color){50, 70, 110, 255});
	DrawCube((Vector3){ 0.0f, 2.8f, 0.0f}, platW, platH, 0.5f, (Color){50, 70, 110, 255});

	EndMode3D();

	float dt = GetFrameTime();

	for (int s = 0; s < MAX_PLAYERS; s++) {
		Player* p = &players[s];
		if (p->active != 1 || !p->character || p->respawning) continue;

		if (p->character->currentFrame < 0 ||
				p->character->currentFrame >= p->character->animation.frameCount) {
			p->character->currentFrame = 0;
			p->character->forceUpdate  = true;
		}

		UpdateAnimatedCharacter(p->character, dt);

		if (p->character->animController && !p->character->animController->playing) {
			if (p->animIndex == 9 || p->animIndex == 2) {
				int last = p->character->animation.frameCount - 1;
				if (last < 0) last = 0;
				p->character->currentFrame = last;
				p->character->forceUpdate  = true;
				SetCharacterAutoPlay(p->character, false);
			} else if (p->animIndex != 0) {
				strcpy_safe(p->animation, "idle", sizeof(p->animation));
				p->animIndex = 0;
				LoadAnimWithOffset(p, ANIM_JSON[0], ANIM_META[0]);
				SetCharacterAutoPlay(p->character, true);
			}
		}

		if (p->character->autoCenterCalculated) {
			p->character->autoCenter.x = 0.0f;
			p->character->autoCenter.z = 0.0f;
		}

		float visualY = p->wy - (p->hasAnchorY ? p->anchorYOffset : 0.0f);
		Vector3 worldPos = (Vector3){ p->wx, visualY, 0.0f };

		const float TURN_SPEED = 12.0f;
		{
			float target = p->rotation;
			float cur    = p->visualRotation;
			float diff   = target - cur;
			while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
			while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;
			float step = TURN_SPEED * dt;
			if (fabsf(diff) <= step) p->visualRotation = target;
			else                     p->visualRotation  = cur + (diff > 0 ? step : -step);
		}

		float drawRot = p->visualRotation + (float)M_PI_2;
		DrawAnimatedCharacterTransformed(p->character, scene_cam, worldPos, drawRot);
	}

	// DEBUG_START
	if (IsKeyPressed(KEY_U)) debug_mode = !debug_mode;
	if (debug_mode) {
		BeginMode3D(scene_cam);

		DrawCubeWires((Vector3){0.0f,  0.0f, 0.0f}, 16.0f, 0.05f, 0.1f, (Color){0, 200, 255, 160});
		DrawCubeWires((Vector3){-4.0f, 1.6f, 0.0f},  2.4f, 0.05f, 0.1f, (Color){0, 200, 255, 160});
		DrawCubeWires((Vector3){ 4.0f, 1.6f, 0.0f},  2.4f, 0.05f, 0.1f, (Color){0, 200, 255, 160});
		DrawCubeWires((Vector3){ 0.0f, 2.8f, 0.0f},  2.4f, 0.05f, 0.1f, (Color){0, 200, 255, 160});
		DrawLine3D((Vector3){-8.0f, -6.0f, 0}, (Vector3){-8.0f, 4.0f, 0}, (Color){255, 60, 60, 180});
		DrawLine3D((Vector3){ 8.0f, -6.0f, 0}, (Vector3){ 8.0f, 4.0f, 0}, (Color){255, 60, 60, 180});
		DrawLine3D((Vector3){-10.f, -6.0f, 0}, (Vector3){10.0f, -6.0f, 0}, (Color){255, 60, 60, 180});

		for (int s = 0; s < MAX_PLAYERS; s++) {
			Player* p = &players[s];
			if (p->active != 1 || p->respawning) continue;
			Vector3 wp = (Vector3){ p->wx, p->wy, 0.0f };
			Color   cc = (p->id == my_id) ? (Color){0, 255, 100, 220} : (Color){255, 80, 80, 220};

			DrawCubeWires((Vector3){wp.x, wp.y + 0.36f, 0.0f}, 0.48f, 0.72f, 0.05f, cc);
			DrawSphere(wp, 0.06f, cc);

			if (p->attackFlashTimer > 0.0f) {
				p->attackFlashTimer -= dt;
				if (p->attackFlashTimer > 0.0f) {
					DrawCubeWires(
							(Vector3){ wp.x + p->attackFlashFacing * (ATTACK_RANGE * 0.5f),
							wp.y + 0.5f, 0.0f },
							ATTACK_RANGE, ATTACK_RANGE_Y, 0.05f,
							(Color){255, 255, 0, 220});
				}
			}
		}
		EndMode3D();
	}
	// DEBUG_END

	/* ── HUD: stocks + voltage bar ────────────────────────────────────────── */
	int hudY = 8;
	for (int s = 0; s < MAX_PLAYERS; s++) {
		Player* p = &players[s];
		if (!p->active) continue;

		const bool isMe = (p->id == my_id);

		/* ── Stocks label ── */
		char hud[48];
		snprintf(hud, sizeof(hud), "P%d: %d stocks", p->id, p->stocks);
		Color labelCol = isMe ? YELLOW : WHITE;
		DrawText(hud, 8, hudY, 12, labelCol);
		hudY += 14;

		/* ── Voltage bar background ── */
		const int BAR_W = 120;
		const int BAR_H = 8;
		DrawRectangle(8, hudY, BAR_W, BAR_H, (Color){30, 30, 50, 200});

		/* ── Parpadeo crítico a 200% ── */
		static float blinkTimer = 0.0f;
		static bool  blinkOn    = true;
		blinkTimer += dt;
		if (blinkTimer > 0.18f) { blinkTimer = 0.0f; blinkOn = !blinkOn; }

		/* ── Voltage fill: blue(0%) → yellow(100%) → red(200%) ── */
		float t = p->voltage / 200.0f;   /* 0.0 – 1.0 */
		Color fillCol;
		if (p->voltageMaxed) {
			/* Rojo/naranja parpadeante — estado crítico */
			fillCol = blinkOn
				? (Color){255, 30,  30, 255}
				: (Color){255, 160,  0, 255};
		} else if (t < 0.5f) {
			/* blue → yellow */
			float u = t * 2.0f;
			fillCol = (Color){
				(unsigned char)(u * 255),
				(unsigned char)(u * 220),
				(unsigned char)((1.0f - u) * 255),
				230
			};
		} else {
			/* yellow → red */
			float u = (t - 0.5f) * 2.0f;
			fillCol = (Color){
				255,
				(unsigned char)((1.0f - u) * 220),
				0,
				230
			};
		}

		int fillW = (int)(BAR_W * t);
		if (fillW > 0)
			DrawRectangle(8, hudY, fillW, BAR_H, fillCol);

		/* Borde parpadeante extra en estado crítico */
		if (p->voltageMaxed && blinkOn)
			DrawRectangleLines(8, hudY, BAR_W, BAR_H, (Color){255, 80, 80, 255});

		/* ── Voltage percentage label ── */
		char vLabel[12];
		snprintf(vLabel, sizeof(vLabel), "%.0f%%", p->voltage);
		Color vLabelCol = (p->voltageMaxed && blinkOn)
			? (Color){255, 80, 80, 255}
			: labelCol;
		DrawText(vLabel, 8 + BAR_W + 4, hudY, 10, vLabelCol);

		/* ── Block indicator ── */
		if (p->blocking)
			DrawText("[BLK]", 8 + BAR_W + 38, hudY, 10, (Color){80, 200, 255, 255});

		hudY += BAR_H + 6;
	}

	if (my_id > 0) {
		char txt[24]; snprintf(txt, sizeof(txt), "Jugador %d", my_id);
		DrawText(txt, SCREEN_W - 80, 8, 12, YELLOW);
	} else {
		DrawText("Conectando...", SCREEN_W - 100, 8, 12, (Color){220, 140, 40, 255});
	}

	EndDrawing();
}

static void MainLoop(void) {
    if (!game_ready) return;
    if (my_id < 0) {
        my_id = ws_get_my_id();
        if (my_id > 0) {
            /* Primera vez que tenemos ID — leer config del servidor */
            ATTACK_RANGE   = ws_get_attack_range();
            ATTACK_RANGE_Y = ws_get_attack_range_y();
        }
    }

    int newW = js_canvas_width();
    int newH = js_canvas_height();
    if (newW != SCREEN_W || newH != SCREEN_H) {
        SCREEN_W = newW;
        SCREEN_H = newH;
        SetWindowSize(SCREEN_W, SCREEN_H);
    }

    FetchState();
    FlushOnePlayerInit();
    DrawGame();
}

int main(void) {
	memset(players, 0, sizeof(players));
	InitWindow(SCREEN_W, SCREEN_H, "ft_transcendence");
	SetTargetFPS(60);

	scene_cam = (Camera){
		.position   = { 0.0f, 1.2f,  9.0f },
			.target     = { 0.0f, 1.2f,  0.0f },
			.up         = { 0.0f, 1.0f,  0.0f },
			.fovy       = 50.0f,
			.projection = CAMERA_PERSPECTIVE
	};

	game_ready = true;
	emscripten_set_main_loop(MainLoop, 0, 1);

	for (int i = 0; i < MAX_PLAYERS; i++)
		if (players[i].active) FreePlayer(&players[i]);
	CloseWindow();
	return 0;
}