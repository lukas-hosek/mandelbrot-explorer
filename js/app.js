/*
 * app.js — the application controller.
 *
 * Owns the canonical VIEW STATE (centre, zoom, iterations, palette) and is the
 * single place that mutates it. Input gestures and the UI call into the App;
 * the App pushes state to the Renderer (UBO), notifies the Engine, and refreshes
 * the UI. Keeping all mutation here is what lets the Renderer stay a dumb,
 * engine-agnostic GPU host.
 *
 * Depends on globals: Renderer, FragmentMandelbrotEngine, OrbitMandelbrotEngine,
 * ComplexDD, PALETTES, UI, InputController.
 */

/* Default framing: real axis spans DEFAULT_SPAN across the drawing buffer,
 * centred on the classic (-0.5, 0). */
const DEFAULT_SPAN = 3.5;
const DEFAULT_CENTER_X = -0.5;
const DEFAULT_CENTER_Y = 0.0;

/* Adaptive iteration schedule: maxIter grows with log2(zoom). Raised well above
 * the fragment engine's needs so deep-zoom interiors (Orbit engine) still resolve;
 * the fragment engine simply pixelates before it would hit the higher cap. */
const BASE_ITER = 120;
const ITER_PER_ZOOM = 50;
const MAX_ITER = 10000;

/* Palette band density (cycles per smooth iteration). Reserved for a future
 * sidebar control; constant for now. */
const COLOR_SCALE = 0.02;

/* Zoom clamps, expressed relative to the initial (fit) units-per-pixel.
 * MAX_ZOOM_OUT caps how far you can pull back; MIN_UPP_FACTOR caps how deep you
 * can push in. Relaxed for the Orbit engine's deep zoom (the double-double centre
 * keeps the framing precise; the shader's single-precision epsilon is the real
 * soft limit, ~1e15-1e20). The fragment engine pixelates long before this. */
const MAX_ZOOM_OUT = 4;          // upp <= initialUpp * 4
const MIN_UPP_FACTOR = 1e-30;    // upp >= initialUpp * 1e-30

/* Available engines, listed in the sidebar. Entries are descriptors with a
 * factory: only one engine is live at a time, so the App creates/disposes
 * instances on demand rather than holding them all at once. */
const ENGINES = [
	{ id: "fragment", label: "Fragment-only", create: () => new FragmentMandelbrotEngine() },
	{ id: "orbit", label: "Orbit", create: () => new OrbitMandelbrotEngine() },
];
const DEFAULT_ENGINE_ID = "orbit";

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
			// Authoritative centre in double-double; centerX/centerY mirror it
			// (kept in sync by commitViewChange) for the UBO + fragment engine.
			center: ComplexDD.fromNumbers(DEFAULT_CENTER_X, DEFAULT_CENTER_Y),
			unitsPerPixel: DEFAULT_SPAN / this.renderer.width,
			maxIterations: BASE_ITER,
			colorScale: COLOR_SCALE,
			time: 0,
		};
		// Baseline for the zoom readout; captured once at startup so the "1.0×"
		// reference is the initial full view.
		this.initialUpp = this.view.unitsPerPixel;

		this.palette = PALETTES[0];
		this.engineDef = ENGINES.find((def) => def.id === DEFAULT_ENGINE_ID) || ENGINES[0];
		this.engine = this.engineDef.create();

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
		// Refresh the plain-number mirror of the dd centre for the UBO + fragment engine.
		this.view.centerX = this.view.center.re.toNumber();
		this.view.centerY = this.view.center.im.toNumber();
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
	 * current view, in double-double precision. Accounts for devicePixelRatio and
	 * the bottom-left origin of gl_FragCoord (imaginary axis points up).
	 * @returns {{re:DoubleDouble, im:DoubleDouble}}
	 */
	clientToComplexDD(clientX, clientY) {
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
		// pixelX * upp is a small plain double even at deep zoom; adding it onto
		// the double-double centre keeps the centre's precision in the result.
		return {
			re: this.view.center.re.addNumber(pixelX * upp),
			im: this.view.center.im.addNumber(pixelY * upp),
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
		this.view.center.re = this.view.center.re.addNumber(-dxCss * dpr * upp);
		this.view.center.im = this.view.center.im.addNumber(dyCss * dpr * upp); // screen-down is complex-down
		this.commitViewChange();
	}

	/**
	 * Zoom by `factor` (multiplies units-per-pixel; <1 zooms in) while keeping
	 * the complex point under (clientX, clientY) fixed on screen.
	 */
	zoomAtClient(factor, clientX, clientY) {
		const before = this.clientToComplexDD(clientX, clientY);

		let upp = this.view.unitsPerPixel * factor;
		const maxUpp = this.initialUpp * MAX_ZOOM_OUT;
		const minUpp = this.initialUpp * MIN_UPP_FACTOR;
		upp = Math.min(maxUpp, Math.max(minUpp, upp));
		this.view.unitsPerPixel = upp;

		const after = this.clientToComplexDD(clientX, clientY);
		// centre += before - after, in double-double, so the tiny fixed-point
		// correction survives even when it is far below double precision.
		this.view.center.re = this.view.center.re.add(before.re.sub(after.re));
		this.view.center.im = this.view.center.im.add(before.im.sub(after.im));

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

	/* ---- Engine ---- */

	/**
	 * Switch the active engine. Disposes the old instance, creates and initialises
	 * the new one (via renderer.setEngine), then commits the current view so the
	 * new engine can precompute (the Orbit engine builds its reference orbit here).
	 * @param {object} def an entry from ENGINES
	 */
	setEngine(def) {
		if (def === this.engineDef) {
			return;
		}
		this.engineDef = def;
		this.engine = def.create();
		this.renderer.setEngine(this.engine);
		this.commitViewChange();
		if (this.ui) {
			this.ui.updateEngineSelection(def);
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
