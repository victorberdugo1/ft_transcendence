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
    int   id;
    float wx, wy;
    float rotation;
    char  animation[16];
    int   active;
    int   animIndex;
    int   stocks;
    bool  respawning;
    bool  crouching;
    int   hitId;
    float visualRotation;   /* rotación interpolada para el giro suave */
    AnimatedCharacter* character;
    /* Centro de la primera animación cargada (idle) — referencia fija para todas.
     * Igual estrategia que el proyecto de referencia: en vez de recalcular el
     * anchor por animación, desplazamos los huesos de cada anim nueva para que
     * su centro coincida con el de idle. anchorYOffset se fija una vez y no varía. */
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

/*
 * FIX PRINCIPAL:
 * LoadAnimWithOffset ahora NO toca el offset Y de la animación.
 * El Y se gestiona en DrawGame restando anchorYOffset del worldPos,
 * así bones_core nunca acumula drift vertical entre cambios de animación.
 */
static bool LoadAnimWithOffset(Player* p, const char* jsonPath, const char* metaPath) {
    if (!p || !p->character) return false;
    if (!LoadAnimation(p->character, jsonPath, metaPath)) return false;

    if (p->character->animation.isLoaded && p->character->animation.frameCount > 0) {
        BonesAnimation* anim = &p->character->animation;

        /* Estabilizar X entre frames */
        StabilizeAnimX(anim);

        /* Centro de tobillos en frame 0 (fallback: centro de todos los huesos) */
        Vector3 thisCenter = {0, 0, 0};
        bool hasCtr = CalcAnkleMidPoint(&anim->frames[0], &thisCenter);
        if (!hasCtr) thisCenter = CalcAnimCenter(&anim->frames[0]);

        if (!p->hasReferenceCenter) {
            /*
             * PRIMERA ANIMACIÓN (idle):
             * Guardamos su centro como referencia absoluta.
             * Centramos en X/Z igual que antes; el Y del centro se convierte
             * en anchorYOffset fijo — no cambiará nunca más.
             */
            Vector3 xzOffset = { -thisCenter.x, 0.0f, -thisCenter.z };
            if (fabsf(xzOffset.x) > 0.001f || fabsf(xzOffset.z) > 0.001f)
                ApplyOffsetToAnim(anim, xzOffset);

            /* Recalcular centro tras el desplazamiento X/Z */
            hasCtr = CalcAnkleMidPoint(&anim->frames[0], &thisCenter);
            if (!hasCtr) thisCenter = CalcAnimCenter(&anim->frames[0]);

            p->referenceCenter    = thisCenter;   /* x≈0, z≈0, y=suelo de idle  */
            p->hasReferenceCenter = true;
            p->anchorYOffset      = thisCenter.y;
            p->hasAnchorY         = true;
        } else {
            /*
             * ANIMACIONES SIGUIENTES (walk, jump, punch…):
             * Calculamos el delta entre el centro de referencia (idle) y el
             * centro de esta animación, y lo aplicamos a TODOS los huesos
             * (X, Y y Z). Así todos los estados quedan en el mismo espacio
             * visual y no hay saltos al cambiar de animación.
             * Estrategia idéntica a Player_LoadAnimation del proyecto de referencia.
             */
            Vector3 delta = Vector3Subtract(p->referenceCenter, thisCenter);
            if (Vector3Length(delta) > 0.001f)
                ApplyOffsetToAnim(anim, delta);
        }

        p->character->forceUpdate = true;
    }
    return true;
}

/* ─── JS BRIDGE ─── */

EM_JS(int, js_canvas_width,  (void), { return (window._canvasWidth  > 0) ? (window._canvasWidth  | 0) : 800; });
EM_JS(int, js_canvas_height, (void), { return (window._canvasHeight > 0) ? (window._canvasHeight | 0) : 600; });
EM_JS(int, ws_get_my_id,     (void), { return (window._myClientId   > 0) ? (window._myClientId   | 0) : -1;  });

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
        (p.x         ?? 0).toFixed(3),
        (p.y         ?? 0).toFixed(3),
        (p.rotation  ?? 0).toFixed(4),
        p.animation  || 'idle',
        p.stocks     ?? 3,
        p.respawning ? 1 : 0,
        p.hitId      ?? 0,
        p.crouching  ? 1 : 0,
    ].join('|');
    stringToUTF8(s, buf, len);
    return 1;
});

/* ─── INIT / FREE PLAYER ─── */

