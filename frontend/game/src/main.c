#include "raylib.h"
#include "raymath.h"
#include "bones_core.h"
#include <emscripten/emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#define MAX_PLAYERS 8

static int SCREEN_W = 800;
static int SCREEN_H = 600;

/* ─── ANIMACIONES ─── */

static const char* ANIM_JSON[8] = {
    "data/animations/idle.json",
    "data/animations/walk.json",
    "data/animations/jump.json",
    "data/animations/kick.json",
    "data/animations/punch.json",
    "data/animations/idle.json",
    "data/animations/crouch.json",
    "data/animations/crouch.json"
};
static const char* ANIM_META[8] = {
    "data/animations/idle.anim",
    "data/animations/walk.anim",
    "data/animations/jump.anim",
    "data/animations/kick.anim",
    "data/animations/punch.anim",
    "data/animations/idle.anim",
    "data/animations/crouch.anim",
    "data/animations/crouch.anim"
};
static const char* ANIM_NAME[8] = { "idle", "walk", "jump", "kick", "punch", "dash", "crouch", "crouch_loop" };
#define ANIM_COUNT 8

static int AnimIndex(const char* name) {
    for (int i = 0; i < ANIM_COUNT; i++)
        if (strcmp(name, ANIM_NAME[i]) == 0) return i;
    return 0;
}

/* ─── JUGADOR ─── */

typedef struct {
    int id;
    float wx, wy;
    float rotation;
    char animation[16];
    int active;
    int animIndex;
    int stocks;
    bool respawning;
    bool crouching;
    int hitId;
    AnimatedCharacter* character;
    Vector3 firstAnimAnchor;
    bool hasRefAnchor;
} Player;

static Player players[MAX_PLAYERS];
static int my_id = -1;
static bool game_ready = false;
static bool debug_mode = false;

static Camera scene_cam;

/* ─── PENDING INIT QUEUE ─── */

#define MAX_PENDING 8
static int pending_ids[MAX_PENDING];
static int pending_count = 0;

static void InitPlayer(Player* p, int id);

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
    if (slot < 0) return;
    InitPlayer(&players[slot], id);
}

/* ─── ANIM UTILS ─── */

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
    for (int b = 0; b < person->boneCount; b++) {
        const Bone* bone = &person->bones[b];
        if (strcmp(bone->name, name) == 0) return b;
    }
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
    Vector3 left = {0, 0, 0};
    Vector3 right = {0, 0, 0};
    bool hasL = GetBonePosByName(frame, "LAnkle", &left);
    bool hasR = GetBonePosByName(frame, "RAnkle", &right);
    if (!hasL || !hasR) return false;
    *outPos = Vector3Scale(Vector3Add(left, right), 0.5f);
    return true;
}

static Vector3 GetCurrentFrameAnchor(Player* p) {
    if (!p || !p->character || !p->character->animation.isLoaded ||
        p->character->currentFrame < 0 || p->character->currentFrame >= p->character->animation.frameCount)
        return (Vector3){0, 0, 0};

    const AnimationFrame* frame = &p->character->animation.frames[p->character->currentFrame];
    Vector3 ankleMid;
    if (CalcAnkleMidPoint(frame, &ankleMid)) return ankleMid;
    return CalcAnimCenter(frame);
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
    int n0 = 0;

    AnimationFrame* f0 = &anim->frames[0];
    for (int p = 0; p < f0->personCount; p++) {
        const Person* person = &f0->persons[p];
        if (!person->active) continue;
        for (int b = 0; b < person->boneCount; b++) {
            if (person->bones[b].position.valid) {
                baseX += person->bones[b].position.position.x;
                n0++;
            }
        }
    }

    if (n0 == 0) return;
    baseX /= (float)n0;

    for (int f = 1; f < anim->frameCount; f++) {
        AnimationFrame* frame = &anim->frames[f];
        if (!frame->valid) continue;

        float cx = 0.0f;
        int n = 0;
        for (int p = 0; p < frame->personCount; p++) {
            const Person* person = &frame->persons[p];
            if (!person->active) continue;
            for (int b = 0; b < person->boneCount; b++) {
                if (person->bones[b].position.valid) {
                    cx += person->bones[b].position.position.x;
                    n++;
                }
            }
        }

        if (n == 0) continue;

        float dx = baseX - (cx / (float)n);
        if (fabsf(dx) < 0.0001f) continue;

        for (int p = 0; p < frame->personCount; p++) {
            Person* person = &frame->persons[p];
            if (!person->active) continue;
            for (int b = 0; b < person->boneCount; b++) {
                if (person->bones[b].position.valid)
                    person->bones[b].position.position.x += dx;
            }
        }
    }
}

