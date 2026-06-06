/*
 * doubledouble.js — extended-precision arithmetic (no dependencies).
 *
 * A "double-double" represents a real number as the UNEVALUATED SUM of two IEEE
 * doubles, hi + lo, with |lo| <= 0.5 ulp(hi). That yields ~106 bits of mantissa
 * (~31 decimal digits) — roughly twice a plain double — which is what lets the
 * Orbit engine seed its reference orbit from a centre coordinate carrying far
 * more than 53 bits, and so zoom past the single/double precision wall.
 *
 * The building blocks are "error-free transforms": floating-point operations
 * that return both the rounded result AND the exact rounding error as a second
 * double. JavaScript has no fused multiply-add (no Math.fma), so the product
 * transform uses Veltkamp splitting (Dekker's algorithm) instead of an FMA.
 *
 * Algorithms follow the standard QD / Briggs double-double formulations.
 *
 * No modules: this defines globals (DoubleDouble, ComplexDD) consumed by
 * engine-orbit.js and app.js.
 */

/* Veltkamp split constant: 2^27 + 1. Splitting a 53-bit double by this factor
 * yields two 26-/27-bit halves whose product is exact. */
const DD_SPLIT = 134217729;

/* ---- error-free transforms (operate on plain numbers) ---- */

/* a + b = s + e, exactly. No assumption about the magnitudes of a and b. */
function ddTwoSum(a, b) {
	const s = a + b;
	const bb = s - a;
	const e = (a - (s - bb)) + (b - bb);
	return [s, e];
}

/* a + b = s + e, exactly, assuming |a| >= |b| (cheaper than ddTwoSum). */
function ddQuickTwoSum(a, b) {
	const s = a + b;
	const e = b - (s - a);
	return [s, e];
}

/* a * b = p + e, exactly, via Veltkamp splitting (no FMA available in JS). */
function ddTwoProd(a, b) {
	const p = a * b;
	let t = DD_SPLIT * a;
	const ahi = t - (t - a);
	const alo = a - ahi;
	t = DD_SPLIT * b;
	const bhi = t - (t - b);
	const blo = b - bhi;
	const e = ((ahi * bhi - p) + ahi * blo + alo * bhi) + alo * blo;
	return [p, e];
}

/**
 * A double-double number: value = hi + lo, with lo a correction term holding the
 * low-order bits that hi cannot represent. Instances are immutable; every op
 * returns a fresh DoubleDouble. (Allocation over a few-thousand-iteration orbit
 * is negligible, and immutability keeps the maths easy to read.)
 */
class DoubleDouble {
	/**
	 * @param {number} hi leading double
	 * @param {number} [lo] correction (defaults 0); callers pass a normalized pair
	 */
	constructor(hi, lo) {
		this.hi = hi;
		this.lo = lo || 0;
	}

	/** Promote a plain double (exactly representable as hi, lo = 0). */
	static fromNumber(x) {
		return new DoubleDouble(x, 0);
	}

	/** Collapse back to the nearest plain double. */
	toNumber() {
		return this.hi + this.lo;
	}

	/** this + plain-double x. */
	addNumber(x) {
		let [s, e] = ddTwoSum(this.hi, x);
		e += this.lo;
		[s, e] = ddQuickTwoSum(s, e);
		return new DoubleDouble(s, e);
	}

	/** this + other (both double-double). */
	add(other) {
		// Sum the hi parts and the lo parts with their errors, then renormalize.
		let [s, e] = ddTwoSum(this.hi, other.hi);
		const [s2, e2] = ddTwoSum(this.lo, other.lo);
		e += s2;
		[s, e] = ddQuickTwoSum(s, e);
		e += e2;
		[s, e] = ddQuickTwoSum(s, e);
		return new DoubleDouble(s, e);
	}

	/** this - other. */
	sub(other) {
		return this.add(other.neg());
	}

	/** -this. */
	neg() {
		return new DoubleDouble(-this.hi, -this.lo);
	}

	/** this * other (both double-double). */
	mul(other) {
		let [p, e] = ddTwoProd(this.hi, other.hi);
		// Cross terms; the lo*lo term is below the precision we keep.
		e += this.hi * other.lo + this.lo * other.hi;
		[p, e] = ddQuickTwoSum(p, e);
		return new DoubleDouble(p, e);
	}
}

/**
 * A complex number with double-double real and imaginary parts. Only the
 * operations the reference orbit needs are provided.
 */
class ComplexDD {
	/**
	 * @param {DoubleDouble} re
	 * @param {DoubleDouble} im
	 */
	constructor(re, im) {
		this.re = re;
		this.im = im;
	}

	/** Build from two plain doubles. */
	static fromNumbers(re, im) {
		return new ComplexDD(DoubleDouble.fromNumber(re), DoubleDouble.fromNumber(im));
	}

	/**
	 * The Mandelbrot step z -> z^2 + c.
	 *   re' = re^2 - im^2 + c.re
	 *   im' = 2*re*im   + c.im
	 * @param {ComplexDD} c
	 * @returns {ComplexDD}
	 */
	sqrAdd(c) {
		const rr = this.re.mul(this.re);
		const ii = this.im.mul(this.im);
		const ri = this.re.mul(this.im);
		const newRe = rr.sub(ii).add(c.re);
		const newIm = ri.add(ri).add(c.im); // 2*re*im
		return new ComplexDD(newRe, newIm);
	}
}
