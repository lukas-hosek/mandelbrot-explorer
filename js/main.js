/*
 * main.js — bootstrap.
 *
 * Loaded last. Constructs the App once the DOM is ready, and shows the error
 * overlay if WebGL2 (or anything else during startup) is unavailable.
 */

(function () {
	function showError(message) {
		const overlay = document.getElementById("error-overlay");
		const msgEl = document.getElementById("error-message");
		if (msgEl && message) {
			msgEl.textContent = message;
		}
		if (overlay) {
			overlay.hidden = false;
		}
	}

	function boot() {
		const canvas = document.getElementById("view");
		try {
			const app = new App(canvas);
			app.init();
			// Expose for ad-hoc debugging from the console.
			window.mandelApp = app;
		} catch (err) {
			console.error("Mandelbrot Explorer failed to start:", err);
			showError(err && err.message ? err.message : String(err));
		}
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", boot);
	} else {
		boot();
	}
})();
