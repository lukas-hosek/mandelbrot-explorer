/*
 * engine-fragment.js — FragmentMandelbrotEngine.
 *
 * The trivial engine: the whole Mandelbrot escape-time iteration runs in the
 * fragment shader, in single precision (highp float), with no acceleration
 * tricks. Everything it needs arrives through the shared view UBO and palette
 * texture, so render() is just "bind program + draw one fullscreen triangle".
 *
 * Single precision is the deliberate, accepted limitation here: visible detail
 * degrades into pixelation past a magnification of roughly 1e5. A future
 * CPU-assisted engine (e.g. perturbation theory) is what will address deep
 * zoom; it slots in behind the same MandelbrotEngine interface.
 *
 * Depends on globals from engine.js (MandelbrotEngine, createProgram).
 */

/* Vertex shader: a single oversized triangle that covers the screen, generated
 * purely from gl_VertexID — no vertex buffer required (the shared quad VAO is
 * empty and simply provides attribute state). */
const FRAG_ENGINE_VS = `#version 300 es
void main() {
	// (-1,-1), (3,-1), (-1,3) — covers the [-1,1] clip square with one triangle.
	vec2 verts[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
	gl_Position = vec4(verts[gl_VertexID], 0.0, 1.0);
}`;

/* Fragment shader: escape-time iteration + smooth (continuous) colouring,
 * sampling the 1-D palette texture. */
const FRAG_ENGINE_FS = `#version 300 es
precision highp float;

// The "constant buffer": std140 view block, bound to a fixed binding point.
layout(std140) uniform View {
	vec2  uCenter;          // complex coord at the centre of the drawing buffer
	vec2  uResolution;      // drawing-buffer size in device pixels
	float uUnitsPerPixel;   // complex units per device pixel
	float uMaxIterations;   // iteration cap (cast to int below)
	float uColorScale;      // palette cycling density (cycles per iteration)
	float uTime;            // reserved (animated palettes, unused for now)
};

uniform sampler2D uPalette; // size x 1 RGBA gradient

out vec4 fragColor;

// Bailout radius squared. A generous value (256) makes the smooth-iteration
// term well-behaved and the colour bands clean.
const float BAILOUT2 = 256.0;

void main() {
	// gl_FragCoord origin is bottom-left, so the imaginary axis points up.
	vec2 pixel = gl_FragCoord.xy - uResolution * 0.5;
	vec2 c = uCenter + pixel * uUnitsPerPixel;

	int maxIter = int(uMaxIterations);
	vec2 z = vec2(0.0);
	int i = 0;
	for (; i < maxIter; i++) {
		// z = z^2 + c
		z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
		if (dot(z, z) > BAILOUT2) {
			break;
		}
	}

	if (i >= maxIter) {
		// Interior of the set.
		fragColor = vec4(0.0, 0.0, 0.0, 1.0);
		return;
	}

	// Continuous iteration count (normalized iteration / fractional escape),
	// the standard smooth-colouring formula. Avoids integer banding.
	float mag2 = dot(z, z);
	float mu = float(i) + 1.0 - log2(0.5 * log2(mag2));

	// Map to a repeating palette coordinate. uColorScale sets band density and
	// is intentionally independent of maxIter so banding stays visually stable
	// as the adaptive iteration count climbs with zoom.
	float t = fract(mu * uColorScale);
	vec3 col = texture(uPalette, vec2(t, 0.5)).rgb;
	fragColor = vec4(col, 1.0);
}`;

class FragmentMandelbrotEngine extends MandelbrotEngine {
	constructor() {
		super();
		this._program = null;
		this._gl = null;
	}

	get name() {
		return "fragment-sp"; // single-precision fragment engine
	}

	init(shared) {
		const gl = shared.gl;
		this._gl = gl;
		this._program = createProgram(gl, FRAG_ENGINE_VS, FRAG_ENGINE_FS);

		// Wire the program's "View" uniform block to the shared UBO binding point.
		const blockIndex = gl.getUniformBlockIndex(this._program, "View");
		gl.uniformBlockBinding(this._program, blockIndex, shared.viewUBO.bindingPoint);

		// Point the palette sampler at the shared texture unit (set once;
		// sampler uniforms are program state, so this persists with the program).
		gl.useProgram(this._program);
		const paletteLoc = gl.getUniformLocation(this._program, "uPalette");
		gl.uniform1i(paletteLoc, shared.palette.unit);
		gl.useProgram(null);
	}

	// This engine is fully driven by the UBO; nothing to precompute or resize.
	onViewChanged(view) {}
	onResize(width, height) {}
	update(dtMs) { return false; }
	isReady() { return true; }

	render(shared) {
		const gl = shared.gl;
		gl.useProgram(this._program);
		gl.bindVertexArray(shared.quad.vao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindVertexArray(null);
	}

	dispose() {
		if (this._gl && this._program) {
			this._gl.deleteProgram(this._program);
			this._program = null;
		}
	}
}
