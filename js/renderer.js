/*
 * renderer.js — WebGL2 context + SHARED GPU resources + the frame loop.
 *
 * The Renderer owns everything that is common to all engines:
 *   - the WebGL2 context,
 *   - a fullscreen-triangle VAO (empty; geometry comes from gl_VertexID),
 *   - the view UBO (the "constant buffer", std140 — see layout below),
 *   - the 1-D palette texture,
 *   - drawing-buffer sizing / devicePixelRatio handling,
 *   - a dirty-flag requestAnimationFrame loop.
 *
 * It does NOT know how to compute the Mandelbrot set — it delegates drawing to
 * the active MandelbrotEngine, handing it a `shared` bundle of the above.
 *
 * Depends on globals from palette.js (toTextureData).
 */

/* std140 View block layout (32 bytes / 8 floats). Mirrors the GLSL `View`
 * block in engine-fragment.js. Index = float slot in the CPU-side array. */
const VIEW_UBO_BINDING = 0;
const VIEW_FLOATS = 8;
const VIEW_I_CENTER_X = 0;
const VIEW_I_CENTER_Y = 1;
const VIEW_I_RES_X     = 2;
const VIEW_I_RES_Y     = 3;
const VIEW_I_UPP       = 4;
const VIEW_I_MAXITER   = 5;
const VIEW_I_COLORSCALE = 6;
const VIEW_I_TIME      = 7;

const PALETTE_TEXTURE_SIZE = 256;
const PALETTE_TEXTURE_UNIT = 1;

class Renderer {
	/**
	 * @param {HTMLCanvasElement} canvas
	 * @throws if WebGL2 is unavailable
	 */
	constructor(canvas) {
		this.canvas = canvas;

		const gl = canvas.getContext("webgl2", {
			alpha: false,
			depth: false,
			stencil: false,
			antialias: false,
			preserveDrawingBuffer: false,
			powerPreference: "high-performance",
		});
		if (!gl) {
			throw new Error("WebGL2 is not available in this browser.");
		}
		this.gl = gl;

		this._engine = null;
		this._dirty = true;
		this._running = false;
		this._lastFrameTime = 0;

		this._benchmarkMode = false;
		this._fpsBuffer = new Float32Array(60);
		this._fpsBufHead = 0;
		this._fpsBufCount = 0;
		this._fps = 0;
		this._frameTimeMs = 0;

		// MessageChannel used for the uncapped (no-VSync) loop in benchmark mode.
		this._mc = new MessageChannel();
		this._mc.port2.onmessage = () => this._uncappedFrame();

		// CPU-side mirror of the UBO, uploaded with bufferSubData when changed.
		this._viewData = new Float32Array(VIEW_FLOATS);

		this._dpr = 1;
		this._width = 1;   // drawing-buffer size in device pixels
		this._height = 1;

		this._initSharedResources();
	}

	/* ---- Setup of the shared GPU objects ---- */

	_initSharedResources() {
		const gl = this.gl;

		// Empty VAO: the fullscreen triangle is produced from gl_VertexID, but a
		// VAO must still be bound for a draw call in WebGL2.
		this._quadVao = gl.createVertexArray();

		// View UBO ("constant buffer"). Allocate the fixed 32-byte block and bind
		// it to its binding point once; the association persists.
		this._viewUbo = gl.createBuffer();
		gl.bindBuffer(gl.UNIFORM_BUFFER, this._viewUbo);
		gl.bufferData(gl.UNIFORM_BUFFER, this._viewData.byteLength, gl.DYNAMIC_DRAW);
		gl.bindBufferBase(gl.UNIFORM_BUFFER, VIEW_UBO_BINDING, this._viewUbo);
		gl.bindBuffer(gl.UNIFORM_BUFFER, null);

		// Palette texture (size x 1, RGBA8). LINEAR for smooth gradients,
		// CLAMP_TO_EDGE so the ends don't bleed into each other.
		this._paletteTex = gl.createTexture();
		gl.activeTexture(gl.TEXTURE0 + PALETTE_TEXTURE_UNIT);
		gl.bindTexture(gl.TEXTURE_2D, this._paletteTex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		// Allocate with a neutral 1-texel placeholder until a palette is set.
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
			new Uint8Array([0, 0, 0, 255]));
	}

	/** The bundle handed to engines. */
	get shared() {
		return {
			gl: this.gl,
			quad: { vao: this._quadVao },
			viewUBO: { buffer: this._viewUbo, bindingPoint: VIEW_UBO_BINDING },
			palette: { texture: this._paletteTex, unit: PALETTE_TEXTURE_UNIT },
			viewport: { width: this._width, height: this._height, dpr: this._dpr },
		};
	}

	get dpr() { return this._dpr; }
	get width() { return this._width; }
	get height() { return this._height; }
	get fps() { return this._fps; }
	get frameTimeMs() { return this._frameTimeMs; }

	setBenchmarkMode(enabled) {
		const wasEnabled = this._benchmarkMode;
		this._benchmarkMode = enabled;
		this._fpsBufHead = 0;
		this._fpsBufCount = 0;
		this._fps = 0;
		this._frameTimeMs = 0;
		this._dirty = true;
		// Kick off the uncapped loop if we're switching into benchmark mode while
		// already running; the rAF loop will stop re-scheduling itself naturally.
		if (this._running) {
			if (enabled && !wasEnabled) {
				this._mc.port1.postMessage(null);
			} else if (!enabled && wasEnabled) {
				this._lastFrameTime = performance.now();
				requestAnimationFrame((now) => this._rafFrame(now));
			}
		}
	}

