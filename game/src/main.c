/**
 * game/src/main.c
 *
 * Visualizador del juego con Raylib → compila a WebAssembly.
 *
 * ARQUITECTURA:
 *   Backend (Node.js)  ──WebSocket──▶  ws-client.js  ──EM_JS──▶  main.c
 *                                       (window._gameState)       (Raylib)
 *
 * EL BACKEND ES LA FUENTE DE VERDAD.
 * Este fichero solo VISUALIZA y MANDA INPUT.
 *
 * PARA CAMBIAR EL JUEGO:
 *   - Modifica GameState con los campos que necesites
 *   - Actualiza ws_get_float/ws_get_int para leer los nuevos campos
 *   - Cambia DrawGame() para dibujar tu juego
 *   - El backend (index.js) debe mandar los mismos campos
 */

#include "raylib.h"
#include <emscripten/emscripten.h>
#include <stdio.h>

/* ─── Configuración ─────────────────────────────────────── */
#define SCREEN_W   800
#define SCREEN_H   600
#define PADDLE_W   15
#define PADDLE_H   80
#define BALL_R     10

/* ─── Estado del juego (viene del backend vía WebSocket) ─── */
typedef struct {
    float ball_x;
    float ball_y;
    float p1_y;
    float p2_y;
    int   score1;
    int   score2;
} GameState;

static GameState state;
static int       initialized = 0;

/* ────────────────────────────────────────────────────────── *
 *  PUENTE JavaScript ↔ C  (EM_JS)                           *
 *                                                            *
 *  ws-client.js guarda el estado en window._gameState.      *
 *  Estas funciones leen/escriben esa variable.              *
 * ────────────────────────────────────────────────────────── */

/** Lee un float de window._gameState por nombre de campo */
EM_JS(float, ws_get_float, (const char* key), {
    const k = UTF8ToString(key);
    return (window._gameState && window._gameState[k] !== undefined)
        ? window._gameState[k]
        : 0.0;
});

/** Lee un int de window._gameState por nombre de campo */
EM_JS(int, ws_get_int, (const char* key), {
    const k = UTF8ToString(key);
    return (window._gameState && window._gameState[k] !== undefined)
        ? window._gameState[k] | 0
        : 0;
});

/** Manda input al servidor (llama a window._sendInput definido en ws-client.js) */
EM_JS(void, ws_send_input, (int player, int direction), {
    if (window._sendInput) window._sendInput(player, direction);
});

/* ─── Leer estado del servidor ──────────────────────────── */
static void FetchState(void)
{
    state.ball_x = ws_get_float("ball_x");
    state.ball_y = ws_get_float("ball_y");
    state.p1_y   = ws_get_float("p1_y");
    state.p2_y   = ws_get_float("p2_y");
    state.score1 = ws_get_int("score1");
    state.score2 = ws_get_int("score2");
}

/* ─── Manejar input local ───────────────────────────────── */
static void HandleInput(void)
{
    /* Jugador 1: W / S */
    if (IsKeyDown(KEY_W)) ws_send_input(1, -1);
    else if (IsKeyDown(KEY_S)) ws_send_input(1,  1);
    else                       ws_send_input(1,  0);

    /* Jugador 2: UP / DOWN */
    if (IsKeyDown(KEY_UP))        ws_send_input(2, -1);
    else if (IsKeyDown(KEY_DOWN)) ws_send_input(2,  1);
    else                          ws_send_input(2,  0);
}

/* ─── Dibujar el juego ──────────────────────────────────── */
static void DrawGame(void)
{
    BeginDrawing();
    ClearBackground(BLACK);

    /* Línea central */
    DrawLine(SCREEN_W / 2, 0, SCREEN_W / 2, SCREEN_H, DARKGRAY);

    /* Puntuación */
    char score_buf[32];
    snprintf(score_buf, sizeof(score_buf), "%d", state.score1);
    DrawText(score_buf, SCREEN_W / 2 - 60, 20, 40, WHITE);
    snprintf(score_buf, sizeof(score_buf), "%d", state.score2);
    DrawText(score_buf, SCREEN_W / 2 + 30, 20, 40, WHITE);

    /* Pelota */
    DrawCircle((int)state.ball_x, (int)state.ball_y, BALL_R, WHITE);

    /* Paleta jugador 1 (izquierda) */
    DrawRectangle(20, (int)state.p1_y, PADDLE_W, PADDLE_H, WHITE);

    /* Paleta jugador 2 (derecha) */
    DrawRectangle(SCREEN_W - 20 - PADDLE_W, (int)state.p2_y, PADDLE_W, PADDLE_H, WHITE);

    /* Controles (solo si aún no hay movimiento) */
    DrawText("P1: W/S    P2: UP/DOWN", 10, SCREEN_H - 20, 12, DARKGRAY);

    EndDrawing();
}

/* ─── Bucle principal (llamado por Emscripten cada frame) ── */
static void MainLoop(void)
{
    FetchState();
    HandleInput();
    DrawGame();
}

/* ─── Punto de entrada ──────────────────────────────────── */
int main(void)
{
    InitWindow(SCREEN_W, SCREEN_H, "ft_transcendence");
    SetTargetFPS(60);

    /*
     * emscripten_set_main_loop es OBLIGATORIO en WASM.
     * Reemplaza el while(!WindowShouldClose()) de Raylib normal.
     * El 0 en FPS = usa requestAnimationFrame del navegador.
     */
    emscripten_set_main_loop(MainLoop, 0, 1);

    CloseWindow();
    return 0;
}
