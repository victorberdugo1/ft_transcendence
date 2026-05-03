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

static const char* ANIM_JSON[5] = {
    "data/animations/idle.json",
    "data/animations/walk.json",
    "data/animations/jump.json",
    "data/animations/kick.json",
    "data/animations/punch.json"
};
static const char* ANIM_META[5] = {
    "data/animations/idle.anim",
    "data/animations/walk.anim",
    "data/animations/jump.anim",
    "data/animations/kick.anim",
    "data/animations/punch.anim"
};
static const char* ANIM_NAME[5] = { "idle","walk","jump","kick","punch" };

static int AnimIndex(const char* name) {
    for (int i = 0; i < 5; i++)
        if (strcmp(name, ANIM_NAME[i]) == 0) return i;
    return 0;
}

typedef struct {
    int   id;
    float wx, wy, wz;
    float rotation;
    char  animation[16];
    int   active;
    int   animIndex;
    AnimatedCharacter* character;
    Vector3 firstAnimCenter;
    bool    hasRefCenter;
} Player;

static Player players[MAX_PLAYERS];
static int    my_id       = -1;
static float  my_rotation = 0.0f;
static Camera scene_cam;
static bool   game_ready  = false;

#define MAX_PENDING 8
static int pending_ids[MAX_PENDING];
static int pending_count = 0;

static void InitPlayer(Player* p, int id);

static void QueuePlayerInit(int id)
{
    for (int i = 0; i < pending_count; i++)
        if (pending_ids[i] == id) return;
    if (pending_count < MAX_PENDING)
        pending_ids[pending_count++] = id;
}

static void FlushOnePlayerInit(void)
{
    if (pending_count == 0) return;
    int id = pending_ids[0];
    for (int i = 1; i < pending_count; i++) pending_ids[i-1] = pending_ids[i];
    pending_count--;
    int slot = -1;
    for (int s = 0; s < MAX_PLAYERS; s++)
        if (players[s].id == id && players[s].active == 2) { slot = s; break; }
    if (slot < 0) return;
    InitPlayer(&players[slot], id);
}

static Vector3 CalcAnimCenter(const AnimationFrame* frame)
{
    if (!frame || !frame->valid || frame->personCount == 0)
        return (Vector3){0,0,0};
    Vector3 sum = {0,0,0};
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
    return valid > 0 ? Vector3Scale(sum, 1.0f / valid) : (Vector3){0,0,0};
}