	/* ---- Engine / palette wiring ---- */

	setEngine(engine) {
		if (this._engine) {
			this._engine.dispose();
		}
		this._engine = engine;
		engine.init(this.shared);
		engine.onResize(this._width, this._height);
		this._dirty = true;
	}

	/**
	 * Rebuild and upload the palette texture from a Palette instance.
	 * @param {Palette} palette
	 */
	setPalette(palette) {
		const gl = this.gl;
		const data = toTextureData(palette, PALETTE_TEXTURE_SIZE);
		gl.activeTexture(gl.TEXTURE0 + PALETTE_TEXTURE_UNIT);
		gl.bindTexture(gl.TEXTURE_2D, this._paletteTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PALETTE_TEXTURE_SIZE, 1, 0,
			gl.RGBA, gl.UNSIGNED_BYTE, data);
		this._dirty = true;
	}

	/* ---- View UBO upload ---- */

	/**
	 * Pack the canonical view into the UBO and upload it. Resolution comes from
	 * the renderer's own drawing-buffer size (authoritative), not the caller.
	 * @param {object} view { centerX, centerY, unitsPerPixel, maxIterations, colorScale, time }
	 */
	updateView(view) {
		const d = this._viewData;
		d[VIEW_I_CENTER_X] = view.centerX;
		d[VIEW_I_CENTER_Y] = view.centerY;
		d[VIEW_I_RES_X] = this._width;
		d[VIEW_I_RES_Y] = this._height;
		d[VIEW_I_UPP] = view.unitsPerPixel;
		d[VIEW_I_MAXITER] = view.maxIterations;
		d[VIEW_I_COLORSCALE] = view.colorScale;
		d[VIEW_I_TIME] = view.time || 0;

		const gl = this.gl;
		gl.bindBuffer(gl.UNIFORM_BUFFER, this._viewUbo);
		gl.bufferSubData(gl.UNIFORM_BUFFER, 0, d);
		gl.bindBuffer(gl.UNIFORM_BUFFER, null);
		this._dirty = true;
	}

	/* ---- Sizing ---- */

	/**
	 * Resize the drawing buffer to the canvas CSS size x devicePixelRatio.
	 * @returns {boolean} true if the size actually changed
	 */
	resize() {
		const dpr = window.devicePixelRatio || 1;
		const cssW = this.canvas.clientWidth || window.innerWidth;
		const cssH = this.canvas.clientHeight || window.innerHeight;
		const w = Math.max(1, Math.round(cssW * dpr));
		const h = Math.max(1, Math.round(cssH * dpr));

		if (w === this._width && h === this._height && dpr === this._dpr) {
			return false;
		}

		this._dpr = dpr;
		this._width = w;
		this._height = h;
		this.canvas.width = w;
		this.canvas.height = h;
		this.gl.viewport(0, 0, w, h);

		if (this._engine) {
			this._engine.onResize(w, h);
		}
		this._dirty = true;
		return true;
	}

	/* ---- Frame loop ---- */

	markDirty() {
		this._dirty = true;
	}

	start() {
		if (this._running) return;
		this._running = true;
		this._lastFrameTime = performance.now();
		if (this._benchmarkMode) {
			this._mc.port1.postMessage(null);
		} else {
			requestAnimationFrame((now) => this._rafFrame(now));
		}
	}

	stop() {
		this._running = false;
	}

	_rafFrame(now) {
		if (!this._running || this._benchmarkMode) return;
		this._frame(now);
		requestAnimationFrame((now) => this._rafFrame(now));
	}

	_uncappedFrame() {
		if (!this._running || !this._benchmarkMode) return;
		this._frame(performance.now());
		this._mc.port1.postMessage(null);
	}

	_frame(now) {
		const dt = now - this._lastFrameTime;
		this._lastFrameTime = now;

		if (this._benchmarkMode) {
			const buf = this._fpsBuffer;
			buf[this._fpsBufHead] = dt;
			this._fpsBufHead = (this._fpsBufHead + 1) % buf.length;
			if (this._fpsBufCount < buf.length) this._fpsBufCount++;
			let sum = 0;
			for (let i = 0; i < this._fpsBufCount; i++) sum += buf[i];
			const avg = sum / this._fpsBufCount;
			this._frameTimeMs = avg;
			this._fps = 1000 / avg;
			this._dirty = true;
		}

		const engine = this._engine;
		if (!engine) return;

		// Let the engine advance any async work. Pending work keeps us dirty.
		const pending = engine.update(dt);
		if (pending) {
			this._dirty = true;
		}

		if (this._dirty && engine.isReady()) {
			this._draw();
			// Stay dirty only while async work is still in flight.
			this._dirty = pending;
		}
	}

	_draw() {
		const gl = this.gl;
		gl.viewport(0, 0, this._width, this._height);
		gl.clearColor(0, 0, 0, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		this._engine.render(this.shared);
	}
}
