/*
 * engine-orbit.js — OrbitMandelbrotEngine (perturbation-theory deep-zoom engine).
 *
 * Instead of iterating z = z^2 + c per pixel in single precision (which loses all
 * detail past magnification ~1e5), this engine:
 *
 *   1. Picks a REFERENCE point C on screen and computes its orbit Z_0=0,
 *      Z_{n+1} = Z_n^2 + C on the CPU in DOUBLE-DOUBLE precision (so the seed
 *      coordinate carries ~106 bits). Because every |Z_n| <= 2 until escape, the
 *      orbit is stored as plain float32 in a data texture. The reference is chosen
 *      by a coarse central-first SCAN of the screen (_pickReference) so it stays
 *      bounded for the full iteration count where possible — an interior reference
 *      keeps the per-pixel epsilon small everywhere. Its pixel offset from the
 *      screen centre is handed to the shader as uRefPixel.
 *   2. Per pixel writes c = C + delta (delta tiny, well-conditioned) and iterates
 *      the PERTURBATION orbit eps_{n+1} = 2*Z_n*eps_n + eps_n^2 + delta in the
 *      shader. All shader maths stays in small quantities, so single-precision
 *      float is enough — the catastrophic cancellation of the naive engine is
 *      gone. The drawn point is z_n = Z_n + eps_n. The shader REBASES (Zhuoran):
 *      when the reference stops dominating (|z| < |eps|) or runs off its end, it
 *      restarts the reference at Z_0=0 and folds the full value into eps, so the
 *      loop runs the full maxIter regardless of reference length and near-zero
 *      glitches are handled.
 *
 * Synchronous engine: the reference scan + orbit recompute run in onViewChanged
 * (sub-ms to a few ms), so update/isReady stay no-ops.
 *
 * Depends on globals from engine.js (MandelbrotEngine, createProgram) and
 * doubledouble.js (DoubleDouble, ComplexDD).
 */

/* Reference orbit lives in an RG32F texture of this fixed width; height grows to
 * hold maxIterations entries. The shader maps iteration n -> (n % W, n / W). */
const ORBIT_TEX_WIDTH = 1024;
/* Its own texture unit (the shared palette texture owns unit 1). */
const ORBIT_TEXTURE_UNIT = 2;
/* Reference scan: probe an N x N grid of screen points (plus the exact centre)
 * and keep the most central one whose orbit does not escape within maxIter. */
const REF_SCAN_GRID = 8;

/* Vertex shader: same gl_VertexID fullscreen triangle as the fragment engine. */
const ORBIT_ENGINE_VS = `#version 300 es
void main() {
	vec2 verts[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
	gl_Position = vec4(verts[gl_VertexID], 0.0, 1.0);
}`;

/* Fragment shader: per-pixel perturbation iteration against the reference orbit
 * sampled from uOrbit, with Zhuoran rebasing. Colouring matches engine-fragment.js
 * exactly so the two engines are visually interchangeable at shallow zoom. */
