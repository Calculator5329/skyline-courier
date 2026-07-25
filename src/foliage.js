import * as THREE from 'three'
import { PALETTE } from './materials.js'
import { rng } from './materials/textures.js'

/**
 * THE VEGETATION LAYER — instanced, alpha-tested, wind-driven plant cards, and
 * the atlas they are cut from. No image files, ever.
 *
 * The art review's finding, which this file exists to answer: "There is not one
 * vine, one ivy strand, one hanging plant or one moss wedge on any piece of
 * architecture in any of the eight frames." docs/art-direction.md is explicit
 * that vegetation is "a primary element, not a garnish", and
 * docs/geometry-unlock.md sizes it: roughly 40% of the reference by screen
 * area, against zero here.
 *
 * Four layers, each answering a different failure:
 *
 *   A. THE ATLAS (`buildAtlas`). One canvas, painted once at load, cut into a
 *      grid of species cells: leaf clusters, ivy sprigs, grass tufts, flower
 *      clusters, fern fronds, a moss wedge and two hanging ivy strands. The
 *      alpha is DILATED into the transparent region and the mip chain is built
 *      by hand in premultiplied space with coverage preservation, because the
 *      two classic ways foliage looks cheap are a black fringe round every leaf
 *      (unpremultiplied mip filtering) and grass that evaporates at 30 m
 *      (naive alpha-test mips).
 *   B. THE CARD (`crossQuadGeometry`). Two or three quads at even yaw
 *      intervals, so a plant reads as a volume from any approach angle rather
 *      than turning into a razor blade as you run past it. Vertex normals are
 *      bent onto a sphere, which is what makes a flat card shade like a bush.
 *   C. THE FIELD (`FoliageField`). One InstancedMesh per atlas page. Position,
 *      yaw, non-uniform scale in `instanceMatrix`; colour jitter in
 *      `instanceColor`; species cell, wind amplitude, phase jitter and the
 *      hang flag packed into one instanced vec4. Wind and distance fade are
 *      vertex-shader work with a single shared time uniform.
 *   D. THE SCATTERERS (`scatterOnBox`, `hangFromEdge`, `vineRope`). Callers
 *      dress a platform top or drape a lip; they never hand-place instances.
 *
 * ============================ THE SAFETY ARGUMENT ===========================
 * CLAUDE.md rule 2: a visible surface at walkable height is ALWAYS solid. Every
 * instance this file emits is VISUAL ONLY — there is no path from here to
 * `collision.js`, by construction. That makes the rule's converse the thing to
 * enforce: foliage must never LOOK like something you can stand on.
 *
 * Two mechanical guards, both in `scatterOnBox`:
 *   - a height cap (`maxHeight`, default 0.35 m, and every ground species is
 *     under it by default) so a tuft can never present as a ledge; and
 *   - an inset of at least half the card's width from the box's footprint, so
 *     no card overhangs the collider that the caller reserved.
 * `hangFromEdge` emits strictly BELOW its lip, so by construction it can only
 * exist under an overhang — the same argument `kit.vineCurtain` makes.
 * ============================================================================
 *
 * ================= WHY ALPHA TEST + ALPHA-TO-COVERAGE, NOT BLENDING ==========
 * Alpha BLENDING would need every card sorted back-to-front against every other
 * card every frame, from a camera that moves at 47 km/h. It cannot be done
 * per-instance inside one InstancedMesh at all, so the sort would be per-draw,
 * which is exactly the flicker-as-you-turn artefact that reads as a broken
 * game. Foliage is also 100%-or-0% opaque nearly everywhere; the fractional
 * texels are a one-texel rim round each leaf.
 *
 * So: `alphaTest 0.5`, `transparent false` — the cards render in the OPAQUE
 * pass, depth-write on, in whatever order the renderer likes, and the result is
 * order-independent and stable.
 *
 * `alphaToCoverage true` on top of that buys back the one thing a hard test
 * loses. The pipeline's HDR target runs 4x MSAA (`render/index.js`, `samples`),
 * and three's own `alphatest_fragment` chunk turns the test into a
 * `smoothstep( alphaTest, alphaTest + fwidth(a), a )` when ALPHA_TO_COVERAGE is
 * defined, so the leaf edge resolves across four samples instead of stair-
 * stepping. It also gives the distance fade below a real dissolve for free.
 * On a context with no samples it degrades to precisely the hard test — the
 * feature can never break the frame, only fail to soften it.
 * ============================================================================
 */

// ---------------------------------------------------------------- the palette

/**
 * The green ramp, anchored on `PALETTE.moss` so a palette decision made in
 * materials.js propagates here instead of being re-litigated. Vegetation and
 * moss are the same substance at two scales and they must not disagree.
 */
const GREEN = {
  /** The shadowed interior of a cluster: the darkest thing a leaf card holds. */
  deep: 0x2f5c33,
  /** The body colour. Lush and saturated — see PALETTE.moss's note. */
  mid: PALETTE.moss,
  /** Sun-struck edges and new growth at a shoot tip. */
  bright: 0xa2cc5c,
  /** Blue-green, for the hollows of a clump and for fern shade. */
  cool: 0x4f8f74,
  /** Woody stems and petioles — a warm olive, not a green. */
  stem: 0x7a7842,
  /** The occasional yellowed or drying leaf. Two or three per cluster is the
   *  difference between a plant and a swatch. */
  dry: 0xb9a659,
}

/**
 * Flowers, from the brief's "small orange/red/white flowers".
 *
 * Deliberately SMALL in area. Flowers are the only chroma in the frame that is
 * not sandstone, brass or green, so they read as accents at a few percent
 * coverage and as a novelty rug at twenty.
 */
const BLOOM = {
  orange: 0xe6883a,
  red: 0xd0503a,
  white: 0xf3ead4,
  /** Anther/centre dot — warm, one step off the petal so it reads at 2 px. */
  eye: 0xf0c552,
}

// ------------------------------------------------------------------ the atlas

/**
 * 1024 across a 4x4 grid is 256 px per species cell.
 *
 * Sized against the closest a player ever gets: a tuft at the edge of a landing
 * is ~0.8 m from the eye at a 76-degree FOV, which puts a 0.25 m card at
 * roughly 260 screen px on a 1600-wide capture. 256 is therefore the resolution
 * at which the nearest leaf is still texel-for-pixel and not a smear, and one
 * 1024 RGBA page with mips is 5.6 MB — a rounding error next to the four
 * 512 ORM sets materials/textures.js already builds.
 */
const ATLAS_SIZE = 1024
const ATLAS_COLS = 4
const ATLAS_ROWS = 4
const CELL = ATLAS_SIZE / ATLAS_COLS

/**
 * Transparent margin inside every cell, in texels.
 *
 * Two jobs. It keeps a leaf off the cell boundary so bilinear filtering at the
 * seam cannot smear one species into its neighbour, and it gives the mip chain
 * somewhere to bleed: at mip 3 a cell is 32 px and the filter kernel reaches
 * ~2 texels, which 20 texels at mip 0 covers with room to spare.
 */
const CELL_MARGIN = 20

/**
 * The alpha threshold the material tests at, and therefore the threshold the
 * mip coverage correction has to preserve. One constant, used in both places,
 * because a mip chain built for one threshold and sampled at another is exactly
 * how foliage grows or shrinks with distance.
 */
const ALPHA_TEST = 0.5

/** Default atlas seed. Determinism: same world, same plants, every reload. */
const ATLAS_SEED = 0xF0117A

/**
 * The species table. `cells` are indices into the atlas grid, row-major from
 * the TOP-LEFT of the canvas (see `flipRows` for why that is not the same as
 * the uv origin).
 *
 * `aspect` is width/height of the card, so a caller asks for a HEIGHT in metres
 * and gets a plant of the right proportion without knowing what was painted.
 * `wind` is a per-species multiplier on the global amplitude: grass whips,
 * ferns nod, a moss wedge barely moves. `hang` flips the wind's pivot to the
 * top of the card — see the vertex shader.
 */
const SPECIES = {
  /** Broadleaf clusters. The mass of any planted bed. */
  leaf: { cells: [0, 1, 2], size: [0.34, 0.78], aspect: 1.25, wind: 1.0, hang: 0 },
  /** Ivy sprigs, upright — for a wall base or the shady side of a plinth. */
  ivy: { cells: [3, 4], size: [0.26, 0.55], aspect: 0.85, wind: 0.9, hang: 0 },
  /** Grass tufts. The cheapest, smallest, most numerous thing here. */
  grass: { cells: [5, 6, 7], size: [0.15, 0.30], aspect: 1.30, wind: 1.5, hang: 0 },
  /** Flower clusters — the accent. Never the mass. */
  flower: { cells: [8, 9, 10], size: [0.17, 0.31], aspect: 1.05, wind: 1.25, hang: 0 },
  /** Fern fronds, for damp shade under an arch or beside a waterfall. */
  fern: { cells: [11, 12], size: [0.30, 0.58], aspect: 1.15, wind: 0.75, hang: 0 },
  /**
   * The moss wedge. Wide, low and nearly static: this is the geometry half of
   * docs/roadmap.md's "moss wedge creeping up walls", scattered along a
   * floor/wall junction where the shader term alone measured invisible.
   */
  moss: { cells: [13], size: [0.17, 0.34], aspect: 1.5, wind: 0.2, hang: 0 },
  /** Hanging ivy. Painted attached at the TOP of its cell; `hang` moves the
   *  sway to the free bottom end. This is the mass that `hangFromEdge` drapes. */
  hangingIvy: { cells: [14, 15], size: [0.9, 2.4], aspect: 0.52, wind: 1.15, hang: 1 },
}

/**
 * Module-level atlas cache, keyed BY SEED.
 *
 * A Map rather than a single slot: a single slot would have to evict (and
 * dispose) the previous atlas when a second field asked for a different seed,
 * which would pull the texture out from under every field already built on it.
 * In practice there is one seed and one entry.
 */
const _atlasCache = new Map()

/**
 * Build (or return) the shared foliage atlas.
 *
 * @param {number} seed
 * @returns {{seed:number, cols:number, rows:number, cells:number,
 *            pages:Array<{texture:THREE.DataTexture, index:number}>}}
 */
export function foliageAtlas(seed = ATLAS_SEED) {
  let a = _atlasCache.get(seed)
  if (!a) { a = buildAtlas(seed); _atlasCache.set(seed, a) }
  return a
}

/** Release every shared atlas. Only a hot reload and a teardown need this. */
export function disposeFoliageAtlas() {
  for (const a of _atlasCache.values()) {
    for (const p of a.pages) p.texture.dispose()
  }
  _atlasCache.clear()
}

