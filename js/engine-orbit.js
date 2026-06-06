/*
 * engine-orbit.js — OrbitMandelbrotEngine (perturbation-theory deep-zoom engine).
 *
 * Instead of iterating z = z^2 + c per pixel in single precision (which loses all
 * detail past magnification ~1e5), this engine:
 *
 *   1. Picks the screen CENTRE as a reference point C and computes its orbit
 *      Z_0=0, Z_{n+1} = Z_n^2 + C on the CPU in DOUBLE-DOUBLE precision (so the
 *      seed coordinate carries ~106 bits). Because every |Z_n| <= 2 until escape,
 *      the orbit is stored as plain float32 in a data texture.
 *   2. Per pixel writes c = C + delta (delta tiny, well-conditioned) and iterates
 *      the PERTURBATION orbit eps_{n+1} = 2*Z_n*eps_n + eps_n^2 + delta in the
 *      shader. All shader maths stays in small quantities, so single-precision
 *      float is enough — the catastrophic cancellation of the naive engine is
 *      gone. The drawn point is z_n = Z_n + eps_n.
 *
 * v1 scope: reference is always the centre, recomputed synchronously on every
 * view change (update/isReady are no-ops). No rebasing / glitch handling yet, so
 * references that escape early or pass near zero can leave artifacts at depth.
 *
 * Depends on globals from engine.js (MandelbrotEngine, createProgram) and
 * doubledouble.js (DoubleDouble, ComplexDD).
 */

/* Reference orbit lives in an RG32F texture of this fixed width; height grows to
 * hold maxIterations entries. The shader maps iteration n -> (n % W, n / W). */
const ORBIT_TEX_WIDTH = 1024;
/* Its own texture unit (the shared palette texture owns unit 1). */
const ORBIT_TEXTURE_UNIT = 2;

/* Vertex shader: same gl_VertexID fullscreen triangle as the fragment engine. */
const ORBIT_ENGINE_VS = `#version 300 es
void main() {
	vec2 verts[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
	gl_Position = vec4(verts[gl_VertexID], 0.0, 1.0);
}`;

/* Fragment shader: per-pixel perturbation iteration against the reference orbit
 * sampled from uOrbit. Colouring matches engine-fragment.js exactly so the two
 * engines are visually interchangeable at shallow zoom. */
const ORBIT_ENGINE_FS = `#version 300 es
precision highp float;

// Same std140 View block as engine-fragment.js (shared UBO, binding point 0).
layout(std140) uniform View {
	vec2  uCenter;          // unused here (centre is baked into the reference orbit)
	vec2  uResolution;      // drawing-buffer size in device pixels
	float uUnitsPerPixel;   // complex units per device pixel
	float uMaxIterations;   // unused here (loop is bounded by uOrbitLen)
	float uColorScale;      // palette cycling density
	float uTime;            // reserved
};

uniform sampler2D uPalette; // 1-D palette gradient (shared)
uniform sampler2D uOrbit;   // reference orbit: texel n = Z_n (RG = re, im)
uniform int uOrbitLen;      // number of valid Z_n entries

out vec4 fragColor;

const float BAILOUT2 = 256.0; // matches engine-fragment.js

void main() {
	// delta = c - C, the pixel's offset from the reference (the centre). Small.
	vec2 pixel = gl_FragCoord.xy - uResolution * 0.5;
	vec2 delta = pixel * uUnitsPerPixel;

	int W = textureSize(uOrbit, 0).x;
	int maxN = uOrbitLen;

	vec2 eps = vec2(0.0); // eps_0 = 0
	vec2 z = vec2(0.0);
	int i = 0;
	for (; i < maxN; i++) {
		// Z_i from the reference orbit.
		vec2 Zi = texelFetch(uOrbit, ivec2(i % W, i / W), 0).xy;

		// z_i = Z_i + eps_i. We test BEFORE advancing, so i is already the escape
		// index (hence no "+1" in the smooth term below, unlike the naive engine).
		z = Zi + eps;
		if (dot(z, z) > BAILOUT2) {
			break;
		}

		// eps_{i+1} = 2*Z_i*eps_i + eps_i^2 + delta = (2*Z_i + eps_i)*eps_i + delta.
		vec2 a = 2.0 * Zi + eps;
		eps = vec2(a.x * eps.x - a.y * eps.y, a.x * eps.y + a.y * eps.x) + delta;
	}

	if (i >= maxN) {
		// Never escaped within the reference's length -> treat as interior.
		fragColor = vec4(0.0, 0.0, 0.0, 1.0);
		return;
	}

	float mag2 = dot(z, z);
	float mu = float(i) - log2(0.5 * log2(mag2));
	float t = fract(mu * uColorScale);
	vec3 col = texture(uPalette, vec2(t, 0.5)).rgb;
	fragColor = vec4(col, 1.0);
}`;

