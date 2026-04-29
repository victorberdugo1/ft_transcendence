/**
 * game/src/main.c  –  ft_transcendence multiplayer con bones_core.h
 *
 * PROTOCOLO:
 *   Servidor → { type:"state", players:{ "7":{id,x,y,z,rotation,animation} } }
 *   Cliente → window._sendInput(dx, dz, rotation, action)
 */

#include "raylib.h"
#include "raymath.h"
#include "bones_core.h"
#include <emscripten/emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

/* ─── Config ─────────────────────────────────────────────── */
#define SCREEN_W     800
#define SCREEN_H     600
#define MAX_PLAYERS  8

/* Rutas de animaciones (preloaded en WASM vía --preload-file) */
static const char* ANIM_FILE[5]  = {
    "data/animations/idle.anim",
    "data/animations/walk.anim",
    "data/animations/jump.anim",
    "data/animations/kick.anim",
    "data/animations/punch.anim"
};
static const char* ANIM_META[5] = {
    "data/animations/idle.json",
    "data/animations/walk.json",
    "data/animations/jump.json",
    "data/animations/kick.json",
    "data/animations/punch.json"
};
static const char* ANIM_NAME[5] = { "idle","walk","jump","kick","punch" };

static int AnimIndex(const char* name) {
    for (int i = 0; i < 5; i++)
        if (strcmp(name, ANIM_NAME[i]) == 0) return i;
    return 0; /* fallback: idle */
}

/* ─── Estado ─────────────────────────────────────────────── */
typedef struct {
    int   id;
    float wx, wy, wz;
    float rotation;
    char  animation[16];
    int   active;
    int   animIndex;             /* índice en ANIM_FILE[] actual */
    AnimatedCharacter* character;
} Player;

static Player players[MAX_PLAYERS];
static int    my_id       = -1;
static float  my_rotation = 0.0f;
static Camera scene_cam;

/* ─── JS bridge ───────────────────────────────────────────── */

EM_JS(int, ws_get_my_id, (void), {
    return (window._myClientId !== undefined) ? (window._myClientId | 0) : -1;
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
        (p.x        || 0).toFixed(3),
        (p.y        || 0).toFixed(3),
        (p.z        || 0).toFixed(3),
        (p.rotation || 0).toFixed(4),
        p.animation || 'idle'
    ].join('|');
    stringToUTF8(s, buf, len);
    return 1;
});

EM_JS(void, ws_send_input, (float dx, float dz, float rotation, int action), {
    if (window._sendInput) window._sendInput(dx, dz, rotation, action);
});

/* ─── Crear / destruir jugadores ─────────────────────────── */