static bool LoadAnimWithOffset(Player* p, const char* jsonPath, const char* metaPath) {
    if (!p || !p->character) return false;
    if (!LoadAnimation(p->character, jsonPath, metaPath)) return false;

    if (p->character->animation.isLoaded && p->character->animation.frameCount > 0) {
        BonesAnimation* anim = &p->character->animation;

        StabilizeAnimX(anim);

        Vector3 anchor = {0, 0, 0};
        bool hasAnchor = CalcAnkleMidPoint(&anim->frames[0], &anchor);
        if (!hasAnchor) anchor = CalcAnimCenter(&anim->frames[0]);

        if (!p->hasRefAnchor) {
            p->firstAnimAnchor = anchor;
            p->hasRefAnchor = true;
        }

        Vector3 offset = Vector3Subtract(p->firstAnimAnchor, anchor);

        if (fabsf(offset.x) > 0.001f || fabsf(offset.y) > 0.001f || fabsf(offset.z) > 0.001f)
            ApplyOffsetToAnim(anim, offset);

        p->character->forceUpdate = true;
    }
    return true;
}

/* ─── JS BRIDGE ─── */

EM_JS(int, js_canvas_width, (void), {
    return (window._canvasWidth > 0) ? (window._canvasWidth | 0) : 800;
});
EM_JS(int, js_canvas_height, (void), {
    return (window._canvasHeight > 0) ? (window._canvasHeight | 0) : 600;
});
EM_JS(int, ws_get_my_id, (void), {
    return (window._myClientId > 0) ? (window._myClientId | 0) : -1;
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
        (p.x ?? 0).toFixed(3),
        (p.y ?? 0).toFixed(3),
        (p.rotation ?? 0).toFixed(4),
        p.animation || 'idle',
        p.stocks ?? 3,
        p.respawning ? 1 : 0,
        p.hitId ?? 0,
        p.crouching ? 1 : 0,
    ].join('|');
    stringToUTF8(s, buf, len);
    return 1;
});

/* ─── INIT/FREE PLAYER ─── */

static void InitPlayer(Player* p, int id) {
    int savedAnimIndex = p->animIndex;
    char savedAnim[16];
    strncpy(savedAnim, p->animation, sizeof(savedAnim));
    savedAnim[sizeof(savedAnim) - 1] = '\0';

    float savedX = p->wx, savedY = p->wy, savedRot = p->rotation;
    int savedStocks = p->stocks > 0 ? p->stocks : 3;
    int savedHitId = p->hitId;

    memset(p, 0, sizeof(Player));
    p->id = id;
    p->active = 1;
    p->animIndex = savedAnimIndex;
    p->hasRefAnchor = false;
    p->firstAnimAnchor = (Vector3){0, 0, 0};
    p->wx = savedX;
    p->wy = savedY;
    p->rotation = savedRot;
    p->stocks = savedStocks;
    p->hitId = savedHitId;
    strncpy(p->animation, savedAnim, sizeof(p->animation));
    p->animation[sizeof(p->animation) - 1] = '\0';

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
    p->id = -1;
}

/* ─── PARSE PLAYER ─── */

