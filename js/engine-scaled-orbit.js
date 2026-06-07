/*
 * engine-scaled-orbit.js — ScaledOrbitMandelbrotEngine.
 *
 * A perturbation/deep-zoom engine like OrbitMandelbrotEngine (same dd reference
 * orbit on texture unit 2, same rebasing), but reworked to push the deep-zoom
 * wall ~5 orders deeper by keeping every shader float in the normal float32
 * range. Three changes vs the baseline Orbit engine:
 *
 *   1. NORMALISED COORDINATES. The VS passes a varying `vUV` that spans [-1,1]
 *      along the longer canvas axis (aspect-corrected on the short axis) instead
 *      of the FS reading gl_FragCoord. So units are per-half-screen, not
 *      per-pixel — ~3 orders larger before anything underflows.
 *   2. CPU-COMPUTED SCALE. `unitsPerScreenSize = unitsPerPixel * halfLong` is
 *      formed on the CPU in plain double and narrowed to float32 only at the
 *      gl.uniform1f call, bypassing the float32 View UBO's `uUnitsPerPixel`,
 *      which denormalises (~1e-38) around zoom 1e35.
 *   3. SCALED PERTURBATION. The shader carries `eps = dz / s` (s =
 *      unitsPerScreenSize) rather than dz, so the iteration variable stays
 *      O(1)..O(1/s) (normal float32) from the reference out to escape and the
 *      tiny `delta = vUV*s` that used to denormalise near the reference never
 *      forms. s survives only as the coefficient of the quadratic term.
 *
 * Soft limit is now where s itself denormalises, ~zoom 1.5e38; past that needs
 * an emulated-double (df64) reconstruction of z. Depends on globals from
 * engine.js (MandelbrotEngine, createProgram) and doubledouble.js (ComplexDD).
 */

const SCALED_ORBIT_TEX_WIDTH = 1024;
const SCALED_ORBIT_TEXTURE_UNIT = 2;
const SCALED_REF_SCAN_GRID = 8;

const SCALED_ORBIT_ENGINE_VS = `#version 300 es

// uUvScale (aspect correction) and uRefUv (reference offset, in screen-size
// units) are precomputed on the CPU; the VS just maps the quad corner and forwards.
uniform vec2 uUvScale;                  // per-axis scale that makes vUV span [-1,1] on the long axis
uniform vec2 uRefUv;                    // reference point's position in the same [-1,1] UV space

out vec2 vUV;                           // this vertex's screen position, relative to the reference

void main() {
	// Fullscreen triangle: three clip-space corners selected by gl_VertexID.
	vec2 clipCorners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
	vec2 clipPosition = clipCorners[gl_VertexID];   // this vertex's clip-space position
	gl_Position = vec4(clipPosition, 0.0, 1.0);
	vUV = clipPosition * uUvScale - uRefUv;          // normalised, reference-relative screen coord
}`;