static void InitPlayer(Player* p, int id)
{
    p->id        = id;
    p->active    = 1;
    p->animIndex = 0;
    strncpy(p->animation, "idle", sizeof(p->animation));

    p->character = CreateAnimatedCharacter(
        "data/textures/zeta/bone_textures.txt",
        "data/textures/zeta/texture_sets.txt"
    );
    if (p->character) {
        LoadAnimation(p->character,
                      ANIM_FILE[0],   /* idle.anim */
                      ANIM_META[0]);  /* idle.json */
        LockAnimationRootXZ(p->character, true);
        SetCharacterBillboards(p->character, true, true);
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

/* ─── Parsear buffer ─────────────────────────────────────── */

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

/* ─── Leer estado del servidor ──────────────────────────── */

static void FetchState(void)
{
    int  count = ws_player_count();
    char buf[128];
    int  seen[MAX_PLAYERS] = {0};

    for (int i = 0; i < count && i < MAX_PLAYERS; i++) {
        if (!ws_get_player(i, buf, sizeof(buf))) continue;

        int   pid; float px, py, pz, prot; char panim[16];
        if (!ParsePlayer(buf, &pid, &px, &py, &pz, &prot, panim, sizeof(panim))) continue;

        /* Buscar o crear slot */
        int slot = -1;
        for (int s = 0; s < MAX_PLAYERS; s++)
            if (players[s].active && players[s].id == pid) { slot = s; break; }
        if (slot < 0)
            for (int s = 0; s < MAX_PLAYERS; s++)
                if (!players[s].active) { slot = s; break; }
        if (slot < 0) continue;

        if (!players[slot].active) InitPlayer(&players[slot], pid);

        seen[slot]            = 1;
        players[slot].wx      = px;
        players[slot].wy      = py;
        players[slot].wz      = pz;
        players[slot].rotation = prot;

        /* Cambiar animación si cambió */
        if (strncmp(players[slot].animation, panim, sizeof(players[slot].animation)) != 0) {
            strncpy(players[slot].animation, panim, sizeof(players[slot].animation));
            int ai = AnimIndex(panim);
            if (ai != players[slot].animIndex && players[slot].character) {
                LoadAnimation(players[slot].character, ANIM_FILE[ai], ANIM_META[ai]);
                players[slot].animIndex = ai;
            }
        }
    }

    /* Liberar desconectados */
    for (int s = 0; s < MAX_PLAYERS; s++)
        if (players[s].active && !seen[s]) FreePlayer(&players[s]);
}

/* ─── Input ─────────────────────────────────────────────── */

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

    ws_send_input(0.0f, dz, my_rotation, action);
}

/* ─── Dibujar ────────────────────────────────────────────── */

static void DrawGame(void)
{
    BeginDrawing();
    ClearBackground((Color){12, 12, 22, 255});

    /* Suelo 3D */
    BeginMode3D(scene_cam);
    DrawGrid(20, 0.5f);
    EndMode3D();

    /* Personajes */
    float dt = GetFrameTime();
    for (int s = 0; s < MAX_PLAYERS; s++) {
        Player* p = &players[s];
        if (!p->active || !p->character) continue;

        UpdateAnimatedCharacter(p->character, dt);

        Vector3 worldPos = { p->wx, 0.0f, p->wz };
        DrawAnimatedCharacterTransformed(p->character, scene_cam,
                                         worldPos, p->rotation);

        /* Etiqueta 2D encima del personaje */
        Vector2 screen = GetWorldToScreen(
            (Vector3){ p->wx, 1.8f, p->wz }, scene_cam);
        char label[20];
        if (p->id == my_id) snprintf(label, sizeof(label), "P%d (tu)", p->id);
        else                 snprintf(label, sizeof(label), "P%d",      p->id);
        DrawText(label, (int)screen.x - 16, (int)screen.y - 10, 12,
                 (p->id == my_id) ? YELLOW : WHITE);
    }

    /* HUD */
    DrawRectangle(0, SCREEN_H - 22, SCREEN_W, 22, (Color){0,0,0,160});
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

/* ─── Loop ───────────────────────────────────────────────── */

static void MainLoop(void)
{
    if (my_id < 0) my_id = ws_get_my_id();
    FetchState();
    HandleInput();
    DrawGame();
}

/* ─── Entrada ────────────────────────────────────────────── */

int main(void)
{
    memset(players, 0, sizeof(players));

    InitWindow(SCREEN_W, SCREEN_H, "ft_transcendence");
    SetTargetFPS(60);

    /* Cámara isométrica ligera para ver toda la arena */
    scene_cam = (Camera){
        .position   = { 0.0f, 6.0f, 10.0f },
        .target     = { 0.0f, 0.5f,  0.0f },
        .up         = { 0.0f, 1.0f,  0.0f },
        .fovy       = 50.0f,
        .projection = CAMERA_PERSPECTIVE
    };

    emscripten_set_main_loop(MainLoop, 0, 1);

    for (int i = 0; i < MAX_PLAYERS; i++)
        if (players[i].active) FreePlayer(&players[i]);
    CloseWindow();
    return 0;
}
