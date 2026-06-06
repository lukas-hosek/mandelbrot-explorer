/*
 * palette.js — Palette INTERFACE.
 *
 * A palette is the mapping from a normalized scalar t in [0, 1] to an RGB
 * colour. It deliberately knows nothing about WebGL: the renderer turns a
 * palette into a 1-D texture via toTextureData(). Concrete palettes live in
 * palettes.js.
 *
 * Contract for subclasses:
 *   get name()        -> human-readable label (shown in the sidebar)
 *   colorAt(t)        -> [r, g, b], each component a float in [0, 1]
 *
 * No modules: this defines globals (Palette, toTextureData, colour helpers)
 * consumed by later scripts.
 */

class Palette {
	/** @returns {string} display name */
	get name() {
		return "Unnamed";
	}

	/**
	 * Map a normalized position to a colour.
	 * @param {number} t value in [0, 1]
	 * @returns {[number, number, number]} rgb, each in [0, 1]
	 */
	colorAt(t) {
		throw new Error("Palette.colorAt() must be implemented by a subclass");
	}
}

/**
 * Sample a palette evenly across [0, 1] into a tightly packed RGBA byte array,
 * suitable for uploading as a `size x 1` RGBA8 texture. Alpha is always 255.
 *
 * Sampling at the texel centre ((i + 0.5) / size) keeps the gradient symmetric
 * and plays nicely with LINEAR filtering + CLAMP_TO_EDGE in the renderer.
 *
 * @param {Palette} palette
 * @param {number} size number of texels (palette resolution)
 * @returns {Uint8Array} length size * 4
 */
function toTextureData(palette, size) {
	const data = new Uint8Array(size * 4);
	for (let i = 0; i < size; i++) {
		const t = (i + 0.5) / size;
		const rgb = palette.colorAt(t);
		const o = i * 4;
		data[o + 0] = clampByte(rgb[0] * 255);
		data[o + 1] = clampByte(rgb[1] * 255);
		data[o + 2] = clampByte(rgb[2] * 255);
		data[o + 3] = 255;
	}
	return data;
}

/** Clamp + round a 0..255 float into a valid byte. */
function clampByte(v) {
	v = Math.round(v);
	if (v < 0) return 0;
	if (v > 255) return 255;
	return v;
}

/** Linear interpolation between two scalars. */
function lerp(a, b, t) {
	return a + (b - a) * t;
}

/**
 * Convert HSV to RGB. All inputs and outputs are in [0, 1] (h wraps).
 * @returns {[number, number, number]}
 */
function hsvToRgb(h, s, v) {
	h = (h - Math.floor(h)) * 6.0;   // wrap hue into [0, 6)
	const i = Math.floor(h);
	const f = h - i;
	const p = v * (1 - s);
	const q = v * (1 - s * f);
	const t = v * (1 - s * (1 - f));
	switch (i % 6) {
		case 0: return [v, t, p];
		case 1: return [q, v, p];
		case 2: return [p, v, t];
		case 3: return [p, q, v];
		case 4: return [t, p, v];
		default: return [v, p, q];
	}
}
