/*
 * engine.js — MandelbrotEngine INTERFACE.
 *
 * An engine answers one question: "given the current view, produce a frame".
 * Everything else (the GL context, the fullscreen geometry, the view UBO, the
 * palette texture, canvas sizing, the rAF loop) is owned by the Renderer and
 * handed to the engine as a `shared` bundle. This split is deliberate: it lets
 * a future CPU-assisted / async engine slot in behind the exact same contract
 * as today's pure-GPU FragmentMandelbrotEngine.
 *
 * The `shared` object passed to init()/render() looks like:
 *   {
 *     gl,                                   // WebGL2RenderingContext
 *     quad:    { vao },                     // fullscreen-triangle VAO (3 verts)
 *     viewUBO: { buffer, bindingPoint },    // the "constant buffer" (std140)
 *     palette: { texture, unit },           // 1-D palette texture + its texunit
 *     viewport:{ width, height, dpr },      // drawing-buffer size in device px
 *   }
 *
 * Lifecycle / call order from the Renderer:
 *   init(shared)                once, after GL + shared resources exist
 *   onResize(w, h)              whenever the drawing buffer changes size
 *   onViewChanged(view)         whenever pan/zoom/iterations/palette change
 *   update(dtMs)  -> bool       once per animation frame, BEFORE render
 *   isReady()     -> bool       may the current view be drawn yet?
 *   render(shared)             draw a frame
 *   dispose()                  release GL resources
 *
 * --- Why these particular hooks (future async engine) ---
 * A perturbation-theory engine, for example, will want to compute a
 * high-precision reference orbit on the CPU (possibly in a Web Worker) whenever
 * the view changes. It would:
 *   - onViewChanged(): post the new centre to the worker and return immediately;
 *   - update(): poll the worker, upload finished data to a texture, and return
 *     `true` while work is still pending so the Renderer keeps the loop alive;
 *   - isReady(): return false until the first result is in (the Renderer can
 *     then show a low-res preview or a spinner);
 *   - render(): sample the precomputed data texture in its own shader.
 * The trivial engine simply no-ops the async hooks.
 */

class MandelbrotEngine {
	/** @returns {string} short identifier, e.g. for diagnostics/UI */
	get name() {
		return "abstract";
	}

	/**
	 * One-time setup. Compile shaders and allocate engine-private resources.
	 * The shared GL objects already exist and may be referenced/bound here.
	 * @param {object} shared see file header
	 */
	init(shared) {}

	/**
	 * The drawing buffer changed size (device pixels). Most GPU engines can
	 * ignore this because resolution is delivered through the view UBO, but an
	 * engine holding screen-sized offscreen targets would reallocate here.
	 * @param {number} width
	 * @param {number} height
	 */
	onResize(width, height) {}

	/**
	 * The view changed (pan, zoom, iteration count, or palette). Synchronous
	 * engines can ignore this; async engines kick off precomputation and return
	 * immediately. Must NOT block.
	 * @param {object} view the app's canonical view state (see app.js)
	 */
	onViewChanged(view) {}

	/**
	 * Advance any pending asynchronous work. Called once per frame before
	 * render().
	 * @param {number} dtMs milliseconds since the previous frame
	 * @returns {boolean} true if more work is pending (keep animating)
	 */
	update(dtMs) {
		return false;
	}

	/**
	 * @returns {boolean} whether the current view can be rendered now. Async
	 * engines may return false while precomputing.
	 */
	isReady() {
		return true;
	}

	/**
	 * Render a single frame into the currently bound framebuffer (the canvas).
	 * The shared UBO and palette texture are already up to date.
	 * @param {object} shared see file header
	 */
	render(shared) {}

	/** Release all GL resources owned by this engine. */
	dispose() {}
}

/* ---- Shared GLSL/program helpers (used by engine implementations) ---- */

/**
 * Compile a shader, throwing a readable error (with the info log) on failure.
 * @param {WebGL2RenderingContext} gl
 * @param {number} type gl.VERTEX_SHADER | gl.FRAGMENT_SHADER
 * @param {string} source
 * @returns {WebGLShader}
 */
function compileShader(gl, type, source) {
	const shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const log = gl.getShaderInfoLog(shader);
		gl.deleteShader(shader);
		const kind = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
		throw new Error("Failed to compile " + kind + " shader:\n" + log);
	}
	return shader;
}

/**
 * Link a program from vertex + fragment GLSL source.
 * @param {WebGL2RenderingContext} gl
 * @param {string} vsSource
 * @param {string} fsSource
 * @returns {WebGLProgram}
 */
function createProgram(gl, vsSource, fsSource) {
	const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
	const program = gl.createProgram();
	gl.attachShader(program, vs);
	gl.attachShader(program, fs);
	gl.linkProgram(program);
	// Shaders can be detached/deleted once linked.
	gl.detachShader(program, vs);
	gl.detachShader(program, fs);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const log = gl.getProgramInfoLog(program);
		gl.deleteProgram(program);
		throw new Error("Failed to link program:\n" + log);
	}
	return program;
}
