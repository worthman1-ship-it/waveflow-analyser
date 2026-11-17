// Second-order sections (a0 normalised to 1), bilinear transform, Butterworth band-pass design.

export interface Section { b0: number; b1: number; b2: number; a1: number; a2: number }
export type Sos = Section[];

export function sosFilter(sos: Sos, x: Float64Array): Float64Array {
  let y = Float64Array.from(x);
  for (const s of sos) {
    const { b0, b1, b2, a1, a2 } = s;
    let z1 = 0, z2 = 0;
    for (let i = 0; i < y.length; i++) {
      const xi = y[i];
      const yi = b0 * xi + z1;
      z1 = b1 * xi - a1 * yi + z2;
      z2 = b2 * xi - a2 * yi;
      y[i] = yi;
    }
  }
  return y;
}

/** Magnitude response of an SOS cascade at frequency f (Hz). */
export function sosMagnitude(sos: Sos, f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  let mag = 1;
  for (const { b0, b1, b2, a1, a2 } of sos) {
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
    const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    mag *= Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
  return mag;
}

/** Pre-warp an analog angular frequency so the digital filter hits it exactly. */
export function prewarp(w: number, fs: number): number {
  // Above ~0.45 fs tan() blows up / wraps; leave such corners unwarped.
  return w / (2 * fs) < 0.45 * Math.PI ? 2 * fs * Math.tan(w / (2 * fs)) : w;
}

/** Bilinear transform of analog H(s) = (n2 s² + n1 s + n0) / (d2 s² + d1 s + d0). */
export function bilinear(n: [number, number, number], d: [number, number, number], fs: number): Section {
  const c = 2 * fs, c2 = c * c;
  const [n2, n1, n0] = n, [d2, d1, d0] = d;
  const B0 = n2 * c2 + n1 * c + n0, B1 = 2 * n0 - 2 * n2 * c2, B2 = n2 * c2 - n1 * c + n0;
  const A0 = d2 * c2 + d1 * c + d0, A1 = 2 * d0 - 2 * d2 * c2, A2 = d2 * c2 - d1 * c + d0;
  return { b0: B0 / A0, b1: B1 / A0, b2: B2 / A0, a1: A1 / A0, a2: A2 / A0 };
}

export function scaleSos(sos: Sos, g: number): Sos {
  if (!sos.length) return sos;
  const [s, ...rest] = sos;
  return [{ ...s, b0: s.b0 * g, b1: s.b1 * g, b2: s.b2 * g }, ...rest];
}

/**
 * Digital Butterworth band-pass of prototype order `order` (filter order 2·order),
 * band edges f1..f2 Hz. Designed by LP→BP transform of the analog prototype poles,
 * then bilinear; normalised to unity gain at the (warped) centre frequency.
 */
export function butterBandpass(order: number, f1: number, f2: number, fs: number): Sos {
  const c = 2 * fs;
  const W1 = c * Math.tan((Math.PI * f1) / fs), W2 = c * Math.tan((Math.PI * f2) / fs);
  const w0sq = W1 * W2, bw = W2 - W1;
  const sos: Sos = [];
  for (let k = 0; k < order; k++) {
    // Prototype pole p = exp(iθ), left half-plane.
    const th = (Math.PI * (2 * k + order + 1)) / (2 * order);
    const pr = Math.cos(th) * bw / 2, pi = Math.sin(th) * bw / 2;
    // s = p·bw/2 ± sqrt((p·bw/2)² − w0²)
    const qr = pr * pr - pi * pi - w0sq, qi = 2 * pr * pi;
    const mod = Math.hypot(qr, qi);
    const sr = Math.sqrt((mod + qr) / 2), si = Math.sign(qi || 1) * Math.sqrt((mod - qr) / 2);
    for (const sign of [1, -1]) {
      const ar = pr + sign * sr, ai = pi + sign * si;
      // Keep only poles in the upper half-plane; their conjugates complete each section.
      if (ai <= 0) continue;
      // z = (c + s) / (c − s)
      const nr = c + ar, ni = ai, dr = c - ar, di = -ai;
      const dd = dr * dr + di * di;
      const zr = (nr * dr + ni * di) / dd, zi = (ni * dr - nr * di) / dd;
      sos.push({ b0: 1, b1: 0, b2: -1, a1: -2 * zr, a2: zr * zr + zi * zi });
    }
  }
  const fc = (fs / Math.PI) * Math.atan(Math.sqrt(w0sq) / c);
  return scaleSos(sos, 1 / sosMagnitude(sos, fc, fs));
}