const ORBIT_ENGINE_FS = `#version 300 es
precision highp float;

// Same std140 View block as engine-fragment.js (shared UBO, binding point 0).
layout(std140) uniform View {
	vec2  uCenter;          // unused here (centre is baked into the reference orbit)
	vec2  uResolution;      // drawing-buffer size in device pixels
	float uUnitsPerPixel;   // complex units per device pixel
	float uMaxIterations;   // escape-time cap (bounds the per-pixel loop)
	float uColorScale;      // palette cycling density
	float uTime;            // reserved
};

uniform sampler2D uPalette; // 1-D palette gradient (shared)
uniform sampler2D uOrbit;   // reference orbit: texel n = Z_n (RG = re, im)
uniform int uOrbitLen;      // number of valid Z_n entries
uniform vec2 uRefPixel;     // reference's device-pixel offset from the screen centre

out vec4 fragColor;

const float BAILOUT2 = 256.0; // matches engine-fragment.js

void main() {
	// delta = c - C, the pixel's offset from the REFERENCE point (not the centre).
	// uRefPixel shifts the origin from the screen centre to the chosen reference.
	vec2 pixel = gl_FragCoord.xy - uResolution * 0.5 - uRefPixel;
	vec2 delta = pixel * uUnitsPerPixel;

	int W = textureSize(uOrbit, 0).x;
	int orbitLen = uOrbitLen;
	int maxIter = int(uMaxIterations);

	vec2 dz = vec2(0.0); // perturbation eps; invariant z = Z[m] + dz = z_n
	int m = 0;           // reference index, decoupled from the iteration count
	vec2 z = vec2(0.0);
	int n = 0;           // true iteration count (escape time)
	for (; n < maxIter; n++) {
		vec2 Zm = texelFetch(uOrbit, ivec2(m % W, m / W), 0).xy;

		// z_n = Z[m] + dz. Test BEFORE advancing, so n is already the escape index
		// (hence no "+1" in the smooth term below, unlike the naive engine).
		z = Zm + dz;
		if (dot(z, z) > BAILOUT2) {
			break;
		}

		// Zhuoran rebasing: when the reference no longer dominates (|z| < |dz|, the
		// near-zero glitch case) or we are about to run off the stored orbit,
		// restart the reference at Z[0]=0 and fold the full value into dz. Since
		// Z[0]=0 this leaves z unchanged, and the recurrence stays exact.
		if (dot(z, z) < dot(dz, dz) || m + 1 >= orbitLen) {
			dz = z;
			m = 0;
			Zm = vec2(0.0); // Z[0]
		}

		// eps_{n+1} = 2*Z[m]*dz + dz^2 + delta = (2*Z[m] + dz)*dz + delta.
		vec2 a = 2.0 * Zm + dz;
		dz = vec2(a.x * dz.x - a.y * dz.y, a.x * dz.y + a.y * dz.x) + delta;
		m++;
	}

	if (n >= maxIter) {
		// Never escaped within the iteration cap -> treat as interior.
		fragColor = vec4(0.0, 0.0, 0.0, 1.0);
		return;
	}

	float mag2 = dot(z, z);
	float mu = float(n) - log2(0.5 * log2(mag2));
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
		this._refPixelLoc = null;
		this._buffer = null;     // reused Float32Array (W * height * 2)
		this._bufHeight = 0;     // height the buffer/texture is currently sized for
		this._orbitLen = 0;      // valid entries in the current orbit
		this._refPx = 0;         // chosen reference's device-pixel offset from centre
		this._refPy = 0;
		this._viewW = 1;         // drawing-buffer size in device px (for the scan)
		this._viewH = 1;
	}

	get name() {
		return "orbit-dd"; // double-double perturbation engine
	}

	init(shared) {
		const gl = shared.gl;
		this._gl = gl;
		this._program = createProgram(gl, ORBIT_ENGINE_VS, ORBIT_ENGINE_FS);
		this._viewW = shared.viewport.width;
		this._viewH = shared.viewport.height;

		// Wire the "View" block to the shared UBO binding point.
		const blockIndex = gl.getUniformBlockIndex(this._program, "View");
		gl.uniformBlockBinding(this._program, blockIndex, shared.viewUBO.bindingPoint);

		// Bind the samplers to their texture units (program state; persists).
		gl.useProgram(this._program);
		gl.uniform1i(gl.getUniformLocation(this._program, "uPalette"), shared.palette.unit);
		gl.uniform1i(gl.getUniformLocation(this._program, "uOrbit"), ORBIT_TEXTURE_UNIT);
		this._orbitLenLoc = gl.getUniformLocation(this._program, "uOrbitLen");
		this._refPixelLoc = gl.getUniformLocation(this._program, "uRefPixel");
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

	// Resolution arrives through the UBO for drawing, but the reference scan needs
	// the screen extent in device px, so cache it here.
	onResize(width, height) {
		this._viewW = width;
		this._viewH = height;
	}

	/**
	 * Recompute the reference orbit for the current view (synchronous) and upload
	 * it to the data texture. Orchestration only — see the helpers below.
	 */
	onViewChanged(view) {
		const maxIter = view.maxIterations;
		const ref = this._pickReference(view);
		this._refPx = ref.px;
		this._refPy = ref.py;
		const height = this._ensureBuffer(maxIter);
		this._orbitLen = this._computeReferenceOrbit(ref.C, maxIter);
		this._uploadOrbit(height);
	}

	/* ---- reference selection ---- */

	/**
	 * Choose a reference point for the current view. Scans the screen centre first,
	 * then an REF_SCAN_GRID x REF_SCAN_GRID grid sorted by distance from the centre,
	 * and keeps the longest-surviving candidate — early-accepting the first one that
	 * does not escape within maxIter (interior). Central-first means the common
	 * "centre is in the set" case probes a single orbit.
	 * @returns {{C: ComplexDD, px: number, py: number}} reference + its device-pixel
	 *   offset from the screen centre (gl_FragCoord orientation, y up).
	 */
	_pickReference(view) {
		const maxIter = view.maxIterations;
		const upp = view.unitsPerPixel;
		const candidates = this._candidateOffsets(this._viewW, this._viewH);

		let best = null;
		let bestLen = -1;
		for (let k = 0; k < candidates.length; k++) {
			const px = candidates[k].px;
			const py = candidates[k].py;
			// C = centre + pixel-offset * upp, in double-double (deep-zoom precision).
			const C = new ComplexDD(
				view.center.re.addNumber(px * upp),
				view.center.im.addNumber(py * upp));
			const len = this._escapeLength(C, maxIter);
			if (len > bestLen) {
				bestLen = len;
				best = { C: C, px: px, py: py };
			}
			if (len >= maxIter) {
				// Non-escaping (interior); central-first, so this is good enough.
				break;
			}
		}
		return best;
	}

	/**
	 * Candidate pixel offsets from the screen centre (device px, y up): the exact
	 * centre first, then a cell-centred grid, the whole list sorted by distance from
	 * the centre.
	 * @returns {Array<{px:number, py:number}>}
	 */
	_candidateOffsets(width, height) {
		const list = [{ px: 0, py: 0 }];
		const G = REF_SCAN_GRID;
		for (let j = 0; j < G; j++) {
			for (let i = 0; i < G; i++) {
				const px = ((i + 0.5) / G - 0.5) * width;
				const py = ((j + 0.5) / G - 0.5) * height;
				list.push({ px: px, py: py });
			}
		}
		list.sort((a, b) => (a.px * a.px + a.py * a.py) - (b.px * b.px + b.py * b.py));
		return list;
	}

	/* ---- reference orbit computation ---- */

	/**
	 * Iterate C's orbit in double-double up to maxIter, returning the escape length
	 * (or maxIter if it never escapes). No storage — used to probe scan candidates.
	 */
	_escapeLength(C, maxIter) {
		let Z = ComplexDD.fromNumbers(0, 0);
		for (let n = 0; n < maxIter; n++) {
			const rr = Z.re.mul(Z.re);
			const ii = Z.im.mul(Z.im);
			if (rr.add(ii).toNumber() > 4.0) {
				return n;
			}
			const ri = Z.re.mul(Z.im);
			Z = new ComplexDD(
				rr.sub(ii).add(C.re),
				ri.add(ri).add(C.im));
		}
		return maxIter;
	}

	/**
	 * Compute C's orbit in double-double, writing each Z_n as float32 into
	 * this._buffer. Returns the number of stored entries (the orbit length).
	 */
	_computeReferenceOrbit(C, maxIter) {
		const data = this._buffer;
		let Z = ComplexDD.fromNumbers(0, 0);
		let n = 0;
		for (; n < maxIter; n++) {
			const zr = Z.re.toNumber();
			const zi = Z.im.toNumber();
			data[2 * n] = zr;
			data[2 * n + 1] = zi;
			const rr = Z.re.mul(Z.re);
			const ii = Z.im.mul(Z.im);
			if (rr.add(ii).toNumber() > 4.0) {
				// Reference escaped; keep this point and stop.
				n++;
				break;
			}
			const ri = Z.re.mul(Z.im);
			Z = new ComplexDD(
				rr.sub(ii).add(C.re),
				ri.add(ri).add(C.im));
		}
		return n;
	}

	/* ---- GPU buffer / texture ---- */

	/** Allocate (or grow) the orbit buffer for maxIter entries; returns its height. */
	_ensureBuffer(maxIter) {
		const height = Math.max(1, Math.ceil(maxIter / ORBIT_TEX_WIDTH));
		if (!this._buffer || this._bufHeight !== height) {
			this._buffer = new Float32Array(ORBIT_TEX_WIDTH * height * 2);
			this._bufHeight = height;
		}
		return height;
	}

	/** Upload the current orbit buffer into the RG32F data texture. */
	_uploadOrbit(height) {
		const gl = this._gl;
		gl.activeTexture(gl.TEXTURE0 + ORBIT_TEXTURE_UNIT);
		gl.bindTexture(gl.TEXTURE_2D, this._orbitTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, ORBIT_TEX_WIDTH, height, 0,
			gl.RG, gl.FLOAT, this._buffer);
	}

	update(dtMs) { return false; }
	isReady() { return true; }

	render(shared) {
		const gl = shared.gl;
		gl.useProgram(this._program);
		gl.activeTexture(gl.TEXTURE0 + ORBIT_TEXTURE_UNIT);
		gl.bindTexture(gl.TEXTURE_2D, this._orbitTex);
		gl.uniform1i(this._orbitLenLoc, this._orbitLen);
		gl.uniform2f(this._refPixelLoc, this._refPx, this._refPy);
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
