/*
 * engine-scaled-orbit.js — ScaledOrbitMandelbrotEngine.
 *
 * Currently a duplicate of OrbitMandelbrotEngine. The intent is to explore
 * scaled/normalised perturbation variants without touching the baseline engine.
 *
 * Depends on globals from engine.js (MandelbrotEngine, createProgram) and
 * doubledouble.js (DoubleDouble, ComplexDD).
 */

const SCALED_ORBIT_TEX_WIDTH = 1024;
const SCALED_ORBIT_TEXTURE_UNIT = 2;
const SCALED_REF_SCAN_GRID = 8;

const SCALED_ORBIT_ENGINE_VS = `#version 300 es
void main() {
	vec2 verts[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
	gl_Position = vec4(verts[gl_VertexID], 0.0, 1.0);
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

uniform sampler2D uPalette;
uniform sampler2D uOrbit;
uniform int uOrbitLen;
uniform vec2 uRefPixel;

out vec4 fragColor;

const float BAILOUT2 = 256.0;

void main() {
	vec2 pixel = gl_FragCoord.xy - uResolution * 0.5 - uRefPixel;
	vec2 delta = pixel * uUnitsPerPixel;

	int W = textureSize(uOrbit, 0).x;
	int orbitLen = uOrbitLen;
	int maxIter = int(uMaxIterations);

	vec2 dz = vec2(0.0);
	int m = 0;
	vec2 z = vec2(0.0);
	int n = 0;
	for (; n < maxIter; n++) {
		vec2 Zm = texelFetch(uOrbit, ivec2(m % W, m / W), 0).xy;

		z = Zm + dz;
		if (dot(z, z) > BAILOUT2) {
			break;
		}

		if (dot(z, z) < dot(dz, dz) || m + 1 >= orbitLen) {
			dz = z;
			m = 0;
			Zm = vec2(0.0);
		}

		vec2 a = 2.0 * Zm + dz;
		dz = vec2(a.x * dz.x - a.y * dz.y, a.x * dz.y + a.y * dz.x) + delta;
		m++;
	}

	if (n >= maxIter) {
		fragColor = vec4(0.0, 0.0, 0.0, 1.0);
		return;
	}

	float mag2 = dot(z, z);
	float mu = float(n) - log2(0.5 * log2(mag2));
	float t = fract(mu * uColorScale);
	vec3 col = texture(uPalette, vec2(t, 0.5)).rgb;
	fragColor = vec4(col, 1.0);
}`;

class ScaledOrbitMandelbrotEngine extends MandelbrotEngine {
	constructor() {
		super();
		this._gl = null;
		this._program = null;
		this._orbitTex = null;
		this._orbitLenLoc = null;
		this._refPixelLoc = null;
		this._buffer = null;
		this._bufHeight = 0;
		this._orbitLen = 0;
		this._refPx = 0;
		this._refPy = 0;
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
		this._refPixelLoc = gl.getUniformLocation(this._program, "uRefPixel");
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
		gl.useProgram(this._program);
		gl.activeTexture(gl.TEXTURE0 + SCALED_ORBIT_TEXTURE_UNIT);
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
