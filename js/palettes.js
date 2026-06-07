/*
 * palettes.js — concrete Palette IMPLEMENTATIONS, generated entirely in code.
 *
 * Two building blocks:
 *   GradientPalette — piecewise-linear interpolation between colour stops.
 *   RainbowPalette  — functional HSV hue cycle.
 *
 * The PALETTES registry at the bottom is what the UI lists. Colours are given
 * as [r, g, b] floats in [0, 1].
 *
 * Depends on globals from palette.js (Palette, lerp, hsvToRgb).
 */

/**
 * A palette defined by sorted colour stops { t, rgb }. colorAt() linearly
 * interpolates between the surrounding stops and clamps outside the range.
 */
class GradientPalette extends Palette {
	/**
	 * @param {string} name
	 * @param {Array<{t:number, rgb:[number,number,number]}>} stops sorted by t, covering [0,1]
	 */
	constructor(name, stops) {
		super();
		this._name = name;
		// Defensive copy, sorted by position so callers needn't pre-sort.
		this._stops = stops.slice().sort((a, b) => a.t - b.t);
	}

	get name() {
		return this._name;
	}

	colorAt(t) {
		const stops = this._stops;

		// Clamp to the endpoints outside the defined range.
		if (t <= stops[0].t) return stops[0].rgb.slice();
		const last = stops[stops.length - 1];
		if (t >= last.t) return last.rgb.slice();

		// Find the bracketing pair [lo, hi] with lo.t <= t < hi.t.
		for (let i = 0; i < stops.length - 1; i++) {
			const lo = stops[i];
			const hi = stops[i + 1];
			if (t < hi.t) {
				const f = (t - lo.t) / (hi.t - lo.t);
				return [
					lerp(lo.rgb[0], hi.rgb[0], f),
					lerp(lo.rgb[1], hi.rgb[1], f),
					lerp(lo.rgb[2], hi.rgb[2], f),
				];
			}
		}
		return last.rgb.slice();
	}
}

/**
 * Classic fractal rainbow: a full HSV hue cycle at maximum saturation/value.
 * `cycles` controls how many full hue revolutions span [0, 1].
 */
class RainbowPalette extends Palette {
	constructor(name, cycles) {
		super();
		this._name = name;
		this._cycles = cycles || 1;
	}

	get name() {
		return this._name;
	}

	colorAt(t) {
		return hsvToRgb(t * this._cycles, 1.0, 1.0);
	}
}

/* ---- The initial palette set (user-selected) ---- */

const PALETTES = [
	// The first entry is the app's startup default.
	new GradientPalette("Plasma", [
		{ t: 0.00, rgb: [0.0, 0.0, 0.0] },
		{ t: 0.20, rgb: [0.7, 0.0, 0.0] },
		{ t: 0.40, rgb: [1.0, 0.45, 0.0] },
		{ t: 0.60, rgb: [1.0, 1.0, 1.0] },
		{ t: 0.80, rgb: [0.03, 0.08, 0.28] },
		{ t: 1.00, rgb: [0.0, 0.0, 0.0] },
	]),

	// Fire / heat: black -> red -> orange -> yellow -> white.
	new GradientPalette("Fire", [
		{ t: 0.00, rgb: [0.0, 0.0, 0.0] },
		{ t: 0.25, rgb: [0.6, 0.0, 0.0] },
		{ t: 0.50, rgb: [1.0, 0.45, 0.0] },
		{ t: 0.75, rgb: [1.0, 0.9, 0.2] },
		{ t: 1.00, rgb: [1.0, 1.0, 1.0] },
	]),

	// Ocean / ice: black -> deep navy -> blue -> cyan -> white -> black.
	new GradientPalette("Ocean", [
		{ t: 0.00, rgb: [0.0, 0.0, 0.0] },
		{ t: 0.25, rgb: [0.05, 0.25, 0.55] },
		{ t: 0.50, rgb: [0.20, 0.70, 0.90] },
		{ t: 0.75, rgb: [0.95, 0.99, 1.0] },
		{ t: 1.00, rgb: [0.0, 0.0, 0.0] },
	]),

	// Aurora: black -> green -> magenta -> black.
	new GradientPalette("Aurora", [
		{ t: 0.00, rgb: [0.0, 0.0, 0.0] },
		{ t: 0.35, rgb: [0.05, 0.78, 0.25] },
		{ t: 0.70, rgb: [1.0, 0.18, 0.82] },
		{ t: 1.00, rgb: [0.0, 0.0, 0.0] },
	]),
];