const SCALED_ORBIT_ENGINE_FS = `#version 300 es
precision highp float;

layout(std140) uniform View {
	vec2  uCenter;
	vec2  uResolution;
	float uUnitsPerPixel;
	float uMaxIterations;
	float uColorScale;
	float uTime;
};

uniform sampler2D uPalette;             // 1-D colour ramp, sampled by the smooth iteration count
uniform sampler2D uOrbit;               // reference orbit packed as RG32F (texel n = reference Z_n)
uniform int uOrbitLen;                  // number of valid samples stored in uOrbit
// Complex units per half-long-side, computed on the CPU in double precision and
// narrowed to float32 only at gl.uniform1f — this bypasses the UBO's float32
// uUnitsPerPixel, which goes denormal (~1e-38) around zoom 1e35.
uniform float uUnitsPerScreenSize;

in vec2 vUV;                            // this pixel's screen position in [-1,1] along the long axis
out vec4 fragColor;

// |z|^2 at which divergence is mathematically guaranteed (escape radius 2). The
// perturbation loop breaks here, while z is still O(1), before the scaled
// perturbation would have to represent the escaped value (which overflows float32
// at deep zoom).
const float fEscapeRadiusSq = 4.0;

// |z|^2 used for the smooth-colour magnitude (radius 16). Larger than the escape
// radius for smoother gradients; reached in plain z-space after the loop breaks.
const float fBailoutRadiusSq = 256.0;

void main() {
	float fScale = uUnitsPerScreenSize; // perturbation scale s = complex units per half-screen
	float fInvScale = 1.0 / fScale;     // 1/s; folds a full value back into scaled units on rebase

	int iOrbitTexWidth = textureSize(uOrbit, 0).x;  // texture width, to unflatten the 1-D orbit index
	int iOrbitLength = uOrbitLen;                    // valid reference-orbit sample count
	int iMaxIterations = int(uMaxIterations);        // iteration cap from the UBO

	// Scaled perturbation: carry cEpsilon = dz / s rather than dz itself, so the
	// iteration variable stays in the O(1)..O(1/s) normal-float32 range from the
	// reference out to escape (dz alone would dip into denormals near the
	// reference). vUV is the O(1) driver; fScale only multiplies O(1)-or-larger
	// quantities, so the tiny perturbation delta = vUV*s never explicitly forms.
	
	vec2 cEpsilon = vec2(0.0);          // scaled perturbation ε = δz / s (the carried variable)
	vec2 cOrbitValue = vec2(0.0);       // reconstructed orbit value z = Z_ref + δz for this pixel
	int iRefIndex = 0;                  // index into the reference orbit (decoupled from iIteration by rebasing)
	int iIteration = 0;                 // iterations elapsed
	
	for (; iIteration < iMaxIterations; iIteration++) {
		// Reference orbit sample Z at iRefIndex (1-D index unflattened to a texel).
		vec2 cReferenceZ = texelFetch(uOrbit,
			ivec2(iRefIndex % iOrbitTexWidth, iRefIndex / iOrbitTexWidth), 0).xy;

		vec2 cDelta = fScale * cEpsilon;            // δz = s·ε, the un-scaled perturbation (O(1) near escape)
		cOrbitValue = cReferenceZ + cDelta;         // reconstruct the true orbit value z
		if (dot(cOrbitValue, cOrbitValue) > fEscapeRadiusSq) {
			break;                                  // guaranteed escape; finish in z-space below
		}

		// Rebase (Zhuoran): when the perturbation dominates (|z| < |δz| = |cDelta|)
		// or the stored orbit runs out, restart the reference at Z_0 = 0 and fold
		// the full value back into the scaled variable: δz_new = z  ->  ε = z / s.
		if (dot(cOrbitValue, cOrbitValue) < dot(cDelta, cDelta) || iRefIndex + 1 >= iOrbitLength) {
			cEpsilon = cOrbitValue * fInvScale;
			iRefIndex = 0;
			cReferenceZ = vec2(0.0);
			cDelta = cOrbitValue;                   // = s·ε after the fold; used by the quadratic term
		}

		// ε' = 2·Z_ref·ε + s·ε² + vUV. The two vec2(...) expressions are complex
		// products. The quadratic is formed as (s·ε)·ε = cDelta·cEpsilon so the
		// intermediate stays ~1/s; plain ε² would overflow to inf when ε ~ 1/s.
		vec2 cLinearTerm = 2.0 * vec2(cReferenceZ.x * cEpsilon.x - cReferenceZ.y * cEpsilon.y,
		                              cReferenceZ.x * cEpsilon.y + cReferenceZ.y * cEpsilon.x);
		vec2 cQuadraticTerm = vec2(cDelta.x * cEpsilon.x - cDelta.y * cEpsilon.y,
		                           cDelta.x * cEpsilon.y + cDelta.y * cEpsilon.x);
		cEpsilon = cLinearTerm + cQuadraticTerm + vUV;
		iRefIndex++;
	}

	if (iIteration >= iMaxIterations) {
		fragColor = vec4(0.0, 0.0, 0.0, 1.0);       // never escaped: interior, paint black
		return;
	}

	// The loop bailed at radius 2 with cOrbitValue still finite. Refine the escape
	// in plain z-space (z' = z² + c, everything O(1)) up to the larger colouring
	// radius, so cEpsilon never has to hold the overflowing escaped value. c is the
	// pixel's own c: the reference c (orbit[1], since Z_1 = Z_0² + C = C) plus this
	// pixel's offset δc = vUV·s (negligible at deep zoom, O(1) when zoomed out — so
	// it must be kept for the colours to stay correct at shallow zoom).

	vec2 cReferenceC = texelFetch(uOrbit, ivec2(1, 0), 0).xy;   // reference c = orbit sample 1
	vec2 cPixelC = cReferenceC + vUV * fScale;                  // this pixel's c
	for (int iRefine = 0; iRefine < 4 && dot(cOrbitValue, cOrbitValue) < fBailoutRadiusSq; iRefine++) {
		cOrbitValue = vec2(cOrbitValue.x * cOrbitValue.x - cOrbitValue.y * cOrbitValue.y,
		                   2.0 * cOrbitValue.x * cOrbitValue.y) + cPixelC;   // z = z² + c
		iIteration++;
	}

	float fMagnitudeSq = dot(cOrbitValue, cOrbitValue);         // |z|² at escape (finite, >= radius)
	
	// Smooth (fractional) iteration count: continuous escape time for band-free colour.
	
	float fSmoothIter = float(iIteration) - log2(0.5 * log2(fMagnitudeSq));
	float fPaletteT = fract(fSmoothIter * uColorScale);         // palette lookup coordinate in [0,1)
	vec3 rgbColor = texture(uPalette, vec2(fPaletteT, 0.5)).rgb;
	fragColor = vec4(rgbColor, 1.0);
}`;