class OrbitMandelbrotEngine extends MandelbrotEngine {
	constructor() {
		super();
		this._gl = null;
		this._program = null;
		this._orbitTex = null;
		this._orbitLenLoc = null;
		this._buffer = null;     // reused Float32Array (W * height * 2)
		this._bufHeight = 0;     // height the buffer/texture is currently sized for
		this._orbitLen = 0;      // valid entries in the current orbit
	}

	get name() {
		return "orbit-dd"; // double-double perturbation engine
	}

	init(shared) {
		const gl = shared.gl;
		this._gl = gl;
		this._program = createProgram(gl, ORBIT_ENGINE_VS, ORBIT_ENGINE_FS);

		// Wire the "View" block to the shared UBO binding point.
		const blockIndex = gl.getUniformBlockIndex(this._program, "View");
		gl.uniformBlockBinding(this._program, blockIndex, shared.viewUBO.bindingPoint);

		// Bind the samplers to their texture units (program state; persists).
		gl.useProgram(this._program);
		gl.uniform1i(gl.getUniformLocation(this._program, "uPalette"), shared.palette.unit);
		gl.uniform1i(gl.getUniformLocation(this._program, "uOrbit"), ORBIT_TEXTURE_UNIT);
		this._orbitLenLoc = gl.getUniformLocation(this._program, "uOrbitLen");
		gl.useProgram(null);

		// Orbit data texture: exact integer fetches, so NEAREST + no filtering.
		this._orbitTex = gl.createTexture();
		gl.activeTexture(gl.TEXTURE0 + ORBIT_TEXTURE_UNIT);
		gl.bindTexture(gl.TEXTURE_2D, this._orbitTex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		// 1x1 placeholder until the first orbit is computed.
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, 1, 1, 0, gl.RG, gl.FLOAT,
			new Float32Array(2));
		this._bufHeight = 0;
	}

	// Resolution arrives through the UBO; nothing screen-sized to reallocate.
	onResize(width, height) {}

	/**
	 * Recompute the reference orbit for the current view (synchronous) and upload
	 * it to the data texture.
	 */
	onViewChanged(view) {
		const maxIter = view.maxIterations;
		const height = Math.max(1, Math.ceil(maxIter / ORBIT_TEX_WIDTH));
		if (!this._buffer || this._bufHeight !== height) {
			this._buffer = new Float32Array(ORBIT_TEX_WIDTH * height * 2);
			this._bufHeight = height;
		}
		const data = this._buffer;

		// C = centre, in double-double (carries the deep-zoom precision).
		const C = new ComplexDD(view.center.re, view.center.im);
		let Z = ComplexDD.fromNumbers(0, 0);
		let n = 0;
		for (; n < maxIter; n++) {
			const zr = Z.re.toNumber();
			const zi = Z.im.toNumber();
			data[2 * n] = zr;
			data[2 * n + 1] = zi;
			if (zr * zr + zi * zi > 4.0) {
				// Reference escaped; keep this point and stop.
				n++;
				break;
			}
			Z = Z.sqrAdd(C);
		}
		this._orbitLen = n;

		const gl = this._gl;
		gl.activeTexture(gl.TEXTURE0 + ORBIT_TEXTURE_UNIT);
		gl.bindTexture(gl.TEXTURE_2D, this._orbitTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, ORBIT_TEX_WIDTH, height, 0,
			gl.RG, gl.FLOAT, data);
	}

	update(dtMs) { return false; }
	isReady() { return true; }

	render(shared) {
		const gl = shared.gl;
		gl.useProgram(this._program);
		gl.activeTexture(gl.TEXTURE0 + ORBIT_TEXTURE_UNIT);
		gl.bindTexture(gl.TEXTURE_2D, this._orbitTex);
		gl.uniform1i(this._orbitLenLoc, this._orbitLen);
		gl.bindVertexArray(shared.quad.vao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindVertexArray(null);
	}

	dispose() {
		const gl = this._gl;
		if (gl && this._program) {
			gl.deleteProgram(this._program);
			this._program = null;
		}
		if (gl && this._orbitTex) {
			gl.deleteTexture(this._orbitTex);
			this._orbitTex = null;
		}
	}
}
