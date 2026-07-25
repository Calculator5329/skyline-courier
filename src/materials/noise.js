import * as THREE from 'three'

/**
 * The shared macro noise field.
 *
 * Every "this is not an untextured box" trick in shader.js — the relief tilt,
 * the two-scale albedo/roughness drift, the dust wedge, the de-tiling mask —
 * reads from ONE small tiling RGBA texture generated here on the CPU at load.
 * One texture, four bands, four fetches per fragment at most.
 *
 * It is deliberately CPU-side and integer-seeded: the world must look identical
 * on every reload, and a GPU bake would make that depend on driver rounding.
 *
 * Channel contract (all bands are periodic, so the texture tiles seamlessly):
 *   r — 3-octave fbm, base 3 cells.  The general "which part of this wall" band.
 *   g — 3-octave fbm, base 3 cells, different seed. Roughness + hue drift.
 *   b — 2-octave fbm, base 2 cells.  SMOOTH, because this is the only band that
 *       gets finite-differenced for the relief tilt; a high-frequency band would
 *       differentiate into noise instead of into swales and ridges.
 *   a — 3-octave fbm, base 6 cells.  The finest band: breaks up wedge/dust masks
 *       so they never read as a clean analytic gradient.
 */

/** Integer hash on a lattice point. Deterministic across machines. */
function hashLattice(ix, iy, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1013904223)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * Periodic value noise. `u`,`v` are in 0..1 texture space; `period` is the
 * number of lattice cells across the whole texture, and the lattice wraps at
 * that period — which is what makes the result tile.
 */
function valueNoise(u, v, period, seed) {
  const x = u * period
  const y = v * period
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  // Smoothstep interpolation: linear interpolation leaves lattice creases that
  // survive the fbm sum and show up as a faint diamond grid on big surfaces.
  const su = xf * xf * (3 - 2 * xf)
  const sv = yf * yf * (3 - 2 * yf)

  const x0 = ((xi % period) + period) % period
  const y0 = ((yi % period) + period) % period
  const x1 = (x0 + 1) % period
  const y1 = (y0 + 1) % period

  const a = hashLattice(x0, y0, seed)
  const b = hashLattice(x1, y0, seed)
  const c = hashLattice(x0, y1, seed)
  const d = hashLattice(x1, y1, seed)

  const top = a + (b - a) * su
  const bot = c + (d - c) * su
  return top + (bot - top) * sv
}

/** Fractal sum. Each octave doubles the lattice period, so every octave tiles. */
function fbm(u, v, basePeriod, octaves, seed) {
  let sum = 0
  let amp = 1
  let norm = 0
  let period = basePeriod
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u, v, period, seed + o * 7919)
    norm += amp
    amp *= 0.5
    period *= 2
  }
  return sum / norm
}

let _macro = null

/**
 * The shared macro texture. 128px is plenty: it is stretched over ~12 m of
 * world, so a texel is ~9 cm and nothing in it is meant to be resolved as
 * detail — it is a field, not a pattern.
 */
export function macroTexture(size = 128) {
  if (_macro) return _macro

  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sample at texel centres so the periodicity lines up with the wrap.
      const u = (x + 0.5) / size
      const v = (y + 0.5) / size
      const i = (y * size + x) * 4
      data[i + 0] = (fbm(u, v, 3, 3, 0x1a3) * 255) | 0
      data[i + 1] = (fbm(u, v, 3, 3, 0x77f) * 255) | 0
      data[i + 2] = (fbm(u, v, 2, 2, 0x2c9) * 255) | 0
      data[i + 3] = (fbm(u, v, 6, 3, 0x5e1) * 255) | 0
    }
  }

  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  // Data, not colour: sRGB-decoding this would skew every band toward black.
  t.colorSpace = THREE.NoColorSpace
  t.name = 'macro-noise'
  t.needsUpdate = true
  _macro = t
  return t
}

/** Texels across the macro texture — the shader needs it for the finite difference. */
export const MACRO_SIZE = 128