class ScaledOrbitMandelbrotEngine extends MandelbrotEngine {
	constructor() {
		super();
		this._gl = null;
		this._program = null;
		this._orbitTex = null;
		this._orbitLenLoc = null;
		this._uvScaleLoc = null;
		this._refUvLoc = null;
		this._unitsPerScreenSizeLoc = null;
		this._buffer = null;
		this._bufHeight = 0;
		this._orbitLen = 0;
		this._refPx = 0;
		this._refPy = 0;
		this._upp = 0;
		this._viewW = 1;
		this._viewH = 1;
	}

	get name() {
		return "scaled-orbit-dd";
	}

	init(shared) {
		const gl = shared.gl;
		this._gl = gl;
		this._program = createProgram(gl, SCALED_ORBIT_ENGINE_VS, SCALED_ORBIT_ENGINE_FS);
		this._viewW = shared.viewport.width;
		this._viewH = shared.viewport.height;

		const blockIndex = gl.getUniformBlockIndex(this._program, "View");
		gl.uniformBlockBinding(this._program, blockIndex, shared.viewUBO.bindingPoint);

		gl.useProgram(this._program);
		gl.uniform1i(gl.getUniformLocation(this._program, "uPalette"), shared.palette.unit);
		gl.uniform1i(gl.getUniformLocation(this._program, "uOrbit"), SCALED_ORBIT_TEXTURE_UNIT);
		this._orbitLenLoc = gl.getUniformLocation(this._program, "uOrbitLen");
		this._uvScaleLoc = gl.getUniformLocation(this._program, "uUvScale");
		this._refUvLoc = gl.getUniformLocation(this._program, "uRefUv");
		this._unitsPerScreenSizeLoc = gl.getUniformLocation(this._program, "uUnitsPerScreenSize");
		gl.useProgram(null);

		this._orbitTex = gl.createTexture();
		gl.activeTexture(gl.TEXTURE0 + SCALED_ORBIT_TEXTURE_UNIT);
		gl.bindTexture(gl.TEXTURE_2D, this._orbitTex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, 1, 1, 0, gl.RG, gl.FLOAT,
			new Float32Array(2));
		this._bufHeight = 0;
	}