static void ApplyOffsetToAnim(BonesAnimation* anim, Vector3 offset)
{
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

static bool LoadAnimWithOffset(Player* p, const char* jsonPath, const char* metaPath)
{
    if (!p || !p->character) return false;
    if (!LoadAnimation(p->character, jsonPath, metaPath)) return false;
    if (p->character->animation.isLoaded && p->character->animation.frameCount > 0) {
        Vector3 center = CalcAnimCenter(&p->character->animation.frames[0]);
        if (!p->hasRefCenter) {
            p->firstAnimCenter = center;
            p->hasRefCenter    = true;
        }
        Vector3 offset = Vector3Subtract(p->firstAnimCenter, center);
        if (Vector3Length(offset) > 0.001f)
            ApplyOffsetToAnim(&p->character->animation, offset);
        p->character->forceUpdate = true;
    }
    return true;
}

EM_JS(int, js_canvas_width, (void), {
    return (window._canvasWidth && window._canvasWidth > 0)
        ? (window._canvasWidth | 0) : 800;
});

EM_JS(int, js_canvas_height, (void), {
    return (window._canvasHeight && window._canvasHeight > 0)
        ? (window._canvasHeight | 0) : 600;
});

EM_JS(int, ws_get_my_id, (void), {
    return (window._myClientId !== undefined && window._myClientId > 0)
        ? (window._myClientId | 0) : -1;
});

EM_JS(int, ws_player_count, (void), {
    if (!window._gameState || !window._gameState.players) return 0;
    return Object.keys(window._gameState.players).length;
});

EM_JS(int, ws_get_player, (int idx, char *buf, int len), {
    if (!window._gameState || !window._gameState.players) return 0;
    const keys = Object.keys(window._gameState.players);
    if (idx >= keys.length) return 0;
    const p = window._gameState.players[keys[idx]];
    if (!p) return 0;
    const s = [
        p.id | 0,
        (p.x        !== undefined ? p.x        : 0).toFixed(3),
        (p.y        !== undefined ? p.y        : 0).toFixed(3),
        (p.z        !== undefined ? p.z        : 0).toFixed(3),
        (p.rotation !== undefined ? p.rotation : 0).toFixed(4),
        p.animation || 'idle'
    ].join('|');
    stringToUTF8(s, buf, len);
    return 1;
});

EM_JS(void, ws_send_input, (float dx, float dz, float rotation, int action), {
    if (window._sendInput) window._sendInput(dx, dz, rotation, action);
});

static void InitPlayer(Player* p, int id)
{
    int  savedAnimIndex = p->animIndex;
    char savedAnim[16];
    strncpy(savedAnim, p->animation, sizeof(savedAnim));
    savedAnim[sizeof(savedAnim) - 1] = '\0';

    memset(p, 0, sizeof(Player));
    p->id              = id;
    p->active          = 1;
    p->animIndex       = savedAnimIndex;
    p->hasRefCenter    = false;
    p->firstAnimCenter = (Vector3){0,0,0};
    strncpy(p->animation, savedAnim, sizeof(p->animation));

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

static void FreePlayer(Player* p)
{
    if (p->character) {
        DestroyAnimatedCharacter(p->character);
        p->character = NULL;
    }
    p->active = 0;
    p->id     = -1;
}

static int ParsePlayer(const char* buf, int* id,
                       float* x, float* y, float* z,
                       float* rot, char* anim, int animLen)
{
    char tmp[128];
    strncpy(tmp, buf, 127); tmp[127] = '\0';
    char* tok;
    tok = strtok(tmp, "|"); if (!tok) return 0; *id  = atoi(tok);
    tok = strtok(NULL, "|"); if (!tok) return 0; *x   = (float)atof(tok);
    tok = strtok(NULL, "|"); if (!tok) return 0; *y   = (float)atof(tok);
    tok = strtok(NULL, "|"); if (!tok) return 0; *z   = (float)atof(tok);
    tok = strtok(NULL, "|"); if (!tok) return 0; *rot = (float)atof(tok);
    tok = strtok(NULL, "|");
    strncpy(anim, tok ? tok : "idle", animLen - 1);
    anim[animLen - 1] = '\0';
    return 1;
}

static void FetchState(void)
{
    if (my_id < 0) return;

    int  count = ws_player_count();
    char buf[128];
    int  seen[MAX_PLAYERS] = {0};

    for (int i = 0; i < count && i < MAX_PLAYERS; i++) {
        if (!ws_get_player(i, buf, sizeof(buf))) continue;

        int pid; float px, py, pz, prot; char panim[16];
        if (!ParsePlayer(buf, &pid, &px, &py, &pz, &prot, panim, sizeof(panim))) continue;

        int slot = -1;
        for (int s = 0; s < MAX_PLAYERS; s++)
            if (players[s].active && players[s].id == pid) { slot = s; break; }
        if (slot < 0)
            for (int s = 0; s < MAX_PLAYERS; s++)
                if (!players[s].active) { slot = s; break; }
        if (slot < 0) continue;

        if (!players[slot].active) {
            players[slot].id     = pid;
            players[slot].active = 2;
            strncpy(players[slot].animation, panim, sizeof(players[slot].animation));
            players[slot].animIndex = AnimIndex(panim);
            QueuePlayerInit(pid);
        }

        seen[slot]             = 1;
        players[slot].wx       = px;
        players[slot].wy       = py;
        players[slot].wz       = pz;
        players[slot].rotation = prot;

        if (strncmp(players[slot].animation, panim, sizeof(players[slot].animation)) != 0) {
            int ai = AnimIndex(panim);
            bool animPlaying = players[slot].character &&
                               players[slot].character->animController &&
                               players[slot].character->animController->playing;
            bool currentIsAction = (players[slot].animIndex != 0 &&
                                    players[slot].animIndex != 1);
            if (currentIsAction && animPlaying && ai == 0) {
                strncpy(players[slot].animation, panim, sizeof(players[slot].animation));
            } else {
                strncpy(players[slot].animation, panim, sizeof(players[slot].animation));
                if (ai != players[slot].animIndex && players[slot].character) {
                    LoadAnimWithOffset(&players[slot], ANIM_JSON[ai], ANIM_META[ai]);
                    SetCharacterAutoPlay(players[slot].character, true);
                    players[slot].animIndex = ai;
                }
            }
        }
    }

    for (int s = 0; s < MAX_PLAYERS; s++)
        if (players[s].active && !seen[s]) {
            for (int q = 0; q < pending_count; q++) {
                if (pending_ids[q] == players[s].id) {
                    for (int r = q+1; r < pending_count; r++) pending_ids[r-1] = pending_ids[r];
                    pending_count--;
                    break;
                }
            }
            if (players[s].active == 1) FreePlayer(&players[s]);
            else { players[s].active = 0; players[s].id = -1; }
        }
}

static void HandleInput(void)
{
    float dt = GetFrameTime();
    float dz = 0.0f;
    int   action = 0;

    if (IsKeyDown(KEY_W) || IsKeyDown(KEY_UP))    dz =  1.0f;
    if (IsKeyDown(KEY_S) || IsKeyDown(KEY_DOWN))  dz = -1.0f;
    if (IsKeyDown(KEY_A) || IsKeyDown(KEY_LEFT))  my_rotation -= 2.5f * dt;
    if (IsKeyDown(KEY_D) || IsKeyDown(KEY_RIGHT)) my_rotation += 2.5f * dt;
    if (IsKeyPressed(KEY_SPACE)) action = 2;
    if (IsKeyPressed(KEY_Z))     action = 3;
    if (IsKeyPressed(KEY_X))     action = 4;

    while (my_rotation >  (float)M_PI) my_rotation -= 2.0f * (float)M_PI;
    while (my_rotation < -(float)M_PI) my_rotation += 2.0f * (float)M_PI;

    ws_send_input(0.0f, dz, my_rotation, action);
}

static void DrawGame(void)
{
    for (int s = 0; s < MAX_PLAYERS; s++) {
        if (!players[s].active || players[s].id != my_id) continue;
        scene_cam.target   = (Vector3){ players[s].wx, 0.5f, players[s].wz };
        scene_cam.position = (Vector3){ players[s].wx, 3.0f, players[s].wz + 4.5f };
        break;
    }

    BeginDrawing();
    ClearBackground((Color){12, 12, 22, 255});

    BeginMode3D(scene_cam);
    DrawGrid(20, 0.5f);
    EndMode3D();

    float dt = GetFrameTime();
    for (int s = 0; s < MAX_PLAYERS; s++) {
        Player* p = &players[s];
        if (p->active != 1 || !p->character) continue;

        if (p->character->currentFrame < 0 ||
            p->character->currentFrame >= p->character->animation.frameCount)
        {
            p->character->currentFrame = 0;
            p->character->forceUpdate  = true;
        }

        UpdateAnimatedCharacter(p->character, dt);

        if (p->character->animController &&
            !p->character->animController->playing &&
            p->animIndex != 0)
        {
            strncpy(p->animation, "idle", sizeof(p->animation));
            p->animIndex = 0;
            LoadAnimWithOffset(p, ANIM_JSON[0], ANIM_META[0]);
            SetCharacterAutoPlay(p->character, true);
        }

        Vector3 worldPos = { p->wx, 0.0f, p->wz };
        DrawAnimatedCharacterTransformed(p->character, scene_cam, worldPos, p->rotation);

        Vector2 screen = GetWorldToScreen((Vector3){ p->wx, 1.8f, p->wz }, scene_cam);
        char label[20];
        if (p->id == my_id) snprintf(label, sizeof(label), "P%d (tu)", p->id);
        else                 snprintf(label, sizeof(label), "P%d",      p->id);
        DrawText(label, (int)screen.x - 16, (int)screen.y - 10, 12,
                 (p->id == my_id) ? YELLOW : WHITE);
    }

    DrawRectangle(0, SCREEN_H - 22, SCREEN_W, SCREEN_W, (Color){0,0,0,160});
    DrawText("W/S: mover   A/D: girar   SPACE: jump   Z: kick   X: punch",
             8, SCREEN_H - 15, 11, (Color){160,160,180,255});

    if (my_id > 0) {
        char hud[24];
        snprintf(hud, sizeof(hud), "Jugador %d", my_id);
        DrawText(hud, SCREEN_W - 80, 8, 12, YELLOW);
    } else {
        DrawText("Conectando...", SCREEN_W - 100, 8, 12, (Color){220,140,40,255});
    }

    EndDrawing();
}

static void MainLoop(void)
{
    if (!game_ready) return;
    if (my_id < 0) my_id = ws_get_my_id();
    FetchState();
    FlushOnePlayerInit();
    HandleInput();
    DrawGame();
}

int main(void)
{
    SCREEN_W = js_canvas_width();
    SCREEN_H = js_canvas_height();

    memset(players, 0, sizeof(players));
    InitWindow(SCREEN_W, SCREEN_H, "ft_transcendence");
    SetTargetFPS(60);

    scene_cam = (Camera){
        .position   = { 0.0f, 3.0f, 4.5f },
        .target     = { 0.0f, 0.5f, 0.0f },
        .up         = { 0.0f, 1.0f, 0.0f },
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