function buildAtlas(seed) {
  const rand = rng(seed)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = ATLAS_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE)

  for (let i = 0; i < ATLAS_COLS * ATLAS_ROWS; i++) {
    const cx = (i % ATLAS_COLS) * CELL
    const cy = Math.floor(i / ATLAS_COLS) * CELL
    ctx.save()
    ctx.translate(cx, cy)
    // Every painter draws inside a 0..CELL box, base at the bottom edge minus
    // the margin, with canvas Y pointing DOWN.
    paintCell(ctx, i, rand)
    ctx.restore()
  }

  const img = ctx.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE)
  const base = flipRows(new Uint8Array(img.data.buffer.slice(0)), ATLAS_SIZE)
  dilateColour(base, ATLAS_SIZE, ATLAS_SIZE)
  const mipmaps = buildMipChain(base, ATLAS_SIZE)

  const texture = new THREE.DataTexture(base, ATLAS_SIZE, ATLAS_SIZE,
    THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.name = 'sc-foliage-atlas'
  texture.colorSpace = THREE.SRGBColorSpace
  // ClampToEdge, not Repeat: uvs are remapped into a cell in the vertex shader
  // and a wrap here would only ever be a bug wearing a feature's clothes.
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = false     // we built a better chain than GL will
  texture.mipmaps = mipmaps
  // Grass and leaves are the most grazing-angle-heavy thing in the frame — a
  // deck of tufts seen from eye height is nearly edge-on. three clamps this to
  // the context's maximum, so 4 is a request, not an assumption.
  texture.anisotropy = 4
  texture.needsUpdate = true

  return { seed, cols: ATLAS_COLS, rows: ATLAS_ROWS, cells: ATLAS_COLS * ATLAS_ROWS, pages: [{ texture, index: 0 }] }
}

/**
 * Flip the row order of an RGBA byte array in place-ish.
 *
 * `DataTexture` sets `flipY = false`, so texel row 0 of the array is uv.y = 0.
 * The cards' uv.y = 0 is the plant's BASE, and canvas row 0 is the TOP of the
 * cell. Without this, every plant in the atlas would be painted upside down —
 * or, worse, every painter would have to be written upside down.
 */
function flipRows(data, size) {
  const out = new Uint8Array(data.length)
  const stride = size * 4
  for (let y = 0; y < size; y++) {
    out.set(data.subarray((size - 1 - y) * stride, (size - y) * stride), y * stride)
  }
  return out
}

/**
 * Flood the nearest opaque colour outward into every transparent texel.
 *
 * THE BUG THIS FIXES: a leaf's RGB is only meaningful where its alpha is. The
 * canvas leaves RGB = 0 everywhere else, so a mip filter — or plain bilinear at
 * a grazing angle — averages leaf-green against black and the card grows a dark
 * halo, which is the single most recognisable tell of amateur foliage.
 *
 * A multi-source breadth-first search rather than N dilation passes: every
 * texel is visited exactly once, so this is O(texels) for a full fill instead
 * of O(texels x radius) for a bounded one. ~1M texels, one pass, low
 * milliseconds at load.
 *
 * ALPHA IS NOT TOUCHED. This changes only what colour a transparent texel
 * carries into a filter; the shape is exactly what was painted.
 */
function dilateColour(data, w, h) {
  const n = w * h
  const seen = new Uint8Array(n)
  const queue = new Int32Array(n)
  let qn = 0
  // Seed from anything with meaningful alpha. 8/255 rather than 0: the very
  // faintest antialiased fringe carries colour that is mostly the canvas's
  // black, and seeding from it would spread that black instead of leaf green.
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] > 8) { seen[i] = 1; queue[qn++] = i }
  }
  if (qn === 0 || qn === n) return

  for (let head = 0; head < qn; head++) {
    const i = queue[head]
    const x = i % w
    const y = (i / w) | 0
    const si = i * 4
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0)
      const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0)
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const j = ny * w + nx
      if (seen[j]) continue
      seen[j] = 1
      const dj = j * 4
      data[dj] = data[si]
      data[dj + 1] = data[si + 1]
      data[dj + 2] = data[si + 2]
      // alpha stays 0 — this texel is still nothing, it just knows what colour
      // "nothing" is standing next to.
      queue[qn++] = j
    }
  }
}

/**
 * The mip chain, built by hand, down to 1x1.
 *
 * TWO THINGS GL WOULD GET WRONG:
 *
 * 1. PREMULTIPLIED FILTERING. The colour average is weighted by alpha, which is
 *    the same arithmetic as averaging in premultiplied space and dividing back
 *    out. Storing the result UNpremultiplied is deliberate: the shader alpha-
 *    tests and then uses RGB at full strength, so a premultiplied albedo would
 *    darken exactly the fringe texels the test keeps. Premultiplication belongs
 *    in the filter, not in the stored texel.
 * 2. COVERAGE. A naive box filter halves the number of texels above 0.5 at
 *    every level, so a grass tuft loses half its blades per mip and has
 *    evaporated by mip 4 — the classic "the lawn disappears at 30 m". So each
 *    level's alpha is rescaled by a binary-searched constant that restores the
 *    fraction of texels passing ALPHA_TEST to the fraction at level 0
 *    (Castano's alpha-test mipmap coverage preservation).
 *
 * The correction is switched off below 32x32, where a cell is 8 texels and
 * every card is a sub-pixel speck the distance fade has already dissolved;
 * pushing coverage there just turns each cell into an opaque square.
 */
function buildMipChain(base, size) {
  const mipmaps = [{ data: base, width: size, height: size }]
  const target = coverageOf(base, ALPHA_TEST * 255)

  let src = base
  let sw = size
  while (sw > 1) {
    const dw = sw >> 1
    const dst = new Uint8Array(dw * dw * 4)
    for (let y = 0; y < dw; y++) {
      for (let x = 0; x < dw; x++) {
        const s0 = ((y * 2) * sw + x * 2) * 4
        const s1 = s0 + 4
        const s2 = s0 + sw * 4
        const s3 = s2 + 4
        const a0 = src[s0 + 3], a1 = src[s1 + 3], a2 = src[s2 + 3], a3 = src[s3 + 3]
        const aSum = a0 + a1 + a2 + a3
        const d = (y * dw + x) * 4
        if (aSum > 0) {
          dst[d] = (src[s0] * a0 + src[s1] * a1 + src[s2] * a2 + src[s3] * a3) / aSum
          dst[d + 1] = (src[s0 + 1] * a0 + src[s1 + 1] * a1 + src[s2 + 1] * a2 + src[s3 + 1] * a3) / aSum
          dst[d + 2] = (src[s0 + 2] * a0 + src[s1 + 2] * a1 + src[s2 + 2] * a2 + src[s3 + 2] * a3) / aSum
        } else {
          // Fully transparent quad: the dilation already put a sensible colour
          // in all four, so a plain mean is the right answer and keeps the
          // fill coherent as it climbs the chain.
          dst[d] = (src[s0] + src[s1] + src[s2] + src[s3]) >> 2
          dst[d + 1] = (src[s0 + 1] + src[s1 + 1] + src[s2 + 1] + src[s3 + 1]) >> 2
          dst[d + 2] = (src[s0 + 2] + src[s1 + 2] + src[s2 + 2] + src[s3 + 2]) >> 2
        }
        dst[d + 3] = aSum >> 2
      }
    }

    if (dw >= 32) {
      const k = solveCoverageScale(dst, target)
      if (k !== 1) {
        for (let i = 3; i < dst.length; i += 4) dst[i] = Math.min(255, dst[i] * k)
      }
    }

    mipmaps.push({ data: dst, width: dw, height: dw })
    src = dst
    sw = dw
  }
  return mipmaps
}

/** Fraction of texels whose alpha passes `threshold` (0..255). */
function coverageOf(data, threshold) {
  let hit = 0
  const n = data.length >> 2
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] >= threshold) hit++
  return hit / n
}

/**
 * The alpha multiplier that restores `target` coverage, by bisection.
 *
 * Scaling alpha by k and testing against t is the same as testing against t/k,
 * so the search never has to touch the pixel data — it moves the threshold and
 * counts. 12 iterations over [0.25, 8] lands inside half a percent of coverage,
 * which is well below the level at which an eye can see a mip pop.
 */
function solveCoverageScale(data, target) {
  let lo = 0.25
  let hi = 8
  let k = 1
  for (let i = 0; i < 12; i++) {
    k = (lo + hi) * 0.5
    const c = coverageOf(data, (ALPHA_TEST * 255) / k)
    if (c < target) lo = k          // too thin -> push alpha up
    else hi = k
  }
  return k
}

// --------------------------------------------------------------- the painters

/** Small colour helpers. `THREE.Color` is only used at load, never per frame. */
const _c1 = new THREE.Color()
const _c2 = new THREE.Color()