static void InitPlayer(Player* p, int id) {
    int  savedAnimIndex = p->animIndex;
    char savedAnim[16];
    strncpy(savedAnim, p->animation, sizeof(savedAnim));
    savedAnim[sizeof(savedAnim) - 1] = '\0';

    float savedX       = p->wx;
    float savedY       = p->wy;
    float savedRot     = p->rotation;
    int   savedStocks  = p->stocks > 0 ? p->stocks : 3;
    int   savedHitId   = p->hitId;
    float savedAnchorY        = p->anchorYOffset;
    bool  savedHasAY          = p->hasAnchorY;
    Vector3 savedRefCenter    = p->referenceCenter;
    bool    savedHasRefCenter = p->hasReferenceCenter;

    memset(p, 0, sizeof(Player));
    p->id                = id;
    p->active            = 1;
    p->animIndex         = savedAnimIndex;
    p->wx                = savedX;
    p->wy                = savedY;
    p->rotation          = savedRot;
    p->stocks            = savedStocks;
    p->hitId             = savedHitId;
    p->anchorYOffset     = savedAnchorY;
    p->hasAnchorY        = savedHasAY;
    p->referenceCenter   = savedRefCenter;
    p->hasReferenceCenter = savedHasRefCenter;
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
    p->id     = -1;
}

/* ─── PARSE PLAYER ─── */

static int ParsePlayer(const char* buf,
                       int* id, float* x, float* y, float* rot,
                       char* anim, int animLen,
                       int* stocks, int* respawning, int* hitId, int* crouching)
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
    return 1;
}

/* ─── FETCH STATE ─── */

