/*
 * app.js — the application controller.
 *
 * Owns the canonical VIEW STATE (centre, zoom, iterations, palette) and is the
 * single place that mutates it. Input gestures and the UI call into the App;
 * the App pushes state to the Renderer (UBO), notifies the Engine, and refreshes
 * the UI. Keeping all mutation here is what lets the Renderer stay a dumb,
 * engine-agnostic GPU host.
 *
 * Depends on globals: Renderer, FragmentMandelbrotEngine, PALETTES, UI,
 * InputController.
 */

/* Default framing: real axis spans DEFAULT_SPAN across the drawing buffer,
 * centred on the classic (-0.5, 0). */
const DEFAULT_SPAN = 3.5;
const DEFAULT_CENTER_X = -0.5;
const DEFAULT_CENTER_Y = 0.0;

/* Adaptive iteration schedule: maxIter grows with log2(zoom). */
const BASE_ITER = 120;
const ITER_PER_ZOOM = 40;
const MAX_ITER = 2000;

/* Palette band density (cycles per smooth iteration). Reserved for a future
 * sidebar control; constant for now. */
const COLOR_SCALE = 0.02;

/* Zoom clamps, expressed relative to the initial (fit) units-per-pixel.
 * MAX_ZOOM_OUT caps how far you can pull back; MIN_UPP_FACTOR caps how deep you
 * can push in (well past where single precision visibly breaks down). */
const MAX_ZOOM_OUT = 4;          // upp <= initialUpp * 4
const MIN_UPP_FACTOR = 1e-13;    // upp >= initialUpp * 1e-13

class App {
	/**
	 * @param {HTMLCanvasElement} canvas
	 * @throws if WebGL2 is unavailable (surfaced by main.js)
	 */
	constructor(canvas) {
		this.canvas = canvas;
		this.renderer = new Renderer(canvas);

		// Establish the drawing-buffer size before deriving the initial scale.
		this.renderer.resize();

		this.view = {
			centerX: DEFAULT_CENTER_X,
			centerY: DEFAULT_CENTER_Y,
			unitsPerPixel: DEFAULT_SPAN / this.renderer.width,
			maxIterations: BASE_ITER,
			colorScale: COLOR_SCALE,
			time: 0,
		};
		// Baseline for the zoom readout; captured once at startup so the "1.0×"
		// reference is the initial full view.
		this.initialUpp = this.view.unitsPerPixel;

		this.palette = PALETTES[0];
		this.engine = new FragmentMandelbrotEngine();

		this.ui = null;
		this.input = null;
	}

	/** Wire everything together and start the render loop. */
	init() {
		this.renderer.setEngine(this.engine);
		this.renderer.setPalette(this.palette);

		this.ui = new UI(this);
		this.input = new InputController(this.canvas, this);

		window.addEventListener("resize", () => this.handleResize());

		this.commitViewChange();
		this.renderer.start();
	}

	/** Current magnification relative to the initial full view. */
	get zoom() {
		return this.initialUpp / this.view.unitsPerPixel;
	}

	/** Adaptive iteration cap for the current zoom. */
	_computeIterations() {
		const z = Math.max(1, this.zoom);
		const it = BASE_ITER + Math.round(ITER_PER_ZOOM * Math.log2(z));
		return Math.min(MAX_ITER, Math.max(BASE_ITER, it));
	}

	/**
	 * The single commit point after any view mutation: recompute iterations,
	 * upload the UBO, notify the engine, refresh the UI, request a redraw.
	 */
	commitViewChange() {
		this.view.maxIterations = this._computeIterations();
		this.renderer.updateView(this.view);
		this.engine.onViewChanged(this.view);
		if (this.ui) {
			this.ui.update();
		}
		this.renderer.markDirty();
	}

	/* ---- Coordinate mapping ---- */

	/**
	 * Map a client (CSS-pixel) position to a complex-plane coordinate using the
	 * current view. Accounts for devicePixelRatio and the bottom-left origin of
	 * gl_FragCoord (imaginary axis points up).
	 * @returns {{re:number, im:number}}
	 */
	clientToComplex(clientX, clientY) {
		const rect = this.canvas.getBoundingClientRect();
		const dpr = this.renderer.dpr;
		const w = this.renderer.width;
		const h = this.renderer.height;

		const dx = (clientX - rect.left) * dpr;
		const dyTop = (clientY - rect.top) * dpr;
		const fragY = h - dyTop;               // flip to match gl_FragCoord

		const pixelX = dx - w * 0.5;
		const pixelY = fragY - h * 0.5;
		const upp = this.view.unitsPerPixel;
		return {
			re: this.view.centerX + pixelX * upp,
			im: this.view.centerY + pixelY * upp,
		};
	}

	/* ---- Gestures (called by InputController) ---- */

	/**
	 * Pan by a movement in CSS pixels (grab-and-drag semantics).
	 * @param {number} dxCss
	 * @param {number} dyCss
	 */
	panByPixels(dxCss, dyCss) {
		const upp = this.view.unitsPerPixel;
		const dpr = this.renderer.dpr;
		this.view.centerX -= dxCss * dpr * upp;
		this.view.centerY += dyCss * dpr * upp; // screen-down is complex-down
		this.commitViewChange();
	}

	/**
	 * Zoom by `factor` (multiplies units-per-pixel; <1 zooms in) while keeping
	 * the complex point under (clientX, clientY) fixed on screen.
	 */
	zoomAtClient(factor, clientX, clientY) {
		const before = this.clientToComplex(clientX, clientY);

		let upp = this.view.unitsPerPixel * factor;
		const maxUpp = this.initialUpp * MAX_ZOOM_OUT;
		const minUpp = this.initialUpp * MIN_UPP_FACTOR;
		upp = Math.min(maxUpp, Math.max(minUpp, upp));
		this.view.unitsPerPixel = upp;

		const after = this.clientToComplex(clientX, clientY);
		this.view.centerX += before.re - after.re;
		this.view.centerY += before.im - after.im;

		this.commitViewChange();
	}

	/* ---- Palette ---- */

	setPalette(palette) {
		this.palette = palette;
		this.renderer.setPalette(palette);
		this.renderer.markDirty();
		if (this.ui) {
			this.ui.updatePaletteSelection(palette);
		}
	}

	/* ---- Resize ---- */

	handleResize() {
		// Keep the same magnification framing; just re-pack the new resolution
		// into the UBO (initialUpp / unitsPerPixel are left untouched).
		if (this.renderer.resize()) {
			this.commitViewChange();
		}
	}
}