static int ParsePlayer(const char* buf, int* id,
                       float* x, float* y, float* rot,
                       char* anim, int animLen,
                       int* stocks, int* respawning, int* hitId, int* crouching)
{
    char tmp[256];
    strncpy(tmp, buf, 255);
    tmp[255] = '\0';

    char* tok;
    tok = strtok(tmp, "|"); if (!tok) return 0; *id = atoi(tok);
    tok = strtok(NULL, "|"); if (!tok) return 0; *x = (float)atof(tok);
    tok = strtok(NULL, "|"); if (!tok) return 0; *y = (float)atof(tok);
    tok = strtok(NULL, "|"); if (!tok) return 0; *rot = (float)atof(tok);
    tok = strtok(NULL, "|");
    strncpy(anim, tok ? tok : "idle", animLen - 1);
    anim[animLen - 1] = '\0';
    tok = strtok(NULL, "|"); *stocks = tok ? atoi(tok) : 3;
    tok = strtok(NULL, "|"); *respawning = tok ? atoi(tok) : 0;
    tok = strtok(NULL, "|"); *hitId = tok ? atoi(tok) : 0;
    tok = strtok(NULL, "|"); *crouching = tok ? atoi(tok) : 0;
    return 1;
}

/* ─── FETCH STATE ─── */

static void FetchState(void) {
    if (my_id < 0) return;

    int count = ws_player_count();
    char buf[256];
    int seen[MAX_PLAYERS] = {0};

    for (int i = 0; i < count && i < MAX_PLAYERS; i++) {
        if (!ws_get_player(i, buf, sizeof(buf))) continue;

        int pid, pstocks, prespawning, phitId, pcrouching;
        float px, py, prot;
        char panim[16];
        if (!ParsePlayer(buf, &pid, &px, &py, &prot, panim, sizeof(panim),
                         &pstocks, &prespawning, &phitId, &pcrouching)) continue;

        int slot = -1;
        for (int s = 0; s < MAX_PLAYERS; s++)
            if (players[s].active && players[s].id == pid) { slot = s; break; }
        if (slot < 0)
            for (int s = 0; s < MAX_PLAYERS; s++)
                if (!players[s].active) { slot = s; break; }
        if (slot < 0) continue;

        if (!players[slot].active) {
            players[slot].id = pid;
            players[slot].active = 2;
            players[slot].animIndex = AnimIndex(panim);
            strncpy(players[slot].animation, panim, sizeof(players[slot].animation));
            players[slot].animation[sizeof(players[slot].animation) - 1] = '\0';
            QueuePlayerInit(pid);
        }

        seen[slot] = 1;
        players[slot].wx = px;
        players[slot].wy = py;
        players[slot].rotation = prot;
        players[slot].stocks = pstocks;
        players[slot].respawning = prespawning;
        players[slot].crouching = pcrouching;

        if (strncmp(players[slot].animation, panim, sizeof(players[slot].animation)) != 0) {
            int ai = AnimIndex(panim);
            if (ai != players[slot].animIndex && players[slot].character) {
                Vector3 oldAnchor = GetCurrentFrameAnchor(&players[slot]);

                LoadAnimWithOffset(&players[slot], ANIM_JSON[ai], ANIM_META[ai]);
                SetCharacterAutoPlay(players[slot].character, true);

                if (oldAnchor.x != 0.0f || oldAnchor.y != 0.0f || oldAnchor.z != 0.0f) {
                    BonesAnimation* anim = &players[slot].character->animation;
                    if (anim->isLoaded && anim->frameCount > 0) {
                        Vector3 newAnchor = {0, 0, 0};
                        bool hasNew = CalcAnkleMidPoint(&anim->frames[0], &newAnchor);
                        if (!hasNew) newAnchor = CalcAnimCenter(&anim->frames[0]);

                        Vector3 delta = Vector3Subtract(oldAnchor, newAnchor);

                        if (fabsf(delta.x) > 0.001f || fabsf(delta.y) > 0.001f || fabsf(delta.z) > 0.001f) {
                            ApplyOffsetToAnim(anim, delta);
                            players[slot].character->forceUpdate = true;
                        }
                    }
                }

                players[slot].animIndex = ai;
            }
            strncpy(players[slot].animation, panim, sizeof(players[slot].animation));
            players[slot].animation[sizeof(players[slot].animation) - 1] = '\0';
        }
    }

    for (int s = 0; s < MAX_PLAYERS; s++)
        if (players[s].active && !seen[s]) {
            for (int q = 0; q < pending_count; q++)
                if (pending_ids[q] == players[s].id) {
                    for (int r = q + 1; r < pending_count; r++) pending_ids[r - 1] = pending_ids[r];
                    pending_count--;
                    break;
                }
            if (players[s].active == 1) FreePlayer(&players[s]);
            else { players[s].active = 0; players[s].id = -1; }
        }
}

