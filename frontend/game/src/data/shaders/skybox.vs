#version 100

// Input vertex attributes
attribute vec3 vertexPosition;

// Input uniform values
uniform mat4 matProjection;
uniform mat4 matView;
uniform float time;

// Output vertex attributes (to fragment shader)
varying vec3 fragPosition;

void main()
{
    // Rotacion lenta del skybox en Y (nubes moviendose)
    float angle = time * 0.008;  // ~0.5 deg/s, muy suave
    float c = cos(angle);
    float s = sin(angle);
    mat3 rot = mat3(
         c, 0.0,  s,
        0.0, 1.0, 0.0,
        -s, 0.0,  c
    );
    fragPosition = rot * vertexPosition;

    // Remove translation from the view matrix
    mat4 rotView = mat4(mat3(matView));
    vec4 clipPos = matProjection * rotView * vec4(vertexPosition, 1.0);

    // Calculate final vertex position
    gl_Position = clipPos;
}