static void FetchState(void) {
    if (my_id < 0) return;

    int  count = ws_player_count();
    char buf[256];
    int  seen[MAX_PLAYERS] = {0};

    for (int i = 0; i < count && i < MAX_PLAYERS; i++) {
        if (!ws_get_player(i, buf, sizeof(buf))) continue;

        int   pid, pstocks, prespawning, phitId, pcrouching;
        float px, py, prot;
        char  panim[16];
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
            players[slot].id        = pid;
            players[slot].active    = 2;
            players[slot].animIndex = AnimIndex(panim);
            strncpy(players[slot].animation, panim, sizeof(players[slot].animation));
            players[slot].animation[sizeof(players[slot].animation) - 1] = '\0';
            QueuePlayerInit(pid);
        }

        seen[slot]              = 1;
        players[slot].wx        = px;
        players[slot].wy        = py;
        players[slot].rotation  = prot;
        /* Al aparecer por primera vez sincronizamos la visual para no girar desde 0 */
        if (players[slot].active == 2) players[slot].visualRotation = prot;
        players[slot].stocks    = pstocks;
        players[slot].respawning = prespawning;
        players[slot].crouching = pcrouching;

        if (strncmp(players[slot].animation, panim, sizeof(players[slot].animation)) != 0) {
            int ai = AnimIndex(panim);
            if (ai != players[slot].animIndex && players[slot].character) {
                LoadAnimWithOffset(&players[slot], ANIM_JSON[ai], ANIM_META[ai]);
                SetCharacterAutoPlay(players[slot].character, true);
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

/* ─── CONSTANTES DE ESCENA ─── */

#define STAGE_LEFT    -8.0f
#define STAGE_RIGHT    8.0f
#define STAGE_Y       -0.05f
#define PLATFORM_H     0.12f
#define ATTACK_RANGE   0.6f
#define ATTACK_RANGE_Y 0.4f

/* ─── DRAW ─── */

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

    /* Plataforma principal */
    DrawCube((Vector3){0.0f, STAGE_Y, 0.0f},
             STAGE_RIGHT - STAGE_LEFT, PLATFORM_H, 0.6f,
             (Color){60, 60, 90, 255});
    DrawCubeWires((Vector3){0.0f, STAGE_Y, 0.0f},
                  STAGE_RIGHT - STAGE_LEFT, PLATFORM_H, 0.6f,
                  (Color){100, 100, 160, 200});

    /* Plataformas flotantes */
    float platW = 2.4f, platH = 0.1f;
    DrawCube((Vector3){-4.0f, 1.6f, 0.0f}, platW, platH, 0.5f, (Color){50, 70, 110, 255});
    DrawCube((Vector3){ 4.0f, 1.6f, 0.0f}, platW, platH, 0.5f, (Color){50, 70, 110, 255});
    DrawCube((Vector3){ 0.0f, 2.8f, 0.0f}, platW, platH, 0.5f, (Color){50, 70, 110, 255});

    EndMode3D();

    float dt = GetFrameTime();
    if (IsKeyPressed(KEY_U)) debug_mode = !debug_mode;

    for (int s = 0; s < MAX_PLAYERS; s++) {
        Player* p = &players[s];
        if (p->active != 1 || !p->character || p->respawning) continue;

        if (p->character->currentFrame < 0 ||
            p->character->currentFrame >= p->character->animation.frameCount) {
            p->character->currentFrame = 0;
            p->character->forceUpdate  = true;
        }

        UpdateAnimatedCharacter(p->character, dt);

        /* Volver a idle cuando una animación de acción termina */
        if (p->character->animController && !p->character->animController->playing) {
            if (p->animIndex == 6) {
                /* crouch: congelar en último frame */
                int last = p->character->animation.frameCount - 1;
                if (last < 0) last = 0;
                p->character->currentFrame = last;
                p->character->forceUpdate  = true;
                SetCharacterAutoPlay(p->character, false);
            } else if (p->animIndex != 0) {
                strncpy(p->animation, "idle", sizeof(p->animation));
                p->animation[sizeof(p->animation) - 1] = '\0';
                p->animIndex = 0;
                LoadAnimWithOffset(p, ANIM_JSON[0], ANIM_META[0]);
                SetCharacterAutoPlay(p->character, true);
            }
        }

        /*
         * FIX ANCHOR DRIFT:
         * Neutralizamos el autoCenter de bones_core en X y Z
         * (bones_core los usa para centrar el pivot de rotación),
         * y en Y pasamos worldPos.y ajustado con anchorYOffset para que
         * el suelo visual coincida siempre con wy del servidor.
         *
         * Se hace ANTES de DrawAnimatedCharacterTransformed porque esa
         * función lee character->autoCenter como pivot interno.
         */
        if (p->character->autoCenterCalculated) {
            p->character->autoCenter.x = 0.0f;
            p->character->autoCenter.z = 0.0f;
            /* Y: dejamos que bones_core lo calcule normalmente;
               lo compensamos en worldPos (ver abajo). */
        }

        /*
         * worldPos.y = wy del servidor - anchorYOffset
         * De esta forma el personaje siempre toca el suelo donde
         * el servidor dice, independientemente de la animación activa.
         */
        float visualY = p->wy - (p->hasAnchorY ? p->anchorYOffset : 0.0f);
        Vector3 worldPos = (Vector3){ p->wx, visualY, 0.0f };

        /*
         * GIRO SUAVE:
         * Interpolamos visualRotation hacia rotation (objetivo del servidor).
         * Velocidad de giro ajustable con TURN_SPEED (radianes/segundo).
         * Para el efecto cara/espalda usamos el componente Y del draw:
         *   - mirando derecha (rotation ≈ 0):   scale.x = +1 → cara al frente
         *   - mirando izquierda (rotation ≈ π): scale.x = -1 → espejo = espalda
         * El lerp hace la transición visible en lugar de instantánea.
         */
        const float TURN_SPEED = 12.0f;   /* rad/s — ajusta a tu gusto */
        {
            float target = p->rotation;   /* 0 = derecha, π = izquierda */
            float cur    = p->visualRotation;

            /* Diferencia angular en [-π, π] para el camino más corto */
            float diff = target - cur;
            while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
            while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;

            float step = TURN_SPEED * dt;
            if (fabsf(diff) <= step) p->visualRotation = target;
            else                     p->visualRotation  = cur + (diff > 0 ? step : -step);
        }

        float drawRot = p->visualRotation + (float)M_PI_2;
        DrawAnimatedCharacterTransformed(p->character, scene_cam, worldPos, drawRot);
    }

    /* ─── DEBUG ─── */
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
            Vector3 wp   = (Vector3){ p->wx, p->wy, 0.0f };
            Color   cc   = (p->id == my_id) ? (Color){0, 255, 100, 220} : (Color){255, 80, 80, 220};

            DrawCubeWires((Vector3){wp.x, wp.y + 0.36f, 0.0f}, 0.48f, 0.72f, 0.05f, cc);
            DrawSphere(wp, 0.06f, cc);

            if (strncmp(p->animation, "punch", 5) == 0 ||
                strncmp(p->animation, "kick",  4) == 0) {
                float facing = (p->visualRotation < 1.0f) ? 1.0f : -1.0f;
                DrawCubeWires(
                    (Vector3){ wp.x + facing * (ATTACK_RANGE * 0.5f), wp.y + ATTACK_RANGE_Y * 0.5f, 0.0f },
                    ATTACK_RANGE, ATTACK_RANGE_Y, 0.05f,
                    (Color){255, 255, 0, 220});
            }
        }
        EndMode3D();
    }

    /* ─── HUD ─── */
    int hudY = 8;
    for (int s = 0; s < MAX_PLAYERS; s++) {
        Player* p = &players[s];
        if (!p->active) continue;
        char hud[32];
        snprintf(hud, sizeof(hud), "P%d: %d stocks", p->id, p->stocks);
        Color c = (p->id == my_id) ? YELLOW : WHITE;
        DrawText(hud, 8, hudY, 12, c);
        hudY += 16;
    }

    if (my_id > 0) {
        char txt[24]; snprintf(txt, sizeof(txt), "Jugador %d", my_id);
        DrawText(txt, SCREEN_W - 80, 8, 12, YELLOW);
    } else {
        DrawText("Conectando...", SCREEN_W - 100, 8, 12, (Color){220, 140, 40, 255});
    }

    DrawRectangle(0, SCREEN_H - 22, SCREEN_W, 22, (Color){0, 0, 0, 160});
    DrawText("A/D: mover   W: saltar   Z: atacar   X: dash   S: agachar",
             8, SCREEN_H - 15, 11, (Color){160, 160, 180, 255});

    EndDrawing();
}

/* ─── MAIN LOOP ─── */

static void MainLoop(void) {
    if (!game_ready) return;
    if (my_id < 0) my_id = ws_get_my_id();

    SCREEN_W = js_canvas_width();
    SCREEN_H = js_canvas_height();

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