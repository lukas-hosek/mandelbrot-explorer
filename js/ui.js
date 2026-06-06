/*
 * ui.js — DOM chrome: the top-left info bar and the right palette sidebar.
 *
 * Structural elements live in index.html; this wires them up and keeps them in
 * sync with the App. The palette list is generated from the PALETTES registry
 * (palettes.js), so adding a palette there automatically lists it here.
 */

class UI {
	/**
	 * @param {App} app
	 */
	constructor(app) {
		this.app = app;

		this.zoomEl = document.getElementById("info-zoom");
		this.iterEl = document.getElementById("info-iter");
		this.menuBtn = document.getElementById("menu-toggle");
		this.sidebar = document.getElementById("sidebar");
		this.listEl = document.getElementById("palette-list");

		this._items = []; // { li, palette }
		this._buildPaletteList();

		this.menuBtn.addEventListener("click", () => this.toggleSidebar());

		this.update();
	}

	_buildPaletteList() {
		this.listEl.innerHTML = "";
		this._items = [];

		PALETTES.forEach((pal) => {
			const li = document.createElement("li");
			li.className = "palette-item";

			const swatch = document.createElement("span");
			swatch.className = "palette-swatch";
			swatch.style.backgroundImage = paletteCssGradient(pal);

			const name = document.createElement("span");
			name.className = "palette-name";
			name.textContent = pal.name;

			li.appendChild(swatch);
			li.appendChild(name);
			li.addEventListener("click", () => this.app.setPalette(pal));

			this.listEl.appendChild(li);
			this._items.push({ li: li, palette: pal });
		});

		this.updatePaletteSelection(this.app.palette);
	}

	/** Highlight the active palette row. */
	updatePaletteSelection(palette) {
		this._items.forEach((item) => {
			item.li.classList.toggle("active", item.palette === palette);
		});
	}

	toggleSidebar() {
		const open = this.sidebar.classList.toggle("open");
		this.menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
	}

	/** Refresh the info bar from current app state. */
	update() {
		this.zoomEl.textContent = formatZoom(this.app.zoom);
		this.iterEl.textContent = String(this.app.view.maxIterations);
	}
}

/* ---- formatting / preview helpers ---- */

/**
 * Format a magnification factor compactly: "1.00×" up to "1.23e6×".
 * @param {number} z
 * @returns {string}
 */
function formatZoom(z) {
	if (!isFinite(z) || z <= 0) {
		return "1.00×";
	}
	if (z < 1000) {
		return z.toFixed(z < 10 ? 2 : 1) + "×";
	}
	// e.g. "1.23e6×"
	return z.toExponential(2).replace("e+", "e") + "×";
}

/**
 * Build a CSS linear-gradient string previewing a palette, by sampling it at a
 * handful of stops. Used for the sidebar swatches.
 * @param {Palette} palette
 * @param {number} [steps]
 * @returns {string}
 */
function paletteCssGradient(palette, steps) {
	steps = steps || 16;
	const stops = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const c = palette.colorAt(t);
		const r = Math.round(c[0] * 255);
		const g = Math.round(c[1] * 255);
		const b = Math.round(c[2] * 255);
		stops.push("rgb(" + r + "," + g + "," + b + ") " + Math.round(t * 100) + "%");
	}
	return "linear-gradient(to right, " + stops.join(", ") + ")";
}