/* ─── CÁMARA LATERAL ─── */

static Vector3 WorldTo3D(float wx, float wy) {
    return (Vector3){ wx, wy, 0.0f };
}

/* ─── DRAW ─── */

#define STAGE_LEFT   -8.0f
#define STAGE_RIGHT   8.0f
#define STAGE_Y      -0.05f
#define PLATFORM_H    0.12f
#define ATTACK_RANGE   1.4f
#define ATTACK_RANGE_Y 0.8f

static void DrawGame(void) {
    static float camX = 0.0f;

    for (int s = 0; s < MAX_PLAYERS; s++) {
        if (!players[s].active || players[s].id != my_id) continue;
        camX += (players[s].wx - camX) * 0.08f;
        break;
    }

    float halfW = 5.0f;
    if (camX - halfW < STAGE_LEFT) camX = STAGE_LEFT + halfW;
    if (camX + halfW > STAGE_RIGHT) camX = STAGE_RIGHT - halfW;

    scene_cam.position = (Vector3){ camX, 1.2f, 9.0f };
    scene_cam.target   = (Vector3){ camX, 1.2f, 0.0f };
    scene_cam.up       = (Vector3){ 0.0f, 1.0f, 0.0f };

    BeginDrawing();
    ClearBackground((Color){10, 10, 28, 255});

    BeginMode3D(scene_cam);

    DrawCube((Vector3){0.0f, STAGE_Y, 0.0f},
             STAGE_RIGHT - STAGE_LEFT, PLATFORM_H, 0.6f,
             (Color){60, 60, 90, 255});
    DrawCubeWires((Vector3){0.0f, STAGE_Y, 0.0f},
                  STAGE_RIGHT - STAGE_LEFT, PLATFORM_H, 0.6f,
                  (Color){100, 100, 160, 200});

    float platY = 1.6f;
    float platW = 2.4f;
    float platH = 0.1f;
    DrawCube((Vector3){-4.0f, platY, 0.0f}, platW, platH, 0.5f, (Color){50, 70, 110, 255});
    DrawCube((Vector3){ 4.0f, platY, 0.0f}, platW, platH, 0.5f, (Color){50, 70, 110, 255});
    DrawCube((Vector3){ 0.0f, 2.8f,  0.0f}, platW, platH, 0.5f, (Color){50, 70, 110, 255});

    float dt = GetFrameTime();

    if (IsKeyPressed(KEY_U)) debug_mode = !debug_mode;

    for (int s = 0; s < MAX_PLAYERS; s++) {
        Player* p = &players[s];
        if (p->active != 1 || !p->character || p->respawning) continue;

        if (p->character->currentFrame < 0 ||
            p->character->currentFrame >= p->character->animation.frameCount) {
            p->character->currentFrame = 0;
            p->character->forceUpdate = true;
        }

        UpdateAnimatedCharacter(p->character, dt);

        if (p->character->animController && !p->character->animController->playing) {
    if (p->animIndex == 6) { // crouch

        int last = p->character->animation.frameCount - 1;
        if (last < 0) last = 0;

        p->character->currentFrame = last;
        p->character->forceUpdate  = true;

        // MUY IMPORTANTE: no autoplay
        SetCharacterAutoPlay(p->character, false);
    }
else if (p->animIndex != 0) {
                strncpy(p->animation, "idle", sizeof(p->animation));
                p->animation[sizeof(p->animation) - 1] = '\0';
                p->animIndex = 0;
                LoadAnimWithOffset(p, ANIM_JSON[0], ANIM_META[0]);
                SetCharacterAutoPlay(p->character, true);
            }
        }

        Vector3 worldPos = WorldTo3D(p->wx, p->wy);
        float drawRot = p->rotation + (float)M_PI_2;
        DrawAnimatedCharacterTransformed(p->character, scene_cam, worldPos, drawRot);
    }

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
            Vector3 wp = WorldTo3D(p->wx, p->wy);
            Color cc = (p->id == my_id) ? (Color){0, 255, 100, 220} : (Color){255, 80, 80, 220};

            DrawCubeWires((Vector3){wp.x, wp.y + 0.8f, 0.0f}, 0.9f, 1.6f, 0.05f, cc);
            DrawSphere(wp, 0.06f, cc);

            if (strncmp(p->animation, "punch", 5) == 0 ||
                strncmp(p->animation, "kick", 4) == 0) {
                float facing = (p->rotation < 1.0f) ? 1.0f : -1.0f;
                DrawCubeWires(
                    (Vector3){ wp.x + facing * (ATTACK_RANGE * 0.5f), wp.y + 0.4f, 0.0f },
                    ATTACK_RANGE, ATTACK_RANGE_Y * 2.0f, 0.05f,
                    (Color){255, 255, 0, 220});
            }
        }
        EndMode3D();

        for (int s = 0; s < MAX_PLAYERS; s++) {
            Player* p = &players[s];
            if (p->active != 1 || p->respawning) continue;
            Vector3 wp = WorldTo3D(p->wx, p->wy);
            Vector2 sp = GetWorldToScreen((Vector3){wp.x, wp.y + 2.0f, 0.0f}, scene_cam);
            char lbl[48];
            snprintf(lbl, sizeof(lbl), "P%d [%s]", p->id, p->animation);
            DrawText(lbl, (int)sp.x - 28, (int)sp.y, 10,
                (p->id == my_id) ? (Color){0, 255, 100, 255} : (Color){255, 180, 80, 255});
        }
        DrawRectangle(SCREEN_W / 2 - 50, 4, 100, 16, (Color){0, 0, 0, 120});
        DrawText("[ DEBUG ]", SCREEN_W / 2 - 28, 6, 11, (Color){255, 220, 0, 255});
    }

    EndMode3D();

    int hudY = 8;
    for (int s = 0; s < MAX_PLAYERS; s++) {
        Player* p = &players[s];
        if (!p->active) continue;
        Color c = (p->id == my_id) ? YELLOW : WHITE;
        char label[48];
        snprintf(label, sizeof(label), "P%d  ♥×%d", p->id, p->stocks);
        DrawText(label, 8, hudY, 14, c);
        hudY += 18;
    }

    if (my_id > 0) {
        char hud[24];
        snprintf(hud, sizeof(hud), "Eres P%d", my_id);
        DrawText(hud, SCREEN_W - 80, 8, 13, YELLOW);
    } else {
        DrawText("Conectando...", SCREEN_W - 110, 8, 13, (Color){220, 140, 40, 255});
    }

    DrawRectangle(0, SCREEN_H - 28, SCREEN_W, 28, (Color){0, 0, 0, 180});
    DrawText(
        "A/D: mover  W/Espacio: salto (2x)  S: agachar  Z: atacar  X/doble-tap: dash  U: debug",
        8, SCREEN_H - 19, 11, (Color){160, 160, 200, 255}
    );

    EndDrawing();
}

/* ─── MAIN LOOP ─── */

static void MainLoop(void) {
    if (!game_ready) return;
    if (my_id < 0) my_id = ws_get_my_id();
    FetchState();
    FlushOnePlayerInit();
    DrawGame();
}

/* ─── MAIN ─── */

int main(void) {
    SCREEN_W = js_canvas_width();
    SCREEN_H = js_canvas_height();

    memset(players, 0, sizeof(players));
    InitWindow(SCREEN_W, SCREEN_H, "Arena Brawler");
    SetTargetFPS(60);

    scene_cam = (Camera){
        .position   = { 0.0f, 1.2f, 9.0f },
        .target     = { 0.0f, 1.2f, 0.0f },
        .up         = { 0.0f, 1.0f, 0.0f },
        .fovy       = 45.0f,
        .projection = CAMERA_PERSPECTIVE,
    };

    game_ready = true;
    emscripten_set_main_loop(MainLoop, 0, 1);

    for (int i = 0; i < MAX_PLAYERS; i++)
        if (players[i].active) FreePlayer(&players[i]);

    CloseWindow();
    return 0;
}