	onResize(width, height) {
		this._viewW = width;
		this._viewH = height;
	}

	onViewChanged(view) {
		const startMs = performance.now();
		try {
			const maxIter = view.maxIterations;
			this._upp = view.unitsPerPixel;
			const ref = this._pickReference(view);
			this._refPx = ref.px;
			this._refPy = ref.py;
			const height = this._ensureBuffer(maxIter);
			this._orbitLen = this._computeReferenceOrbit(ref.C, maxIter);
			this._uploadOrbit(height);
		} finally {
			const elapsedMs = performance.now() - startMs;
			console.log("[scaled-orbit-dd] onViewChanged " + elapsedMs.toFixed(1) + " ms");
		}
	}

	_pickReference(view) {
		const maxIter = view.maxIterations;
		const upp = view.unitsPerPixel;
		const candidates = this._candidateOffsets(this._viewW, this._viewH);

		let best = null;
		let bestLen = -1;
		for (let k = 0; k < candidates.length; k++) {
			const px = candidates[k].px;
			const py = candidates[k].py;
			const C = new ComplexDD(
				view.center.re.addNumber(px * upp),
				view.center.im.addNumber(py * upp));
			const len = this._escapeLength(C, maxIter);
			if (len > bestLen) {
				bestLen = len;
				best = { C: C, px: px, py: py };
			}
			if (len >= maxIter) {
				break;
			}
		}
		return best;
	}

	_candidateOffsets(width, height) {
		const list = [{ px: 0, py: 0 }];
		const G = SCALED_REF_SCAN_GRID;
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

	_ensureBuffer(maxIter) {
		const height = Math.max(1, Math.ceil(maxIter / SCALED_ORBIT_TEX_WIDTH));
		if (!this._buffer || this._bufHeight !== height) {
			this._buffer = new Float32Array(SCALED_ORBIT_TEX_WIDTH * height * 2);
			this._bufHeight = height;
		}
		return height;
	}

	_uploadOrbit(height) {
		const gl = this._gl;
		gl.activeTexture(gl.TEXTURE0 + SCALED_ORBIT_TEXTURE_UNIT);
		gl.bindTexture(gl.TEXTURE_2D, this._orbitTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, SCALED_ORBIT_TEX_WIDTH, height, 0,
			gl.RG, gl.FLOAT, this._buffer);
	}

	update(dtMs) { return false; }
	isReady() { return true; }

	render(shared) {
		const gl = shared.gl;

		// All in double precision on the CPU; only narrowed to float32 at the
		// gl.uniform* calls below (the "last moment"). uUnitsPerScreenSize in
		// particular must not flow through the float32 UBO, where its tiny
		// exponent would denormalise around zoom 1e35.
		const halfLong = Math.max(this._viewW, this._viewH) * 0.5;
		const unitsPerScreenSize = this._upp * halfLong;
		const aspect = this._viewW / this._viewH;
		const uvScaleX = aspect >= 1 ? 1 : aspect;
		const uvScaleY = aspect >= 1 ? 1 / aspect : 1;
		const refUvX = this._refPx / halfLong;
		const refUvY = this._refPy / halfLong;

		gl.useProgram(this._program);
		gl.activeTexture(gl.TEXTURE0 + SCALED_ORBIT_TEXTURE_UNIT);
		gl.bindTexture(gl.TEXTURE_2D, this._orbitTex);
		gl.uniform1i(this._orbitLenLoc, this._orbitLen);
		gl.uniform2f(this._uvScaleLoc, uvScaleX, uvScaleY);
		gl.uniform2f(this._refUvLoc, refUvX, refUvY);
		gl.uniform1f(this._unitsPerScreenSizeLoc, unitsPerScreenSize);
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
