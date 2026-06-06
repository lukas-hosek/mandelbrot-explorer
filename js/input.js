/*
 * input.js — pan / zoom / pinch via Pointer Events.
 *
 * Pointer Events unify mouse, touch and pen across Chromium and Firefox, so a
 * single code path handles desktop drag/wheel and mobile pan/pinch:
 *   - 1 active pointer  -> pan (drag).
 *   - 2 active pointers -> pinch zoom about the midpoint + pan by midpoint drift.
 *   - wheel             -> zoom toward the cursor.
 *
 * This module only TRANSLATES DOM events into semantic gestures; the actual
 * complex-plane maths lives in the App (panByPixels / zoomAtClient), which owns
 * the view state and devicePixelRatio handling.
 */

class InputController {
	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {App} app
	 */
	constructor(canvas, app) {
		this.canvas = canvas;
		this.app = app;

		// pointerId -> last known {x, y} in client (CSS) pixels.
		this.pointers = new Map();
		// Previous pinch state while two pointers are down.
		this._pinchPrev = null;

		this._bind();
	}

	_bind() {
		const c = this.canvas;
		c.addEventListener("pointerdown", (e) => this._onPointerDown(e));
		c.addEventListener("pointermove", (e) => this._onPointerMove(e));
		c.addEventListener("pointerup", (e) => this._onPointerUp(e));
		c.addEventListener("pointercancel", (e) => this._onPointerUp(e));
		// Wheel must be non-passive so we can preventDefault the page scroll.
		c.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
		// Suppress the context menu so right-drag etc. never interrupts.
		c.addEventListener("contextmenu", (e) => e.preventDefault());
	}

	_onPointerDown(e) {
		// Only the left mouse button initiates a drag; touch/pen always do.
		if (e.pointerType === "mouse" && e.button !== 0) {
			return;
		}
		this.canvas.setPointerCapture(e.pointerId);
		this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (this.pointers.size === 2) {
			this._pinchPrev = this._pinchState();
		}
	}

	_onPointerMove(e) {
		const p = this.pointers.get(e.pointerId);
		if (!p) {
			return; // not a pressed/tracked pointer
		}

		const count = this.pointers.size;
		if (count === 1) {
			// Single-pointer drag -> pan by the movement delta.
			const dx = e.clientX - p.x;
			const dy = e.clientY - p.y;
			p.x = e.clientX;
			p.y = e.clientY;
			this.app.panByPixels(dx, dy);
		} else if (count >= 2) {
			// Two-pointer pinch: update this pointer, then recompute state.
			p.x = e.clientX;
			p.y = e.clientY;
			const cur = this._pinchState();
			if (this._pinchPrev) {
				// Spreading fingers (cur.dist > prev.dist) -> factor < 1 -> zoom in.
				const factor = this._pinchPrev.dist / cur.dist;
				this.app.zoomAtClient(factor, cur.midX, cur.midY);
				// Also pan by the midpoint drift for a natural two-finger move.
				const mdx = cur.midX - this._pinchPrev.midX;
				const mdy = cur.midY - this._pinchPrev.midY;
				this.app.panByPixels(mdx, mdy);
			}
			this._pinchPrev = cur;
		}
	}

	_onPointerUp(e) {
		if (this.canvas.hasPointerCapture(e.pointerId)) {
			this.canvas.releasePointerCapture(e.pointerId);
		}
		this.pointers.delete(e.pointerId);
		// Drop the pinch baseline once fewer than two pointers remain. A leftover
		// pointer keeps its last position, so the next move pans cleanly.
		if (this.pointers.size < 2) {
			this._pinchPrev = null;
		}
	}

	/** Distance + midpoint of the (first two) active pointers, in CSS pixels. */
	_pinchState() {
		const it = this.pointers.values();
		const a = it.next().value;
		const b = it.next().value;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		return {
			dist: Math.hypot(dx, dy) || 1,
			midX: (a.x + b.x) * 0.5,
			midY: (a.y + b.y) * 0.5,
		};
	}

	_onWheel(e) {
		e.preventDefault();
		// Normalize wheel delta across browsers (Firefox often reports lines).
		let d = e.deltaY;
		if (e.deltaMode === 1) {
			d *= 16;   // lines -> approx pixels
		} else if (e.deltaMode === 2) {
			d *= 100;  // pages -> approx pixels
		}
		// Scroll up (d < 0) -> factor < 1 -> zoom in toward the cursor.
		const factor = Math.exp(d * 0.0015);
		this.app.zoomAtClient(factor, e.clientX, e.clientY);
	}
}