/** `hex` lightened (k>1) or darkened (k<1) in sRGB, as a css string. */
function shade(hex, k, alpha = 1) {
  _c1.setHex(hex, THREE.SRGBColorSpace).convertLinearToSRGB()
  const r = Math.round(Math.min(255, _c1.r * 255 * k))
  const g = Math.round(Math.min(255, _c1.g * 255 * k))
  const b = Math.round(Math.min(255, _c1.b * 255 * k))
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`
}

/** `a` mixed toward `b`, as a css string. Both are plain sRGB hex. */
function mixHex(a, b, t, alpha = 1) {
  _c1.setHex(a, THREE.SRGBColorSpace).convertLinearToSRGB()
  _c2.setHex(b, THREE.SRGBColorSpace).convertLinearToSRGB()
  const r = Math.round((_c1.r + (_c2.r - _c1.r) * t) * 255)
  const g = Math.round((_c1.g + (_c2.g - _c1.g) * t) * 255)
  const bl = Math.round((_c1.b + (_c2.b - _c1.b) * t) * 255)
  return alpha >= 1 ? `rgb(${r},${g},${bl})` : `rgba(${r},${g},${bl},${alpha})`
}

/**
 * A leaf blade, drawn growing along -Y from the origin (canvas Y is down, so
 * -Y is "up the plant"). Broad at the base, pointed at the tip.
 */
function leafPath(ctx, len, wid, curl) {
  const w = wid * 0.5
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.bezierCurveTo(w * 0.95, -len * 0.16, w * 0.62, -len * 0.70, curl * w, -len)
  ctx.bezierCurveTo(-w * 0.62, -len * 0.70, -w * 0.95, -len * 0.16, 0, 0)
  ctx.closePath()
}

/** The five-lobed ivy leaf. The one silhouette that says "ivy" on its own. */
function ivyLeafPath(ctx, len, wid) {
  const w = wid * 0.5
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.bezierCurveTo(w * 0.55, -len * 0.08, w * 1.02, -len * 0.16, w * 0.94, -len * 0.34)
  ctx.bezierCurveTo(w * 0.84, -len * 0.46, w * 0.42, -len * 0.40, w * 0.46, -len * 0.53)
  ctx.bezierCurveTo(w * 0.54, -len * 0.74, w * 0.30, -len * 0.88, 0, -len)
  ctx.bezierCurveTo(-w * 0.30, -len * 0.88, -w * 0.54, -len * 0.74, -w * 0.46, -len * 0.53)
  ctx.bezierCurveTo(-w * 0.42, -len * 0.40, -w * 0.84, -len * 0.46, -w * 0.94, -len * 0.34)
  ctx.bezierCurveTo(-w * 1.02, -len * 0.16, -w * 0.55, -len * 0.08, 0, 0)
  ctx.closePath()
}

/** A grass blade: tapering, bent by `bend` (in units of its own length). */
function bladePath(ctx, len, wid, bend) {
  ctx.beginPath()
  ctx.moveTo(-wid * 0.5, 0)
  ctx.quadraticCurveTo(bend * len * 0.30 - wid * 0.25, -len * 0.55, bend * len, -len)
  ctx.quadraticCurveTo(bend * len * 0.30 + wid * 0.35, -len * 0.55, wid * 0.5, 0)
  ctx.closePath()
}

/**
 * Fill a leaf with a gradient along its own axis and give it a midrib.
 *
 * The gradient is a MATERIAL statement, not a lit one: a leaf really is paler
 * and yellower at the growing tip and darker at the shaded base, and that is
 * true whichever way the sun is. materials/textures.js's rule — albedo carries
 * material change, never a drawn highlight — holds here.
 */
function fillLeaf(ctx, len, baseCol, tipCol, rib) {
  const g = ctx.createLinearGradient(0, 0, 0, -len)
  g.addColorStop(0, baseCol)
  g.addColorStop(1, tipCol)
  ctx.fillStyle = g
  ctx.fill()
  if (rib) {
    ctx.strokeStyle = rib
    ctx.lineWidth = Math.max(1, len * 0.018)
    ctx.beginPath()
    ctx.moveTo(0, -len * 0.04)
    ctx.lineTo(0, -len * 0.92)
    ctx.stroke()
  }
}

/**
 * Paint one atlas cell.
 *
 * Cells are ordered so the table above stays readable: 0-2 leaf clusters,
 * 3-4 upright ivy, 5-7 grass, 8-10 flowers, 11-12 fern, 13 moss wedge,
 * 14-15 hanging ivy.
 */
function paintCell(ctx, index, rand) {
  const S = CELL
  const M = CELL_MARGIN
  switch (index) {
    case 0: return paintLeafCluster(ctx, S, M, rand, { leaves: 26, tone: 0.0, ivy: true })
    case 1: return paintLeafCluster(ctx, S, M, rand, { leaves: 38, tone: 0.35, ivy: false })
    case 2: return paintLeafCluster(ctx, S, M, rand, { leaves: 46, tone: -0.3, ivy: false })
    case 3: return paintIvySprig(ctx, S, M, rand, { leaves: 11, lean: 0.16 })
    case 4: return paintIvySprig(ctx, S, M, rand, { leaves: 8, lean: -0.22 })
    case 5: return paintGrassTuft(ctx, S, M, rand, { blades: 28, tall: 0.86, seed: false })
    case 6: return paintGrassTuft(ctx, S, M, rand, { blades: 20, tall: 0.98, seed: true })
    case 7: return paintGrassTuft(ctx, S, M, rand, { blades: 34, tall: 0.64, seed: false })
    case 8: return paintFlowerCluster(ctx, S, M, rand, BLOOM.orange, 9)
    case 9: return paintFlowerCluster(ctx, S, M, rand, BLOOM.red, 7)
    case 10: return paintFlowerCluster(ctx, S, M, rand, BLOOM.white, 11)
    case 11: return paintFern(ctx, S, M, rand, 1)
    case 12: return paintFern(ctx, S, M, rand, 3)
    case 13: return paintMossWedge(ctx, S, M, rand)
    case 14: return paintHangingIvy(ctx, S, M, rand, { strands: 3, leaves: 13, drift: 0.10 })
    default: return paintHangingIvy(ctx, S, M, rand, { strands: 2, leaves: 10, drift: -0.16 })
  }
}

/**
 * A leaf cluster: leaves radiating from a base point, back-to-front so the
 * ones behind are darker.
 *
 * The depth sort is the whole trick. A card has no interior, so the only place
 * a cluster's self-occlusion can live is its albedo — paint every leaf the same
 * green and you get a decal, not a plant.
 */
function paintLeafCluster(ctx, S, M, rand, { leaves, tone, ivy }) {
  const bx = S * 0.5
  const by = S - M
  const span = S - M * 2

  // Stems first, so leaves cover their joins.
  ctx.strokeStyle = shade(GREEN.stem, 1.0)
  ctx.lineWidth = Math.max(1.5, span * 0.012)
  for (let i = 0; i < 5; i++) {
    const a = (-0.5 + i / 4) * 1.15
    ctx.beginPath()
    ctx.moveTo(bx, by)
    ctx.quadraticCurveTo(bx + Math.sin(a) * span * 0.16, by - span * 0.35,
      bx + Math.sin(a) * span * 0.38, by - span * (0.52 + rand() * 0.3))
    ctx.stroke()
  }

  for (let i = 0; i < leaves; i++) {
    // depth 0 = deepest in the cluster, 1 = frontmost. Drives both draw order
    // (loop order) and value.
    const depth = i / (leaves - 1)
    const a = (rand() - 0.5) * 2.25              // fan, radians off vertical
    // Shorter and much broader than the first pass, which came back reading as
    // an agave: a long narrow blade rotated about one point IS a succulent, and
    // the brief asks for "leafy canopies". Length down, width nearly doubled.
    const len = span * (0.24 + rand() * 0.20) * (0.74 + depth * 0.32)
    // 0.58, arrived at by looking at both failures: 0.48 read as an agave
    // (long narrow blades round a point) and 0.74 read as a cabbage (six huge
    // leaves you can count). A cluster has to be more leaves than you can
    // count, each narrower than it is long.
    const wid = len * (ivy ? 0.92 : 0.58)
    // Leaves sit up the stems, not all at one point — a rosette reads as a
    // pinwheel, and nothing in the reference is a pinwheel.
    const rise = span * (0.10 + rand() * 0.46)
    ctx.save()
    ctx.translate(bx + Math.sin(a) * rise * 0.55, by - rise)
    ctx.rotate(a * 0.85)
    if (ivy) ivyLeafPath(ctx, len, wid)
    else leafPath(ctx, len, wid, (rand() - 0.5) * 0.5)

    const dry = rand() < 0.09
    const hue = THREE.MathUtils.clamp(0.5 + tone * 0.5 + (rand() - 0.5) * 0.5, 0, 1)
    const body = dry ? GREEN.dry : (hue > 0.5 ? GREEN.mid : GREEN.cool)
    const t = dry ? 0.35 : hue
    fillLeaf(ctx,
      len,
      mixHex(GREEN.deep, body, 0.25 + depth * 0.42),
      mixHex(body, GREEN.bright, 0.10 + t * 0.34 + depth * 0.14),
      mixHex(GREEN.deep, body, 0.5 + depth * 0.3, 0.45))
    ctx.restore()
  }
}

/**
 * An upright ivy sprig: one arcing stem with alternating leaves, thinning
 * toward the tip.
 */
function paintIvySprig(ctx, S, M, rand, { leaves, lean }) {
  const bx = S * 0.5 - lean * S * 0.2
  const by = S - M
  const span = S - M * 2
  const tipX = bx + lean * span
  const tipY = by - span * 0.94

  ctx.strokeStyle = shade(GREEN.stem, 0.95)
  ctx.lineWidth = Math.max(2, span * 0.016)
  ctx.beginPath()
  ctx.moveTo(bx, by)
  ctx.quadraticCurveTo(bx + lean * span * 0.2, by - span * 0.5, tipX, tipY)
  ctx.stroke()

  for (let i = 0; i < leaves; i++) {
    const t = (i + 0.6) / leaves
    // Point on the quadratic, so leaves sit ON the stem rather than near it.
    const mt = 1 - t
    const px = mt * mt * bx + 2 * mt * t * (bx + lean * span * 0.2) + t * t * tipX
    const py = mt * mt * by + 2 * mt * t * (by - span * 0.5) + t * t * tipY
    const side = i % 2 === 0 ? 1 : -1
    const len = span * (0.28 - t * 0.13) * (0.85 + rand() * 0.3)
    ctx.save()
    ctx.translate(px, py)
    ctx.rotate(side * (0.75 + rand() * 0.4) + lean * 0.5)
    ivyLeafPath(ctx, len, len * 0.95)
    const body = rand() < 0.2 ? GREEN.cool : GREEN.mid
    fillLeaf(ctx, len,
      mixHex(GREEN.deep, body, 0.45),
      mixHex(body, GREEN.bright, 0.25 + rand() * 0.3),
      mixHex(GREEN.deep, body, 0.55, 0.5))
    ctx.restore()
  }
}

/** A grass tuft: blades fanning from a point, with optional seed heads. */
function paintGrassTuft(ctx, S, M, rand, { blades, tall, seed }) {
  const bx = S * 0.5
  const by = S - M
  const span = (S - M * 2) * tall

  for (let i = 0; i < blades; i++) {
    const depth = i / (blades - 1)
    const bend = (rand() - 0.5) * 1.5
    const len = span * (0.42 + rand() * 0.58)
    const wid = span * (0.026 + rand() * 0.026)
    ctx.save()
    ctx.translate(bx + (rand() - 0.5) * span * 0.30, by)
    ctx.rotate((rand() - 0.5) * 0.5)
    bladePath(ctx, len, wid, bend)
    const body = rand() < 0.16 ? GREEN.dry : (rand() < 0.3 ? GREEN.cool : GREEN.mid)
    fillLeaf(ctx, len,
      mixHex(GREEN.deep, body, 0.30 + depth * 0.4),
      mixHex(body, GREEN.bright, 0.35 + rand() * 0.4), null)
    ctx.restore()
  }

  if (seed) {
    // Seed heads: a few dry spikes above the blade line. Two or three per tuft
    // is the whole reason a meadow reads as a meadow and not as a green rug.
    for (let i = 0; i < 3; i++) {
      const x = bx + (rand() - 0.5) * span * 0.5
      const h = span * (0.82 + rand() * 0.18)
      ctx.strokeStyle = shade(GREEN.dry, 0.95, 0.9)
      ctx.lineWidth = Math.max(1, span * 0.012)
      ctx.beginPath()
      ctx.moveTo(bx, by)
      ctx.quadraticCurveTo(x, by - h * 0.6, x + (rand() - 0.5) * span * 0.1, by - h)
      ctx.stroke()
      ctx.fillStyle = shade(GREEN.dry, 1.08)
      for (let k = 0; k < 7; k++) {
        const t = 0.55 + (k / 7) * 0.45
        ctx.beginPath()
        ctx.ellipse(x + (rand() - 0.5) * span * 0.05, by - h * t,
          span * 0.014, span * 0.030, (rand() - 0.5) * 0.6, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
}

/**
 * A flower cluster: a small green mound with blooms held above it.
 *
 * The green base matters. A floating ring of petals with nothing under it is
 * what a decal looks like; the plant is most of the card and the flowers are
 * the last 20% of its height.
 */
function paintFlowerCluster(ctx, S, M, rand, petalHex, blooms) {
  paintGrassTuft(ctx, S, M, rand, { blades: 13, tall: 0.62, seed: false })

  const bx = S * 0.5
  const by = S - M
  const span = S - M * 2

  for (let i = 0; i < blooms; i++) {
    const h = span * (0.48 + rand() * 0.46)
    const x = bx + (rand() - 0.5) * span * 0.62
    const y = by - h
    ctx.strokeStyle = shade(GREEN.stem, 1.05)
    ctx.lineWidth = Math.max(1, span * 0.010)
    ctx.beginPath()
    ctx.moveTo(bx + (x - bx) * 0.25, by - span * 0.1)
    ctx.quadraticCurveTo(x, by - h * 0.55, x, y)
    ctx.stroke()

    const r = span * (0.038 + rand() * 0.026)
    const petals = 5
    const spin = rand() * Math.PI * 2
    for (let p = 0; p < petals; p++) {
      const a = spin + (p / petals) * Math.PI * 2
      ctx.fillStyle = mixHex(petalHex, 0xffffff, 0.10 + rand() * 0.25)
      ctx.beginPath()
      ctx.ellipse(x + Math.cos(a) * r * 0.62, y + Math.sin(a) * r * 0.62,
        r * 0.62, r * 0.44, a, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.fillStyle = shade(BLOOM.eye, 1.0)
    ctx.beginPath()
    ctx.arc(x, y, r * 0.30, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** A fern: `fronds` rachises, each carrying shrinking pinnae in pairs. */
function paintFern(ctx, S, M, rand, fronds) {
  const bx = S * 0.5
  const by = S - M
  const span = S - M * 2

  for (let f = 0; f < fronds; f++) {
    const lean = fronds === 1 ? (rand() - 0.5) * 0.25 : (f / (fronds - 1) - 0.5) * 0.9
    const len = span * (0.80 + rand() * 0.18) * (1 - Math.abs(lean) * 0.25)
    const tipX = bx + lean * span * 0.55
    const tipY = by - len
    const ctrlX = bx + lean * span * 0.15
    const ctrlY = by - len * 0.55

    ctx.strokeStyle = shade(GREEN.stem, 1.0)
    ctx.lineWidth = Math.max(1.5, span * 0.013)
    ctx.beginPath()
    ctx.moveTo(bx, by)
    ctx.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY)
    ctx.stroke()

    const pairs = 13
    for (let i = 0; i < pairs; i++) {
      const t = 0.10 + (i / pairs) * 0.88
      const mt = 1 - t
      const px = mt * mt * bx + 2 * mt * t * ctrlX + t * t * tipX
      const py = mt * mt * by + 2 * mt * t * ctrlY + t * t * tipY
      // Pinnae shrink toward the tip — a frond with constant leaflets reads as
      // a feather duster.
      const pl = span * 0.24 * (1 - t * 0.78) * (0.9 + rand() * 0.2)
      for (let s = -1; s <= 1; s += 2) {
        ctx.save()
        ctx.translate(px, py)
        ctx.rotate(s * (1.15 - t * 0.45) + lean * 0.4)
        leafPath(ctx, pl, pl * 0.52, 0.2 * s)
        const body = t > 0.6 ? GREEN.bright : GREEN.cool
        fillLeaf(ctx, pl,
          mixHex(GREEN.deep, body, 0.35),
          mixHex(body, GREEN.bright, 0.3), null)
        ctx.restore()
      }
    }
  }
}

/**
 * The moss wedge: a low, wide, fuzzy-topped mound.
 *
 * Wide and short on purpose — this is scattered along a wall/floor junction,
 * where its job is to destroy the perfectly clean hard line the review found in
 * `terrace.png`. Its silhouette has to be irregular at the 2 cm scale, so the
 * top edge is a few hundred tiny specks rather than a curve.
 */
function paintMossWedge(ctx, S, M, rand) {
  const by = S - M
  const span = S - M * 2
  const cx = S * 0.5
  // The mound fills MOST of the cell, and the card's 1.5 aspect stretches it
  // wide afterwards. Painting it flat here and then stretching gave a green
  // smear with no top edge to break the wall line, which was the whole job.
  const domeH = span * 0.72

  // The body: overlapping lobes on a dome profile, darkest where it meets stone.
  for (let i = 0; i < 110; i++) {
    const u = rand()
    const x = cx + (u - 0.5) * span * 0.94
    // Dome: height falls off toward the edges, so the silhouette is a mound and
    // not a slab.
    const lift = Math.cos((u - 0.5) * Math.PI) * domeH
    const y = by - rand() * lift
    const r = span * (0.055 + rand() * 0.075)
    const body = rand() < 0.35 ? GREEN.cool : GREEN.mid
    // A LOW-CONTRAST lobe. The first version ran a bright core out to a dark
    // rim and 110 of them read as a heap of bubbles; the lobes are only there
    // to build an opaque mass with an irregular edge, and every bit of visible
    // structure has to come from the shoots drawn over them.
    const g = ctx.createRadialGradient(x, y - r * 0.3, r * 0.1, x, y - r * 0.3, r)
    g.addColorStop(0, mixHex(GREEN.deep, body, 0.62))
    g.addColorStop(0.72, mixHex(GREEN.deep, body, 0.50))
    g.addColorStop(1, mixHex(GREEN.deep, body, 0.45, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y - r * 0.35, r, 0, Math.PI * 2)
    ctx.fill()
  }

  // The fuzz: individual shoots breaking the crest. This is the part that stops
  // the wedge reading as a painted blob — moss has no smooth edge at any scale
  // a player gets close to, and a smooth edge is exactly what a radial gradient
  // produces on its own.
  for (let i = 0; i < 1600; i++) {
    const u = rand()
    const x = cx + (u - 0.5) * span * 1.0
    const lift = Math.cos((u - 0.5) * Math.PI) * domeH
    // Over the WHOLE mound, biased to the crest. Covering only the crest left
    // the lobes bare below it; moss has the same texture everywhere you can
    // see it, and only its silhouette is special.
    const y = by - lift * Math.pow(rand(), 0.55)
    const h = span * (0.016 + rand() * 0.040)
    // Shoots run deep-green to mid, not mid to bright: at 900 strokes the
    // bright end was the only thing visible and the wedge came back as a
    // yellow-green fur ball.
    ctx.strokeStyle = mixHex(GREEN.deep, GREEN.bright, 0.25 + rand() * 0.55, 0.9)
    ctx.lineWidth = Math.max(1, span * 0.0065)
    ctx.beginPath()
    ctx.moveTo(x, y + h * 0.9)
    ctx.lineTo(x + (rand() - 0.5) * h * 0.9, y - h)
    ctx.stroke()
  }
}

/**
 * Hanging ivy, attached at the TOP of the cell.
 *
 * Painted this way round because a drape's fixed end is its top: `hangFromEdge`
 * places the card so its uv.y = 1 edge touches the lip, and the vertex shader's
 * `hang` flag moves the wind pivot to match. Painting it the other way up and
 * flipping the card would mirror every leaf and invert the normals.
 */
function paintHangingIvy(ctx, S, M, rand, { strands, leaves, drift }) {
  const span = S - M * 2
  const ty = M

  // TWO OR THREE STRANDS PER CARD, not one. A single strand painted in a square
  // cell is ~30% ink and 70% air, so a row of those cards reads as a picket
  // fence however tightly they are pitched. Three strands per card plus the
  // 0.5 m pitch in hangFromEdge is what closes a drape into a curtain.
  for (let k = 0; k < strands; k++) {
    const off = strands === 1 ? 0 : ((k / (strands - 1)) - 0.5) * span * 0.62
    const tx = S * 0.5 + off + (rand() - 0.5) * span * 0.08
    const d = drift * (0.5 + rand())
    // Strands end at different depths: a drape cut off level at the bottom is
    // a valance, and nothing in the reference has a hem.
    const fall = span * (0.62 + rand() * 0.38)
    const botX = tx + d * span
    const botY = ty + fall
    const ctrlX = tx + d * span * 0.25
    const ctrlY = ty + fall * 0.55

    ctx.strokeStyle = shade(GREEN.stem, 0.9)
    ctx.lineWidth = Math.max(2, span * 0.011)
    ctx.beginPath()
    ctx.moveTo(tx, ty)
    // Nearly straight down with a slow drift: a hanging stem is a plumb line
    // with a bias, not an S-curve.
    ctx.quadraticCurveTo(ctrlX, ctrlY, botX, botY)
    ctx.stroke()

    const n = Math.round(leaves * (0.7 + rand() * 0.5))
    for (let i = 0; i < n; i++) {
      const t = (i + 0.35) / n
      const mt = 1 - t
      const px = mt * mt * tx + 2 * mt * t * ctrlX + t * t * botX
      const py = mt * mt * ty + 2 * mt * t * ctrlY + t * t * botY
      const side = i % 2 === 0 ? 1 : -1
      // Leaves get SMALLER down the strand: growth is at the top, and a strand
      // with uniform leaves reads as a garland from a party shop.
      const len = span * (0.20 - t * 0.09) * (0.85 + rand() * 0.35)
      ctx.save()
      ctx.translate(px, py)
      // Leaves hang: rotated past horizontal so their tips point down.
      ctx.rotate(side * (1.9 + rand() * 0.5))
      ivyLeafPath(ctx, len, len * 0.92)
      const body = rand() < 0.25 ? GREEN.cool : GREEN.mid
      fillLeaf(ctx, len,
        mixHex(GREEN.deep, body, 0.40),
        mixHex(body, GREEN.bright, 0.20 + rand() * 0.3),
        mixHex(GREEN.deep, body, 0.5, 0.45))
      ctx.restore()
    }
  }
}

// ------------------------------------------------------------- the card mesh

/**
 * `quads` quads at even yaw intervals, spanning x in [-0.5, 0.5] and y in
 * [0, 1], anchored at the BASE (y = 0 is the instance origin).
 *
 * WHY CROSS-QUADS AND NOT A BILLBOARD: a billboard is one draw's worth of
 * cheating that falls apart the moment the camera moves fast, which is the only
 * way this camera ever moves — plants visibly counter-rotate as you run past
 * them, and at 47 km/h that is the most distracting thing in the frame. Three
 * fixed quads at 60 degrees cost six triangles and never spin.
 *
 * WHY THE NORMALS ARE BENT: the face normal of a vertical quad is horizontal,
 * so a card lit by an overhead-ish key would be uniformly black, and a card lit
 * by this world's 10-degree key would be uniformly bright. Neither is a plant.
 * The normals are therefore blended 72% toward a SPHERICAL normal radiating
 * from the cluster's centre, which is what makes a flat card shade as a
 * rounded volume — the standard foliage trick, and the single cheapest thing
 * in this file.
 */
export function crossQuadGeometry(quads = 3) {
  const n = Math.max(1, Math.min(4, quads | 0))
  const geo = new THREE.BufferGeometry()
  const verts = n * 4
  const pos = new Float32Array(verts * 3)
  const nrm = new Float32Array(verts * 3)
  const uv = new Float32Array(verts * 2)
  const idx = new Uint16Array(n * 6)

  // The cluster centre the spherical normals radiate from: a little below the
  // middle, because the mass of a tuft sits low.
  const CY = 0.42
  const SPHERICAL = 0.72

  for (let q = 0; q < n; q++) {
    const a = (q / n) * Math.PI          // PI, not 2PI: a quad is two-sided
    const ca = Math.cos(a), sa = Math.sin(a)
    for (let v = 0; v < 4; v++) {
      const u = (v === 0 || v === 3) ? -0.5 : 0.5
      const h = (v < 2) ? 0 : 1
      const i = q * 4 + v
      const x = ca * u, y = h, z = sa * u
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z

      // face normal (perpendicular to the quad, in its plane's normal dir)
      const fx = -sa, fz = ca
      // spherical normal, from the cluster centre outward
      let sx = x, sy = y - CY, sz = z
      const l = Math.hypot(sx, sy, sz) || 1
      sx /= l; sy /= l; sz /= l
      let nx = fx * (1 - SPHERICAL) + sx * SPHERICAL
      let ny = sy * SPHERICAL
      let nz = fz * (1 - SPHERICAL) + sz * SPHERICAL
      const nl = Math.hypot(nx, ny, nz) || 1
      nrm[i * 3] = nx / nl; nrm[i * 3 + 1] = ny / nl; nrm[i * 3 + 2] = nz / nl

      uv[i * 2] = u + 0.5
      uv[i * 2 + 1] = h
    }
    const b = q * 4
    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6)
  }

  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  // Set by hand: the default computation would give a unit box, and the
  // InstancedMesh's own bounding sphere is derived from it per instance.
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5))
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 0.71)
  return geo
}

// ------------------------------------------------------------- wind and fade

/**
 * ONE shared time uniform for every foliage material in the world.
 *
 * `foliageTick(t)` writes it once per frame and every field sways. Per-field
 * time uniforms would mean a loop over fields and a chance for two islands to
 * drift out of phase with each other, which is visible.
 */
const _time = { value: 0 }

/** Advance every foliage field in the world. One float write per frame. */
export function foliageTick(seconds) {
  _time.value = seconds
}

/**
 * The sun direction, world space, shared like the clock.
 *
 * Defaults to world.js's `sunDir` so a caller that forgets to set it still gets
 * the right answer for this level; `setFoliageSun()` exists so the two cannot
 * silently diverge if the sun ever moves.
 */
const _sunDir = { value: new THREE.Vector3(-0.62, 0.17, 0.77).normalize() }

/** Point the leaf translucency at the scene's key light. */
export function setFoliageSun(dir) {
  _sunDir.value.copy(dir).normalize()
}

const VERT_PARS = /* glsl */ `
// x cell index, y wind amplitude, z phase jitter, w hang (0 base-pivot, 1 top)
attribute vec4 aFoliage;

uniform float uFoliageTime;
// x amplitude (m), y frequency (rad/s), z gust amplitude, w unused
uniform vec4 uWind;
// world-space wind heading, normalised
uniform vec2 uWindDir;
// x cols, y rows, z 1/cols, w 1/rows
uniform vec4 uAtlas;
// x fade start (m), y fade end (m), z 1/(end-start), w unused
uniform vec4 uFade;

varying float vFoliageFade;

/**
 * Wind offset for this vertex, in the field's object space (metres).
 *
 * PHASE comes from the instance's own position, exactly as the brief asks: two
 * plants a metre apart are a fifth of a cycle out of step, so a bed ripples
 * instead of pulsing as one object. A per-instance jitter is added on top so
 * two plants at the SAME point (a tuft and the flowers in it) still separate.
 *
 * AMPLITUDE is scaled by height up the card, squared, so the base stays planted
 * in the ground. The 'hang' flag swaps the pivot to the top for a drape, whose
 * fixed end is where it grips the lip.
 *
 * Two sine terms and one gust term. Not four: this runs on every vertex of
 * every leaf in the frame, and the third harmonic of a sine is not what makes
 * wind read — the gust envelope is.
 */
vec2 scFoliageWind( float height, vec3 originOS ) {
  float phase = dot( originOS.xz, vec2( 0.61, 0.47 ) ) + aFoliage.z;
  float t = uFoliageTime * uWind.y;
  // The sway: a fundamental plus a quieter, faster flutter an irrational
  // ratio away, so the pair never visibly repeats.
  float sway = sin( t + phase ) * 0.72 + sin( t * 2.37 + phase * 1.7 ) * 0.28;
  // The gust: a slow, long-wavelength travelling envelope. This is the term
  // that makes a hillside read as weather rather than as animation.
  float gust = 0.62 + 0.38 * sin( uFoliageTime * 0.23 - dot( originOS.xz, vec2( 0.045, 0.031 ) ) );
  // Pivot: base for a growing plant, top for a hanging one.
  float h = mix( height, 1.0 - height, aFoliage.w );
  float amp = uWind.x * aFoliage.y * gust * h * h;
  // Along the wind, plus a quarter-amplitude cross-flutter so leaves twist
  // rather than slide.
  return uWindDir * ( sway * amp ) + vec2( -uWindDir.y, uWindDir.x ) * ( sway * amp * 0.25 );
}
`

const VERT_PROJECT = /* glsl */ `
  vec4 oPos = vec4( transformed, 1.0 );
  vec3 oOrigin = vec3( 0.0 );
  #ifdef USE_INSTANCING
    oOrigin = instanceMatrix[ 3 ].xyz;
    oPos = instanceMatrix * oPos;
  #endif

  // Distance is measured to the INSTANCE ORIGIN, not to the vertex: a plant
  // must dissolve as one object. A per-vertex fade would erode each card from
  // the top down, which looks like it is sinking into the floor.
  vec4 mvOrigin = modelViewMatrix * vec4( oOrigin, 1.0 );
  float dist = length( mvOrigin.xyz );
  float fade = clamp( ( uFade.y - dist ) * uFade.z, 0.0, 1.0 );
  // Stagger the dissolve per instance so a field thins out plant by plant
  // instead of the whole band going translucent at one radius. aFoliage.z is
  // already a per-instance random in [0, 2pi); fract() makes it a 0..1 rank.
  float rank = fract( aFoliage.z * 0.1591549 );
  vFoliageFade = clamp( ( fade - rank * 0.4 ) * 1.6667, 0.0, 1.0 );

  oPos.xz += scFoliageWind( uv.y, oOrigin );
  // A fully faded instance collapses to a point, so it costs a vertex shader
  // and zero fragments. This is what makes the fade a real LOD and not just a
  // way to pay for invisible geometry.
  oPos.xyz = mix( oOrigin, oPos.xyz, step( 0.0001, vFoliageFade ) );

  vec4 mvPosition = modelViewMatrix * oPos;
  gl_Position = projectionMatrix * mvPosition;
`

const FRAG_PARS = /* glsl */ `
uniform vec3 uSunDirWorld;
// x strength, y power, z/w unused
uniform vec4 uTranslucency;
uniform vec3 uTranslucencyTint;

varying float vFoliageFade;

/**
 * Cheap leaf translucency — light coming THROUGH the leaf, not off it.
 *
 * This is not a nicety at golden hour, it is the effect. The reference's
 * vegetation is lit from behind by a 10-degree sun, and a backlit leaf is the
 * brightest, most saturated green in the whole image. Standard PBR has no term
 * for it at all: without this, every leaf facing away from the sun is a flat
 * dark card, which is the difference between a canopy and a paper cut-out.
 *
 * The approximation is the usual one: looking along the direction the light
 * travels means you are looking through the leaf. -V is the direction from
 * the eye toward the fragment, L is the direction from the fragment toward
 * the sun, so their dot peaks when the sun is directly behind the leaf.
 * Multiplied by the leaf's own albedo, so a dark leaf transmits dark.
 */
vec3 scFoliageTranslucency( vec3 albedo ) {
  if ( uTranslucency.x <= 0.0 ) return vec3( 0.0 );
  vec3 L = normalize( ( viewMatrix * vec4( uSunDirWorld, 0.0 ) ).xyz );
  vec3 V = normalize( vViewPosition );
  float back = pow( clamp( dot( -V, L ), 0.0, 1.0 ), uTranslucency.y );
  return albedo * uTranslucencyTint * ( back * uTranslucency.x );
}
`

/**
 * Bumped whenever the injected GLSL above changes.
 *
 * It is part of `customProgramCacheKey`, so a stale cached program cannot
 * survive an edit to this file inside a dev session — the same discipline
 * `render/patch.js` documents, and for the same reason.
 */
const SHADER_VERSION = 1

/**
 * The foliage material: `MeshStandardMaterial`, patched.
 *
 * WHY NOT A RAW ShaderMaterial. Every lit surface in this game goes through
 * `render/patch.js`, which injects the contact shadow, the ambient budget, the
 * warm/cool ambient split and the aerial-perspective fog into whatever
 * `MeshStandardMaterial`s it finds. A hand-written ShaderMaterial would opt
 * foliage out of all four, and a plant that does not receive the same haze as
 * the island it stands on is a plant that reads as a decal pasted on the
 * screen. So this stays a standard material and only adds to it.
 *
 * CHAINING. `onBeforeCompile` is assigned HERE, at construction, before the
 * pipeline's scene walk can wrap it — the patcher captures whatever hook is
 * already present and calls it first. Assigning ours after the walk would
 * silently delete the whole render pipeline's contribution to this material.
 */
function foliageMaterial(page, opts) {
  const uniforms = {
    uFoliageTime: _time,
    uWind: { value: new THREE.Vector4(opts.windAmplitude, opts.windFrequency, 0, 0) },
    uWindDir: { value: new THREE.Vector2(opts.windDirection[0], opts.windDirection[1]).normalize() },
    uAtlas: {
      value: new THREE.Vector4(page.cols, page.rows, 1 / page.cols, 1 / page.rows),
    },
    uFade: {
      value: new THREE.Vector4(
        opts.fadeStart, opts.fadeEnd,
        1 / Math.max(0.001, opts.fadeEnd - opts.fadeStart), 0),
    },
    uSunDirWorld: _sunDir,
    uTranslucency: { value: new THREE.Vector4(opts.translucency, opts.translucencyPower, 0, 0) },
    uTranslucencyTint: { value: new THREE.Color(opts.translucencyTint) },
  }

  const mat = new THREE.MeshStandardMaterial({
    name: 'sc-foliage',
    map: page.texture,
    // White: all the colour is in the atlas and in the per-instance jitter.
    color: 0xffffff,
    // Leaves are matte with a waxy sheen. 0.72 rather than 1.0 because a
    // perfectly matte leaf loses the specular glance that separates a canopy
    // from a painted flat at grazing angles — which is most angles, from a
    // camera at eye height running past a planted bed.
    roughness: 0.72,
    metalness: 0,
    // DOUBLE-SIDED, and not negotiable: a cross-quad seen from behind is the
    // same leaf. Backface culling would delete half of every plant depending
    // on which way the player happens to be facing.
    side: THREE.DoubleSide,
    alphaTest: ALPHA_TEST,
    // See the file header. Opaque pass, no sorting, MSAA-resolved edges.
    alphaToCoverage: true,
    transparent: false,
    // The atlas is the only map, so vertex colours arrive purely from
    // instanceColor; three defines USE_COLOR for us when instanceColor exists.
    envMapIntensity: 1.0,
  })

  mat.onBeforeCompile = (shader) => {
    for (const k in uniforms) shader.uniforms[k] = uniforms[k]

    let vs = shader.vertexShader
    vs = vs.replace('#include <common>', '#include <common>\n' + VERT_PARS)
    // The cell remap. `uv_vertex` has just written vMapUv from the full-texture
    // transform; this overwrites it with the instance's own cell. Done in the
    // VERTEX shader so the fragment shader is untouched and costs nothing.
    vs = vs.replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\n' +
      '  #ifdef USE_MAP\n' +
      // Row is INVERTED against the cell index. `flipRows` turned the canvas
      // upside down so a plant's base lands at uv.y = 0, which also turned the
      // grid upside down: canvas grid row 0 is the TOP row of cells and the
      // LAST row of uv space. Getting this wrong is silent and total — every
      // species draws a different species — so it is one expression, here.
      '  float scRow = uAtlas.y - 1.0 - floor( aFoliage.x * uAtlas.z );\n' +
      '  vec2 scCell = vec2( mod( aFoliage.x, uAtlas.x ), scRow );\n' +
      '  vMapUv = ( scCell + uv ) * uAtlas.zw;\n' +
      '  #endif'
    )
    // Wind, fade and the instance collapse all live in the projection, because
    // all three need the position AFTER instancing and BEFORE the view matrix.
    // Mirrors three's own project_vertex chunk; `mvPosition` must stay in scope
    // because meshphysical_vert reads it on the next line for vViewPosition.
    vs = vs.replace('#include <project_vertex>', VERT_PROJECT)
    shader.vertexShader = vs

    let fs = shader.fragmentShader
    fs = fs.replace('#include <common>', '#include <common>\n' + FRAG_PARS)
    fs = fs.replace(
      '#include <opaque_fragment>',
      '  outgoingLight += scFoliageTranslucency( diffuseColor.rgb );\n' +
      '#include <opaque_fragment>\n' +
      // The distance fade, written as COVERAGE rather than as blended alpha.
      // With alphaToCoverage the hardware turns a fractional alpha into a
      // sample mask, so this is a real dissolve that needs no sorting and no
      // blend state. Applied AFTER the alpha test on purpose: multiplying it in
      // before would push every texel under the 0.5 threshold at once and the
      // whole plant would vanish in a single frame.
      '  gl_FragColor.a *= vFoliageFade;'
    )
    shader.fragmentShader = fs
  }

  mat.customProgramCacheKey = () => `sc-foliage-${SHADER_VERSION}`
  mat.userData.foliageUniforms = uniforms
  return mat
}

// ------------------------------------------------------------------ the field

const _m4 = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _AXIS_Y = new THREE.Vector3(0, 1, 0)

/**
 * Defaults, all in metres and seconds, all with a reason.
 */
const FIELD_DEFAULTS = {
  seed: 0x5EED1,
  /** 3 quads = 6 triangles per plant. 2 is the budget option for far islands. */
  quads: 3,
  /**
   * Wind amplitude at the tip of a unit-height card, in metres. 0.09 m on a
   * 0.2 m grass tuft is a ~25-degree lean at full gust: visible from ten metres
   * away, and nowhere near the point where a plant looks like it is being
   * blown apart.
   */
  windAmplitude: 0.09,
  /** rad/s. 1.7 is a ~3.7 s period — a breeze, not a shiver. */
  windFrequency: 1.7,
  /** World-space heading. Roughly across the course's +X run, so a player
   *  moving along the route sees the motion in profile rather than head-on. */
  windDirection: [0.82, 0.57],
  /**
   * Fade window. 55 m is past the far end of any single island's planted area,
   * and 90 m is where a 0.2 m tuft is under two pixels on a 1600-wide frame —
   * i.e. where it costs a draw and returns aliasing.
   */
  fadeStart: 55,
  fadeEnd: 90,
  /** Leaf translucency strength; see scFoliageTranslucency. Tuned against
   *  world.js's key light at intensity 3.1. */
  translucency: 0.85,
  /** Falloff of the backlight lobe. 3.0 keeps the glow inside ~50 degrees of
   *  the sun rather than lighting the whole hemisphere. */
  translucencyPower: 3.0,
  /** What colour light is after it has been through a leaf: yellow-green, and
   *  much more saturated than the leaf's own reflected colour. */
  translucencyTint: 0xbcd463,
  /** Foliage does not cast shadows by default. The shadow depth material has
   *  no wind term (three derives it, we cannot inject into it from here), so a
   *  swaying leaf would cast a still shadow — and a leaf's shadow is the least
   *  valuable 2048-map texel in the frame. Opt in per field if it earns it. */
  castShadow: false,
  receiveShadow: true,
}

/**
 * A field of instanced plants.
 *
 * ONE FIELD PER ISLAND is the intended granularity, not one per world: an
 * InstancedMesh is culled as a single unit, so a world-spanning field is either
 * entirely drawn or entirely skipped and the frustum does nothing. Per-island
 * fields share the atlas (and therefore the texture memory), and cost one draw
 * call each when visible.
 */
export class FoliageField {
  constructor(opts = {}) {
    const o = { ...FIELD_DEFAULTS, ...opts }
    this.options = o
    this.atlas = foliageAtlas(o.atlasSeed ?? ATLAS_SEED)
    this.rand = rng(o.seed)
    this.group = null
    this._built = false
    /** Per-page instance records. Plain arrays: this is load-time work that
     *  runs once, and a typed-array doubling scheme here would buy nothing but
     *  a bug surface. */
    this._pages = this.atlas.pages.map(() => ({
      matrix: [], colour: [], data: [],
    }))
    this._meshes = []
    this._lod = 1
  }

  get count() {
    let n = 0
    for (const p of this._pages) n += p.data.length >> 2
    return n
  }

  /**
   * Add one plant.
   *
   * @param {string} species  a key of SPECIES
   * @param {number} x world X
   * @param {number} y world Y — the plant's BASE (or, for a hanging species,
   *                  the bottom of its drape)
   * @param {number} z world Z
   * @param {object} [opts] `{ height, aspect, yaw, cell, wind, tint }`
   * @returns {this}
   */
  add(species, x, y, z, opts = {}) {
    if (this._built) throw new Error('FoliageField: add() after build()')
    const sp = SPECIES[species]
    if (!sp) throw new Error(`FoliageField: unknown species ${species}`)
    const rand = this.rand

    const h = opts.height ?? (sp.size[0] + rand() * (sp.size[1] - sp.size[0]))
    const aspect = opts.aspect ?? sp.aspect
    const w = h * aspect
    const cell = opts.cell ?? sp.cells[(rand() * sp.cells.length) | 0]
    const yaw = opts.yaw ?? rand() * Math.PI * 2

    const page = this._pages[opts.page ?? 0]
    if (!page) throw new Error(`FoliageField: no atlas page ${opts.page}`)
    _pos.set(x, y, z)
    _q.setFromAxisAngle(_AXIS_Y, yaw)
    // Non-uniform scale is what lets one square atlas cell serve a 2.4 m ivy
    // drape and a 0.15 m tuft: the CARD carries the aspect, the ART stays
    // square. three's instancing normal path divides by the per-axis squared
    // scale, so this does not skew the shading normals.
    _scale.set(w, h, w)
    _m4.compose(_pos, _q, _scale)
    for (let i = 0; i < 16; i++) page.matrix.push(_m4.elements[i])

    // Colour jitter, as a multiplier on the atlas albedo. Value +/-11% and a
    // hue push along the green axis, so a bed reads as many plants rather than
    // one plant stamped forty times. Kept as a multiplier near 1 so the atlas
    // stays the authority on what colour vegetation is.
    const v = 0.89 + rand() * 0.22
    const warm = (rand() - 0.5) * 0.15
    const tint = opts.tint ?? 1
    page.colour.push(
      v * (1 + warm) * tint,
      v * (1 + warm * 0.25) * tint,
      v * (1 - warm * 0.9) * tint)

    page.data.push(
      cell,
      opts.wind ?? sp.wind,
      rand() * Math.PI * 2,          // phase jitter, also the fade rank
      sp.hang)
    return this
  }

  /**
   * Build the meshes. Returns a `THREE.Group` to add to the scene.
   *
   * The instances are ordered by a deterministic hash first, which is what
   * makes `setLOD()` work: cutting `mesh.count` then removes a spatially
   * uniform subset instead of lopping off whichever corner of the island was
   * scattered last.
   */
  build() {
    if (this._built) return this.group
    this._built = true
    this.group = new THREE.Group()
    this.group.name = 'foliage'

    for (let pi = 0; pi < this._pages.length; pi++) {
      const p = this._pages[pi]
      const n = p.data.length >> 2
      if (n === 0) continue

      const order = shuffledOrder(n, this.options.seed ^ (pi * 0x9E3779B1))
      const matrices = new Float32Array(n * 16)
      const colours = new Float32Array(n * 3)
      const data = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) {
        const s = order[i]
        for (let k = 0; k < 16; k++) matrices[i * 16 + k] = p.matrix[s * 16 + k]
        for (let k = 0; k < 3; k++) colours[i * 3 + k] = p.colour[s * 3 + k]
        for (let k = 0; k < 4; k++) data[i * 4 + k] = p.data[s * 4 + k]
      }

      const page = {
        texture: this.atlas.pages[pi].texture,
        cols: this.atlas.cols,
        rows: this.atlas.rows,
      }
      const geo = crossQuadGeometry(this.options.quads)
      geo.setAttribute('aFoliage', new THREE.InstancedBufferAttribute(data, 4))
      const mat = foliageMaterial(page, this.options)
      const mesh = new THREE.InstancedMesh(geo, mat, n)
      mesh.name = `foliage-page-${pi}`
      mesh.instanceMatrix.array.set(matrices)
      mesh.instanceMatrix.needsUpdate = true
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colours, 3)
      mesh.castShadow = this.options.castShadow
      mesh.receiveShadow = this.options.receiveShadow
      /**
       * Keep foliage OUT of the depth/normal prepass.
       *
       * `render/gbuffer.js` draws that pass with `scene.overrideMaterial`, which
       * replaces this material and therefore its alpha test. Every card would
       * write a full opaque quad into the buffer and the contact-shadow march
       * would see a wall of solid rectangles where a plant is — a hard-edged
       * grey block under every tuft. `render/index.js` already honours this
       * flag; this is that documented opt-out, used for its exact purpose.
       */
      mesh.userData.scNoPrepass = true
      // InstancedMesh derives its bounding sphere from the geometry's box and
      // every instance matrix, so this is the real extent of the planted area
      // and per-field frustum culling actually means something.
      mesh.computeBoundingSphere()
      this.group.add(mesh)
      this._meshes.push({ mesh, total: n })
    }

    // The staging arrays are copied into typed arrays above and never read
    // again; hand them back rather than holding a second copy of the world.
    this._pages = this._pages.map(() => ({ matrix: [], colour: [], data: [] }))
    return this.group
  }

  /**
   * Density/LOD, 0..1. 1 draws every instance; 0.4 draws 40% of them, spatially
   * uniformly (see `build`). This is the knob for a frame budget: it is a
   * single integer write per mesh and it costs nothing to change per frame.
   */
  setLOD(fraction) {
    this._lod = THREE.MathUtils.clamp(fraction, 0, 1)
    for (const m of this._meshes) m.mesh.count = Math.round(m.total * this._lod)
    return this
  }

  /** Convenience: advance the shared clock. Identical to `foliageTick(t)`. */
  update(seconds) {
    _time.value = seconds
    return this
  }

  /** Per-field wind override, for a sheltered courtyard or an exposed spire. */
  setWind(amplitude, frequency) {
    for (const m of this._meshes) {
      const u = m.mesh.material.userData.foliageUniforms
      if (amplitude !== undefined) u.uWind.value.x = amplitude
      if (frequency !== undefined) u.uWind.value.y = frequency
    }
    return this
  }

  stats() {
    let instances = 0
    let triangles = 0
    for (const m of this._meshes) {
      instances += m.mesh.count
      triangles += m.mesh.count * (m.mesh.geometry.index.count / 3)
    }
    return {
      instances,
      drawCalls: this._meshes.length,
      triangles,
      pages: this._meshes.length,
      trianglesPerInstance: this.options.quads * 2,
      lod: this._lod,
    }
  }

  dispose() {
    for (const m of this._meshes) {
      m.mesh.geometry.dispose()
      m.mesh.material.dispose()
    }
    this._meshes.length = 0
    if (this.group) this.group.clear()
  }
}

/**
 * A deterministic permutation of 0..n-1.
 *
 * Fisher-Yates from the field's own seed. The point is that any PREFIX of the
 * result is a uniform random sample of the whole set, which is what turns
 * `mesh.count` into a density dial rather than a spatial crop.
 */
function shuffledOrder(n, seed) {
  const rand = rng(seed >>> 0)
  const order = new Uint32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  for (let i = n - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0
    const t = order[i]; order[i] = order[j]; order[j] = t
  }
  return order
}

// -------------------------------------------------------------- the scatterers

/**
 * Accept a box in any of the three shapes the codebase already uses and return
 * `{ minX, maxX, minZ, maxZ, top }` in world space.
 *
 * `level.js` speaks (cx, cy, cz, sx, sy, sz); `THREE.Box3` is what a caller
 * holding a computed extent has. Making the helper take both is four lines and
 * removes a whole class of "which convention was this one" bug at the call site.
 */
function normalizeBox(box) {
  if (Array.isArray(box)) {
    const [cx, cy, cz, sx, sy, sz] = box
    return {
      minX: cx - sx / 2, maxX: cx + sx / 2,
      minZ: cz - sz / 2, maxZ: cz + sz / 2,
      top: cy + sy / 2,
    }
  }
  if (box.isBox3) {
    return {
      minX: box.min.x, maxX: box.max.x,
      minZ: box.min.z, maxZ: box.max.z,
      top: box.max.y,
    }
  }
  const { cx, cy, cz, sx, sy, sz } = box
  return {
    minX: cx - sx / 2, maxX: cx + sx / 2,
    minZ: cz - sz / 2, maxZ: cz + sz / 2,
    top: cy + sy / 2,
  }
}

/**
 * A deterministic, spatially coherent 0..1 field over world XZ.
 *
 * Same argument as `materials/textures.js`'s `coherent`: white noise makes a
 * density mask that reads as film grain, and vegetation does not grow as film
 * grain. It grows in patches with bare ground between them, and the patches are
 * metres across.
 */
function clumpField(seed, scale) {
  const N = 32
  const rand = rng(seed >>> 0)
  const g = new Float32Array(N * N)
  for (let i = 0; i < g.length; i++) g[i] = rand()
  const smooth = (t) => t * t * (3 - 2 * t)
  return (x, z) => {
    const u = x / scale, v = z / scale
    const x0 = Math.floor(u), z0 = Math.floor(v)
    const fx = smooth(u - x0), fz = smooth(v - z0)
    const i = (a, b) => g[(((a % N) + N) % N) * N + (((b % N) + N) % N)]
    const a = i(x0, z0), b = i(x0 + 1, z0), c = i(x0, z0 + 1), d = i(x0 + 1, z0 + 1)
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz
  }
}

/** Pick a species from a weighted mix. */
function pickSpecies(mix, r) {
  let total = 0
  for (const m of mix) total += m[1]
  let t = r * total
  for (const m of mix) { t -= m[1]; if (t <= 0) return m[0] }
  return mix[mix.length - 1][0]
}

/**
 * The default mix for a walkable deck: mostly grass, a few flowers, the odd
 * small leaf clump and a little moss.
 *
 * Sized off docs/roadmap.md's "15-25 tuft cards and 5-8 flower clusters per
 * island" — a 6:1.2 grass:flower ratio lands inside that on a typical 8 m
 * platform at the default density.
 */
const DECK_MIX = [['grass', 6], ['flower', 1.2], ['leaf', 1.0], ['fern', 0.5]]

/**
 * The mix for a wall/floor junction: moss wedges with grass and the odd fern
 * coming out of the crack. This is docs/roadmap.md's `mossWedge(edge)` item,
 * satisfied by scattering rather than by a new kit primitive — pass it as
 * `mix` to `scatterOnBox` over a narrow strip along the wall base.
 *
 * Moss is deliberately NOT in DECK_MIX. A moss wedge is a thing that grows in a
 * corner where water sits; scattered across an open deck it reads as a row of
 * identical cabbages, which is exactly what the first capture showed.
 */
export const JUNCTION_MIX = [['moss', 7], ['grass', 2], ['fern', 0.6]]

/**
 * Plants per square metre before the clump mask takes its cut.
 *
 * MEASURED, not chosen. At 2.2 a 9 m platform came back with ~90 plants spread
 * over 81 square metres and read as a dirt lot with weeds in it — the exact
 * opposite of "LUSH vegetation... a primary element, not a garnish". At 7.0 the
 * same platform carries ~380 attempts, the clump mask keeps around 250 of them,
 * and the patches close up into cover while the bare ground between them
 * survives. That is 1500 triangles per island: a rounding error against the
 * ~986k the architecture already draws.
 *
 * The lushness has to come from COVERAGE rather than from HEIGHT, because
 * height is the one axis the ledge guard cannot give up — see scatterOnBox.
 */
const DECK_DENSITY = 7.0

/**
 * Dress the TOP FACE of a box with scattered plants.
 *
 * ============================ THE LEDGE GUARD ==============================
 * Two hard limits, both enforced here rather than trusted to the caller:
 *
 *   1. HEIGHT. Every card is clamped to `maxHeight` (default 0.35 m, and the
 *      default mix is under 0.26 m anyway). docs/taste.md: "Non-colliding
 *      scenery must never... visually impersonate a surface you can land on."
 *      A knee-high bush on a platform edge is exactly that lie.
 *   2. FOOTPRINT. Every card is inset from the box's own footprint by at least
 *      half its own width, so no leaf overhangs the collider the caller
 *      reserved. docs/geometry-unlock.md: "Inset is fine; overhang is the old
 *      bug."
 * ===========================================================================
 *
 * @param {FoliageField} field
 * @param {THREE.Box3|Array|object} box  the SOLID whose top face is being dressed
 * @param {object} [opts]
 *   density    plants per square metre before the clump mask (default 7)
 *   count      exact plant count, overriding `density`
 *   mix        `[[species, weight], ...]` (default DECK_MIX)
 *   inset      extra inset from the rim, metres (default 0.25)
 *   clump      0..1 patchiness of the density mask (default 0.55)
 *   clumpScale metres per clump (default 2.2)
 *   edgeBias   -1 pushes plants to the centre, +1 to the rim (default 0.15)
 *   maxHeight  hard cap in metres (default 0.35)
 *   y          override the surface height (default: the box's top face)
 * @returns {number} plants added
 */
export function scatterOnBox(field, box, opts = {}) {
  const b = normalizeBox(box)
  const {
    density = DECK_DENSITY,
    mix = DECK_MIX,
    inset = 0.25,
    clump = 0.55,
    clumpScale = 2.2,
    edgeBias = 0.15,
    maxHeight = 0.35,
  } = opts
  const y = opts.y ?? b.top

  const rand = field.rand
  const spanX = b.maxX - b.minX
  const spanZ = b.maxZ - b.minZ
  if (spanX <= inset * 2 || spanZ <= inset * 2) return 0

  const area = (spanX - inset * 2) * (spanZ - inset * 2)
  // Attempts, not placements: the clump mask rejects some, which is the point —
  // a field with no bare ground in it reads as carpet.
  const attempts = Math.max(1, Math.round(opts.count ?? area * density))
  const mask = clumpField((field.options.seed ^ 0x1F35A) >>> 0, clumpScale)

  let placed = 0
  for (let i = 0; i < attempts; i++) {
    let u = rand()
    let v = rand()
    if (edgeBias !== 0) {
      // Push toward (or away from) the rim by warping the unit square's radial
      // coordinate. Cheap, separable, and keeps the distribution uniform along
      // the rim rather than piling plants into the corners.
      const warp = (t) => {
        const c = t * 2 - 1
        const p = edgeBias > 0 ? 1 - edgeBias * 0.6 : 1 / (1 + edgeBias * 0.6)
        return (Math.sign(c) * Math.pow(Math.abs(c), p)) * 0.5 + 0.5
      }
      u = warp(u); v = warp(v)
    }
    const x = b.minX + inset + u * (spanX - inset * 2)
    const z = b.minZ + inset + v * (spanZ - inset * 2)

    // The clump mask. `clump` 0 disables it entirely and every attempt lands.
    const m = 1 - clump + clump * mask(x, z)
    if (rand() > m) continue

    const species = pickSpecies(mix, rand())
    const sp = SPECIES[species]
    let h = sp.size[0] + rand() * (sp.size[1] - sp.size[0])
    // Guard 1: the height cap.
    h = Math.min(h, maxHeight)
    const w = h * sp.aspect
    // Guard 2: the footprint. A card is `w` wide about its origin, so half of
    // it is what has to stay inside the box.
    const half = w * 0.5
    const cx = THREE.MathUtils.clamp(x, b.minX + half, b.maxX - half)
    const cz = THREE.MathUtils.clamp(z, b.minZ + half, b.maxZ - half)

    field.add(species, cx, y, cz, { height: h })
    placed++
  }
  return placed
}

/**
 * Drape hanging ivy off a lip.
 *
 * ANCHOR, matching `kit.vineCurtain` exactly so the two are interchangeable at
 * a call site: `(x, y, z)` is a point ON THE EDGE — `y` is the lip height — and
 * the run extends along `axis` in the POSITIVE direction over `length`.
 *
 * Everything is emitted strictly BELOW `y`, which is the whole safety argument:
 * a drape can only exist under an overhang, so it can never present a walkable
 * top surface, and the player can run straight through it.
 *
 * @param {FoliageField} field
 * @param {object} edge `{ x, y, z, axis: 'x'|'z', length, outward: -1|1 }`
 * @param {object} [opts]
 *   drop     `[min, max]` strand length in metres (default [0.9, 2.4])
 *   pitch    metres between strands (default 0.5)
 *   density  multiplier on the pitch (default 1)
 *   proud    how far the strands stand off the wall face (default 0.10 m)
 *   jitter   lateral scatter along the run (default 0.18 m)
 * @returns {number} strands added
 */
export function hangFromEdge(field, edge, opts = {}) {
  const {
    x = 0, y = 0, z = 0, axis = 'x', length = 4, outward = 1,
  } = edge
  const {
    drop = [0.9, 2.4],
    // 0.5 m, against a strand card 0.5-1.2 m wide: consecutive strands overlap
    // by roughly half. A curtain is what the reference shows; a picket fence of
    // separated strands is what a pitch equal to the card width produces.
    pitch = 0.5,
    density = 1,
    proud = 0.10,
    jitter = 0.18,
  } = opts

  const rand = field.rand
  const step = Math.max(0.15, pitch / Math.max(0.1, density))
  const alongX = axis === 'x'
  let placed = 0

  for (let a = step * 0.5; a < length; a += step) {
    const t = a + (rand() - 0.5) * jitter
    const off = proud * outward + (rand() - 0.5) * proud * 0.6
    const px = x + (alongX ? t : off)
    const pz = z + (alongX ? off : t)
    const h = drop[0] + rand() * (drop[1] - drop[0])
    // The card's origin is its BASE, and its top edge has to reach the lip, so
    // the origin sits a full drop below it. The vertex shader's `hang` flag
    // then pivots the sway at the top, where the strand actually grips.
    field.add('hangingIvy', px, y - h, pz, {
      height: h,
      // Bias the widest quad along the run, so a drape reads as a curtain from
      // the front rather than as a row of separate strands.
      yaw: (alongX ? 0 : Math.PI / 2) + (rand() - 0.5) * 0.9,
    })
    placed++
  }
  return placed
}

/**
 * Control points for ONE hero hanging vine, for `props.sweepTube` to render as
 * real geometry.
 *
 * The instanced field above is the MASS — hundreds of cards that cost six
 * triangles each. This is the other half of the same idea: two or three vines
 * per island that the player runs right past get to be actual tubes with actual
 * silhouettes, because a card seen from 40 cm away is a card.
 *
 * THE CURVE is a catenary, not an arc: a rope hanging under its own weight
 * leaves its anchor nearly horizontally and only turns vertical further down,
 * and that shape at the top is the entire reason a hanging thing reads as
 * hanging rather than as a line that was drawn downward. `cosh` normalised to
 * the requested drop gives it exactly, in one expression.
 *
 * @param {number} x anchor X (a point on the lip)
 * @param {number} y anchor Y
 * @param {number} z anchor Z
 * @param {object} [opts]
 *   drop     total fall in metres (default 3.2)
 *   reach    horizontal travel from the anchor (default 0.45)
 *   dir      `[dx, dz]` horizontal heading, normalised internally ([1, 0])
 *   segments control points returned (default 10)
 *   slack    catenary tightness; 0 is a straight line, 3+ is a heavy rope (2.2)
 *   wobble   lateral meander amplitude in metres (default 0.10)
 *   radius   `[base, tip]` tube radii in metres (default [0.045, 0.016])
 *   seed     determinism (default derived from the anchor)
 * @returns {THREE.Vector3[]} the control points, top first, with `radii`
 *          (number[], parallel) and `bottomY` attached for the caller's
 *          convenience — it is still a plain array, so `map`/`length`/spread
 *          all behave.
 */
export function vineRope(x, y, z, opts = {}) {
  const {
    drop = 3.2,
    reach = 0.45,
    dir = [1, 0],
    segments = 10,
    slack = 2.2,
    wobble = 0.10,
    radius = [0.045, 0.016],
  } = opts
  // Seeded off the anchor by default, so the same lip grows the same vine every
  // reload without the caller having to keep a counter.
  const seed = opts.seed ?? (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0)
  const rand = rng(seed || 1)

  const dl = Math.hypot(dir[0], dir[1]) || 1
  const dx = dir[0] / dl
  const dz = dir[1] / dl
  // The perpendicular, for the meander.
  const px = -dz
  const pz = dx

  const points = []
  const radii = []
  const k = Math.max(0.001, slack)
  const denom = Math.cosh(k) - 1
  // Two out-of-phase sines: a single one is a smooth arc and reads as a spring.
  const w1 = 1.7 + rand() * 1.6
  const w2 = 3.9 + rand() * 2.2
  const p1 = rand() * 6.283
  const p2 = rand() * 6.283

  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    // Catenary: flat at the anchor, vertical at the tip.
    const fall = denom > 1e-6 ? (Math.cosh(k * t) - 1) / denom : t
    const out = reach * t
    const mean = wobble * (Math.sin(t * w1 + p1) * 0.7 + Math.sin(t * w2 + p2) * 0.3) * t
    points.push(new THREE.Vector3(
      x + dx * out + px * mean,
      y - drop * fall,
      z + dz * out + pz * mean))
    // Taper, plus a small swell so the rope is not a perfect cone.
    const swell = 1 + Math.sin(t * 9.1 + p1) * 0.07
    radii.push((radius[0] + (radius[1] - radius[0]) * t) * swell)
  }

  points.radii = radii
  points.bottomY = y - drop
  return points
}

// -------------------------------------------------------------- the self test

/**
 * Build a representative field and report what it costs.
 *
 * Modelled on `render/selftest.js`: the point is a number a reviewer can check,
 * not a console message that says "OK". Everything here is measured, and the
 * `checks` array is what fails a review rather than a comment claiming success.
 *
 * Runs the real atlas painter, so it also proves the canvas path works in
 * whatever context it is called from.
 *
 * @param {object} [opts] `{ islands, platform }` — how many islands' worth of
 *                        dressing to simulate.
 * @returns {object}
 */
export function foliageSelfTest(opts = {}) {
  const islands = opts.islands ?? 6
  /** A typical drum platform from level.js: ~9 m across. */
  const platform = opts.platform ?? 9

  const t0 = (typeof performance !== 'undefined' ? performance.now() : 0)
  const atlas = foliageAtlas()
  const atlasMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0

  const fields = []
  let scattered = 0
  let draped = 0
  let ropePoints = 0

  for (let i = 0; i < islands; i++) {
    const field = new FoliageField({ seed: 0x5EED1 + i * 977 })
    const cx = i * 60
    scattered += scatterOnBox(field, {
      cx, cy: 0, cz: 0, sx: platform, sy: 1, sz: platform,
    })
    for (let e = 0; e < 4; e++) {
      const alongX = e % 2 === 0
      draped += hangFromEdge(field, {
        x: cx - platform / 2 + (alongX ? 0 : (e === 1 ? platform : 0)),
        y: -0.5,
        z: -platform / 2 + (alongX ? (e === 0 ? 0 : platform) : 0),
        axis: alongX ? 'x' : 'z',
        length: platform,
        outward: e < 2 ? -1 : 1,
      })
    }
    field.build()
    fields.push(field)
    ropePoints += vineRope(cx, -0.5, -platform / 2, { drop: 3.2 }).length
  }

  let instances = 0
  let triangles = 0
  let drawCalls = 0
  for (const f of fields) {
    const s = f.stats()
    instances += s.instances
    triangles += s.triangles
    drawCalls += s.drawCalls
  }

  // Atlas coverage, per mip, as evidence that the coverage-preserving chain
  // actually preserves coverage. This is the number that goes wrong silently.
  const page = atlas.pages[0].texture
  const coverage = page.mipmaps
    .filter((m) => m.width >= 32)
    .map((m) => +coverageOf(m.data, ALPHA_TEST * 255).toFixed(4))

  const first = coverage[0]
  const drift = coverage.reduce((mx, c) => Math.max(mx, Math.abs(c - first)), 0)

  const checks = [
    ['atlas has a full mip chain to 1x1',
      page.mipmaps.length === Math.log2(ATLAS_SIZE) + 1],
    ['mip coverage holds within 2% of level 0', drift < 0.02],
    ['every species cell is inside the grid',
      Object.values(SPECIES).every((s) => s.cells.every((c) => c >= 0 && c < atlas.cells))],
    ['one draw call per field per page', drawCalls === fields.length],
    ['instances were actually emitted', instances > 0],
    ['deck scatter stays under the ledge height',
      SPECIES.grass.size[1] < 0.35 && SPECIES.flower.size[1] < 0.35],
    ['foliage is excluded from the depth prepass',
      fields.every((f) => f.group.children.every((c) => c.userData.scNoPrepass === true))],
    ['nothing foliage emits is transparent-blended',
      fields.every((f) => f.group.children.every((c) => c.material.transparent === false))],
  ]

  const result = {
    atlas: {
      size: ATLAS_SIZE,
      cells: atlas.cells,
      mipLevels: page.mipmaps.length,
      coverage,
      coverageDrift: +drift.toFixed(4),
      // Time for THIS call. 0 means the atlas was already cached by an earlier
      // field, which is the normal case and is the point of the cache — the
      // paint cost is paid once for the whole world.
      buildMs: +atlasMs.toFixed(1),
      bytes: page.mipmaps.reduce((n, m) => n + m.data.length, 0),
    },
    fields: fields.length,
    instances,
    scattered,
    draped,
    drawCalls,
    triangles,
    trianglesPerInstance: 6,
    ropePoints,
    /** Per-island cost, which is the number that decides whether this ships. */
    perIsland: {
      instances: Math.round(instances / fields.length),
      triangles: Math.round(triangles / fields.length),
    },
    checks: checks.map(([name, ok]) => ({ name, ok })),
    ok: checks.every(([, ok]) => ok),
  }

  for (const f of fields) f.dispose()
  return result
}
