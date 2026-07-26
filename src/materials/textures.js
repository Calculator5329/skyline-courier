import * as THREE from 'three'

/**
 * THE TILE LAYER — every surface texture in the game, painted into canvases at
 * load. No image files, ever.
 *
 * This module answers the single most damaging note from the art review: brass
 * "reads unambiguously as varnished pine". It did, and the reason was that the
 * old painters wrote ONE channel. A stencil of dark ring art on a flat orange
 * field is what varnished plywood looks like; it is not what metal looks like,
 * because metal is defined by how light moves across its form, not by drawing
 * the form on in ink.
 *
 * So every painter here writes FOUR channels, and the rule is strict:
 *
 *   ALBEDO   — material CHANGE only. Where the stuff itself is different:
 *              verdigris, moss, cool mortar, bleached wear on a chipped arris.
 *              NEVER a drawn highlight or a drawn shadow. Baking a light
 *              direction into albedo is exactly the "stencil" failure, and it
 *              also double-lights once a real normal exists.
 *   HEIGHT   — form. Bevels, rivet domes, gear teeth, moss clumps, tile crowns.
 *              This is what the normal map is differentiated out of, so it is
 *              what actually makes an edge catch the sun.
 *   ROUGH    — polish. On metal this carries almost all of the character: the
 *              planishing marks and turned rings are a roughness signal, and
 *              you read them in the highlight, not in the colour.
 *   METAL    — where it is bare metal and where it is corrosion product.
 *              Verdigris is a dielectric salt. Painting it green while leaving
 *              metalness at 1.0 is why the old brass had no material contrast.
 *
 * Plus a fifth, derived: CAVITY, packed into the normal map's alpha. It is the
 * local height minus a blurred height, i.e. "how deep in a pocket am I", and
 * shader.js uses it to tint recesses COOL. That is not a stylistic flourish —
 * a pocket sees the cool green zenith and not the low warm sun, so the
 * warm-key/cool-shadow split the art direction is built on has to start at the
 * texel scale or it never appears at all.
 */

/**
 * 512 across a 2.38 m tile (level.js runs 0.42 repeats/metre) is 4.6 mm per
 * texel. That is the resolution at which a 12 mm rivet dome is a dome rather
 * than three pixels, and the closeup shot is taken from ~1 m off the wall.
 */
export const SIZE = 512

/** Deterministic RNG — the world must look the same every reload. */
export function rng(seed) {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

function canvas2d() {
  const c = document.createElement('canvas')
  c.width = c.height = SIZE
  return [c, c.getContext('2d')]
}

/** Height as a canvas grey. 128 is the neutral plane every painter starts from. */
const HEIGHT_MID = 128
function hg(v) {
  const k = Math.max(0, Math.min(255, Math.round(v)))
  return `rgb(${k},${k},${k})`
}

/** Roughness in G, metalness in B. R is spare and stays 0. */
function mg(rough, metal, a = 1) {
  return `rgba(0,${Math.round(rough * 255)},${Math.round(metal * 255)},${a})`
}

/**
 * Draw something nine times, once per wrap offset.
 *
 * Anything drawn near an edge — a rivet, a clump, a gear tooth — would
 * otherwise be cut in half at the tile seam, and a cut-in-half feature repeated
 * across a wall is a ruled line pointing straight at the tiling.
 */
function wrapped(ctx, draw) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      ctx.save()
      ctx.translate(dx * SIZE, dy * SIZE)
      draw()
      ctx.restore()
    }
  }
}

/** A soft radial patch: the basic unit of clumped, organic, non-uniform cover. */
function blob(ctx, x, y, r, inner, outer) {
  wrapped(ctx, () => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, inner)
    g.addColorStop(1, outer)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  })
}

/**
 * A deterministic, spatially coherent 0..1 field, bilinearly sampled from a
 * small random lattice.
 *
 * Needed because `rand()` on its own is white noise, and white noise makes a
 * mask that reads as film grain rather than as patchy growth. The lattice is
 * drawn from the caller's seeded rng, so the world still looks identical every
 * reload.
 */
function coherent(rand, cells) {
  const g = new Float32Array(cells * cells)
  for (let i = 0; i < g.length; i++) g[i] = rand()
  return (x, y) => {
    // Texture space -> lattice space, wrapping, so the field tiles with the map.
    const u = (x / SIZE) * cells
    const v = (y / SIZE) * cells
    const xi = Math.floor(u), yi = Math.floor(v)
    const fx = u - xi, fy = v - yi
    // Smoothstep, not linear: a linear lattice leaves visible diamond creases.
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const x0 = ((xi % cells) + cells) % cells
    const y0 = ((yi % cells) + cells) % cells
    const x1 = (x0 + 1) % cells
    const y1 = (y0 + 1) % cells
    const a = g[y0 * cells + x0], b = g[y0 * cells + x1]
    const c = g[y1 * cells + x0], d = g[y1 * cells + x1]
    const top = a + (b - a) * sx
    const bot = c + (d - c) * sx
    return top + (bot - top) * sy
  }
}

/**
 * Read a height canvas back and return "how deep in a pocket is this texel",
 * normalised to roughly 0..1.
 *
 * This is the same measurement `normalFromHeight` packs into the normal map's
 * alpha, computed early so a PAINTER can use it. That matters because the art
 * review's standing complaint about brass is that the verdigris was placed by
 * independent noise and therefore landed on proud plate as often as in a
 * groove, which reads as mould rather than as corrosion. Corrosion is not a
 * random event; it is where water sits. So the mask has to be the geometry.
 */
function cavityField(hctx, radius, gain) {
  const src = hctx.getImageData(0, 0, SIZE, SIZE).data
  const hf = new Float32Array(SIZE * SIZE)
  for (let i = 0; i < hf.length; i++) hf[i] = src[i * 4] / 255
  const blurred = new Float32Array(SIZE * SIZE)
  boxBlurWrap(hf, blurred, SIZE, radius)
  const cav = new Float32Array(SIZE * SIZE)
  for (let i = 0; i < cav.length; i++) {
    cav[i] = Math.max(0, Math.min(1, (blurred[i] - hf[i]) * gain))
  }
  return cav
}

/**
 * Smear a mask downward with an exponential decay, so whatever collects in a
 * recess also runs out of the bottom of it.
 *
 * Canvas y increases downward and texture v increases upward, and level.js maps
 * v to world height on vertical faces — so +y here is genuinely "down the wall".
 * Two passes because the tile wraps: one pass alone leaves the top of the tile
 * unaware of what is dripping off the bottom of the copy above it.
 */
function dripDown(mask, decay) {
  const out = new Float32Array(mask.length)
  for (let x = 0; x < SIZE; x++) {
    let run = 0
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < SIZE; y++) {
        const i = y * SIZE + x
        run = Math.max(mask[i], run * decay)
        out[i] = run
      }
    }
  }
  return out
}

/**
 * Composite an RGBA field over a 2D context.
 *
 * `fill(i, x, y)` returns [r, g, b, a] in 0..255. Goes through a scratch canvas
 * rather than putImageData on the target because putImageData REPLACES pixels
 * and we want an alpha-blended overlay.
 */
function overlayField(ctx, fill) {
  const [c, cx] = canvas2d()
  const img = cx.createImageData(SIZE, SIZE)
  const d = img.data
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x
      const px = fill(i, x, y)
      if (!px) continue
      d[i * 4] = px[0]; d[i * 4 + 1] = px[1]; d[i * 4 + 2] = px[2]; d[i * 4 + 3] = px[3]
    }
  }
  cx.putImageData(img, 0, 0)
  ctx.drawImage(c, 0, 0)
}

/**
 * In-place per-texel edit of a canvas, as a MULTIPLY rather than an overlay.
 *
 * `overlayField` above composites source-over, which is right for laying a new
 * substance (verdigris crust) on top of an old one. It is wrong for modulating
 * one that is already there: source-over toward a colour pulls every channel
 * toward that colour, so darkening a texel by 18% would also drag its hue, and
 * on the ORM canvas it would drag metalness in B down along with roughness in
 * G. `fn(px, i, x, y)` gets [r, g, b] in 0..255 and mutates it in place; the
 * array is reused across texels, so this allocates once for the whole pass.
 */
function modulateField(ctx, fn) {
  const img = ctx.getImageData(0, 0, SIZE, SIZE)
  const d = img.data
  const px = [0, 0, 0]
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x
      const j = i * 4
      px[0] = d[j]; px[1] = d[j + 1]; px[2] = d[j + 2]
      fn(px, i, x, y)
      d[j] = Math.max(0, Math.min(255, px[0] | 0))
      d[j + 1] = Math.max(0, Math.min(255, px[1] | 0))
      d[j + 2] = Math.max(0, Math.min(255, px[2] | 0))
    }
  }
  ctx.putImageData(img, 0, 0)
}

/** The height canvas as a 0..1 field. Same read cavityField does, published so
 *  a painter can drive roughness off the form it just carved. */
function readHeight(hctx) {
  const src = hctx.getImageData(0, 0, SIZE, SIZE).data
  const hf = new Float32Array(SIZE * SIZE)
  for (let i = 0; i < hf.length; i++) hf[i] = src[i * 4] / 255
  return hf
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function speckle(ctx, rand, count, colors, sizeMin, sizeMax) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[(rand() * colors.length) | 0]
    const r = sizeMin + rand() * (sizeMax - sizeMin)
    ctx.beginPath()
    ctx.arc(rand() * SIZE, rand() * SIZE, r, 0, Math.PI * 2)
    ctx.fill()
  }
}

/**
 * A dome in the height field: rivet heads, moss clumps, boulder crowns.
 *
 * SIXTEEN STOPS, NOT FOUR. A canvas gradient interpolates linearly between its
 * stops, so every stop is a slope discontinuity — and this field is about to be
 * differentiated into a normal map, which turns each discontinuity into a
 * visible concentric ring. A four-stop dome produced exactly that: the moss
 * caps came back covered in crop-circle rings. The profile below is
 * cos-shouldered, sampled finely enough that the residual facets are under a
 * code value.
 */
const DOME_STOPS = 16
function dome(hctx, x, y, r, peak, base = HEIGHT_MID) {
  wrapped(hctx, () => {
    const g = hctx.createRadialGradient(x, y, 0, x, y, r)
    for (let i = 0; i <= DOME_STOPS; i++) {
      const t = i / DOME_STOPS
      // Raised cosine: flat at the crown, flat where it meets the plate, and
      // steepest halfway out. Both ends being flat is what stops a dome from
      // showing a rim crease where it lands.
      const p = 0.5 + 0.5 * Math.cos(Math.PI * t)
      g.addColorStop(t, hg(base + (peak - base) * p))
    }
    hctx.fillStyle = g
    hctx.beginPath()
    hctx.arc(x, y, r, 0, Math.PI * 2)
    hctx.fill()
  })
}

// ---------------------------------------------------------------- painters

/**
 * One carved ashlar block, written as FORM rather than as line art.
 *
 * The bevel is the whole point: a cut stone reads as cut because its arris
 * catches light differently from its face. Previously that was four grey
 * rectangles drawn into albedo, which is a picture of a bevel. Here it is four
 * gradients in the height field, so the arris genuinely turns toward the sun
 * and genuinely goes dark on the shaded side, and it keeps doing so as the
 * player moves.
 */
function carvedBlock(h, x, y, w, hh, rand, joint, bevel) {
  // Per-block set height: hand-cut stone is not shimmed to a common plane, and
  // a +/-3% proud/shy variation is the cheapest thing that stops a wall from
  // reading as one poured slab with lines scored into it.
  //
  // Drawn OUTSIDE wrapped(): a rand() call inside the replay gives each of the
  // nine wrap copies a different height, so a block straddling the tile seam
  // came back as two blocks at two levels with a step between them.
  const top = 168 + (rand() - 0.5) * 22
  wrapped(h, () => {
    const x0 = x + joint
    const y0 = y + joint
    const w0 = w - joint * 2
    const h0 = hh - joint * 2
    h.fillStyle = hg(top)
    h.fillRect(x0, y0, w0, h0)

    // Bevel ramps from the joint floor up to the face on all four sides.
    const floor = 96
    const ramp = (gx0, gy0, gx1, gy1, rx, ry, rw, rh) => {
      const g = h.createLinearGradient(gx0, gy0, gx1, gy1)
      g.addColorStop(0, hg(floor))
      g.addColorStop(1, hg(top))
      h.fillStyle = g
      h.fillRect(rx, ry, rw, rh)
    }
    ramp(x0, 0, x0 + bevel, 0, x0, y0, bevel, h0)
    ramp(x0 + w0, 0, x0 + w0 - bevel, 0, x0 + w0 - bevel, y0, bevel, h0)
    ramp(0, y0, 0, y0 + bevel, x0, y0, w0, bevel)
    ramp(0, y0 + h0, 0, y0 + h0 - bevel, x0, y0 + h0 - bevel, w0, bevel)
  })
}

/**
 * THE COURSE TABLE — the scale hierarchy, and the thing that used to be two
 * global constants.
 *
 * It was COURSES = 4, BLOCKS_PER_COURSE = 3, applied identically to every
 * course: one 0.79 x 0.60 m module repeated across the entire world, with the
 * same joint width, the same joint depth and the same bevel on every unit. The
 * review's note is exactly right — real architecture reads because it HAS
 * hierarchy (a heavy plinth, mid ashlar, a thin string course, fine paving) and
 * because no two blocks are identical. One module everywhere means the eye
 * finds a grid rather than a building, and the repeat was plainly traceable
 * across the deck in every ground shot.
 *
 * So the tile now carries four DIFFERENT courses, and the block count varies
 * per course as well:
 *
 *   height  — fraction of the 2.38 m tile, summing to 1.
 *   blocks  — nominal block count; the widths inside are then jittered and
 *             renormalised, so the vertical joints do not line up between
 *             courses and cannot line up with themselves across the wrap.
 *   joint   — mortar channel half-width in texels (4.6 mm each).
 *   bevel   — arris chamfer in texels. A heavy plinth is cut with a heavier
 *             chamfer than a string course; that difference is most of what
 *             makes one course read as structurally different from another.
 *   offset  — where the course's first vertical joint sits, as a fraction of
 *             the tile. Four unrelated values rather than the old alternating
 *             half-block, so no two courses share a vertical joint line.
 *
 * Still four courses because the tile has to wrap. Heights must sum to 1.
 */
const COURSE_TABLE = [
  // A heavy plinth course: tall, few and wide blocks, deep joints, big chamfer.
  { height: 0.31, blocks: 2, joint: 4.6, bevel: 9.5, offset: 0.11 },
  // Standard ashlar.
  { height: 0.25, blocks: 3, joint: 4.2, bevel: 7.0, offset: 0.63 },
  // A thin string course: a band of small, finely-jointed units.
  { height: 0.16, blocks: 5, joint: 2.8, bevel: 4.0, offset: 0.29 },
  // Standard ashlar again, offset and cut differently from the first.
  { height: 0.28, blocks: 4, joint: 4.6, bevel: 7.5, offset: 0.81 },
]

const PAINTERS = {
  /**
   * Warm carved sandstone: the ashlar the whole archipelago is built from.
   * Warm proud faces, COOL green-grey joints. That contrast is the smallest
   * unit of the warm-key/cool-shadow split and it costs nothing.
   */
  porcelain(a, h, m, rand) {
    // Peach/ochre rather than the old #e7d3ac: same value, noticeably lower
    // saturation. The review measured 84% of the terrace inside one 20-degree
    // hue bin; sandstone is the biggest contributor to that by area, and the
    // cheapest thing it can do about it is stop shouting the same hue.
    a.fillStyle = '#e8d2b0'
    a.fillRect(0, 0, SIZE, SIZE)
    // Joints are painted first and left exposed by the block faces on top: a
    // recess sees sky, not sun, so it is COOLER and greener than the face.
    // This is the cheapest correct source of cool in the whole frame.
    m.fillStyle = mg(0.88, 0.0)
    m.fillRect(0, 0, SIZE, SIZE)
    h.fillStyle = hg(96)
    h.fillRect(0, 0, SIZE, SIZE)

    /**
     * Lay the courses out ONCE, then paint height, albedo, roughness and the
     * joint overlay from the same layout. Previously the joint overlay
     * re-derived the grid from the constants, which is why the two could only
     * ever agree if the grid stayed perfectly regular.
     */
    const courses = []
    let y = 0
    for (let r = 0; r < COURSE_TABLE.length; r++) {
      const spec = COURSE_TABLE[r]
      const ch = SIZE * spec.height
      // Block widths, jittered +/-28% and then renormalised so the course still
      // spans exactly one tile. Real ashlar is cut to fit the wall, not to a
      // grid, and an even set of widths is the single loudest "this is a
      // texture" tell on a large deck.
      const raw = []
      let total = 0
      for (let b = 0; b < spec.blocks; b++) {
        const w = 1 + (rand() - 0.5) * 0.56
        raw.push(w)
        total += w
      }
      const blocks = []
      // Start each course at its own offset so vertical joints stagger between
      // courses instead of stacking into a running seam.
      let x = -SIZE * spec.offset
      for (let b = 0; b < spec.blocks; b++) {
        const w = (raw[b] / total) * SIZE
        blocks.push({ x, w })
        x += w
      }
      courses.push({ y, ch, blocks, spec })
      y += ch
    }

    for (const c of courses) {
      for (const blk of c.blocks) {
        // Per-block joint and bevel jitter on top of the course's own values:
        // a hand-cut stone is not shimmed, and the widths of its mortar beds
        // differ on all four sides.
        const joint = c.spec.joint * (0.78 + rand() * 0.44)
        const bevel = c.spec.bevel * (0.72 + rand() * 0.56)
        carvedBlock(h, blk.x, c.y, blk.w, c.ch, rand, joint, bevel)

        /**
         * Albedo: face colour only. The old jitter was 0.92-1.07 in value and
         * nothing else, a 15% range the review correctly called invisible.
         * This is 0.80-1.14 in value AND a warm/cool swing of the same block —
         * different stones out of different parts of the bed weather to
         * different colours, not just different brightnesses, and the cool
         * blocks are free hue variety on the material that dominates the frame.
         */
        const v = 0.80 + rand() * 0.34
        /**
         * The warm/cool swing is small AND biased warm, and both halves of that
         * are load-bearing.
         *
         * At the +/-0.08 it started on, a "cool" block came out at rgb(213,210,
         * 190) — hue 55, an olive. On a wall you never notice, because you read
         * one or two blocks; on a deck you read forty at once and the paving
         * measured hue 44-54 while the wall built of the SAME material measured
         * 35. One substance reading as two depending on which way it faces is
         * the exact failure the material palette exists to prevent.
         *
         * +/-0.045 around a +0.03 warm centre keeps the bed variety without any
         * single block leaving the sandstone family.
         */
        const warm = 0.03 + (rand() - 0.5) * 0.09
        // One block in eleven has been cut out and replaced: fresh unweathered
        // stone, paler and much less patinated. It is the strongest single
        // break in the grid and it costs one branch.
        const fresh = rand() < 0.09 ? 1.13 : 1.0
        wrapped(a, () => {
          a.fillStyle = `rgb(${(232 * v * (1 + warm) * fresh) | 0},${(210 * v * fresh) | 0},${(176 * v * (1 - warm) * fresh) | 0})`
          a.fillRect(blk.x + joint, c.y + joint, blk.w - joint * 2, c.ch - joint * 2)
        })
        wrapped(m, () => {
          // A dressed face is smoother than a mortar joint, and blocks vary.
          m.fillStyle = mg(0.52 + rand() * 0.30, 0.0)
          m.fillRect(blk.x + joint, c.y + joint, blk.w - joint * 2, c.ch - joint * 2)
        })
      }
    }

    // The cool joint colour, laid back over the exposed channel — driven off
    // the same layout so it lands in the channels the blocks actually left.
    wrapped(a, () => {
      /**
       * THE JOINT COLOUR IS A MIP-AVERAGE PROBLEM, not just a colour choice.
       *
       * A cool grey-green mortar line is correct and cheap at close range — a
       * recess sees sky, not sun. But a deck is viewed at a grazing angle, so
       * several tiles' worth of texels land in one pixel and the frame samples
       * the tile's MEAN, not its blocks. The course table above widened the
       * joints, and the measured consequence was the paving going from hue 28
       * to hue 55 while the wall built of the identical material stayed at 35 —
       * one substance reading as two depending on which way it faced.
       *
       * So: less of it. 0.42 rather than the 0.62 it started at.
       *
       * And the hue moved as well as the amount: 132,132,114 is hue 60, which
       * is the olive corner, and the mip mean of a deck is mostly joint. A
       * recess should read COOL, not YELLOW-green — 124,128,128 is hue 180 at
       * saturation 0.031, so it still pulls the mean toward the sky the joint
       * actually sees without pulling it toward khaki.
       */
      a.fillStyle = 'rgba(124,128,128,0.42)'
      for (const c of courses) {
        a.fillRect(0, c.y - c.spec.joint, SIZE, c.spec.joint * 2)
        for (const blk of c.blocks) {
          a.fillRect(blk.x - c.spec.joint, c.y, c.spec.joint * 2, c.ch)
        }
      }
    })

    // Settlement cracks: a handful of hairlines wandering across a face and,
    // sometimes, straight through a joint. They are cut into HEIGHT so the
    // normal map turns them into a real dark line under a raking sun, and they
    // are the one feature in the tile that ignores the block grid entirely —
    // which is precisely why the eye stops reading the grid as a grid.
    h.lineCap = 'round'
    // Five, not nine. At nine the deck came back covered in what read as
    // scratches rather than as settlement: a crack is a rare event, and the
    // thing that makes it break the grid is that it is singular.
    for (let i = 0; i < 5; i++) {
      // The whole path is generated FIRST and then replayed by wrapped(). Any
      // rand() called inside a wrapped() draw gives each of the nine copies a
      // different result, which is the one thing wrapped() exists to prevent.
      const path = []
      let cx = rand() * SIZE
      let cy = rand() * SIZE
      // Mostly-vertical, because a settlement crack follows the load path.
      let ca = (rand() < 0.5 ? 1 : -1) * (Math.PI / 2) + (rand() - 0.5) * 0.9
      const segs = 4 + ((rand() * 5) | 0)
      for (let s = 0; s < segs; s++) {
        const len = 6 + rand() * 14
        const nx = cx + Math.cos(ca) * len
        const ny = cy + Math.sin(ca) * len
        // Tapers to nothing: a crack that keeps its width for 30 cm is a drawn
        // line, not a fracture.
        path.push([cx, cy, nx, ny, 1.7 * (1 - s / segs) + 0.4])
        cx = nx; cy = ny; ca += (rand() - 0.5) * 0.9
      }
      wrapped(h, () => {
        // 82, not 54. A deeper cut throws a bright normal-mapped lip beside the
        // dark line and the pair reads as a hair lying on the deck.
        h.strokeStyle = hg(82)
        for (const [x0, y0, x1, y1, w] of path) {
          h.lineWidth = w
          h.beginPath()
          h.moveTo(x0, y0)
          h.lineTo(x1, y1)
          h.stroke()
        }
      })
    }
    h.lineCap = 'butt'

    // Chisel tooling across the faces. Short, shallow, slightly off-vertical
    // strokes in HEIGHT: this is the difference between "cut stone" and
    // "extruded box with a stone picture on it", and it is invisible in albedo.
    for (let i = 0; i < 900; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const len = 4 + rand() * 9
      const ang = 1.25 + (rand() - 0.5) * 0.5
      h.strokeStyle = hg(HEIGHT_MID + (rand() < 0.5 ? 20 : -20))
      h.lineWidth = 1.0 + rand() * 1.4
      h.globalAlpha = 0.10 + rand() * 0.14
      h.beginPath()
      h.moveTo(x, y)
      h.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len)
      h.stroke()
    }
    h.globalAlpha = 1

    // Weathering: warm bleach on the exposed faces, cool damp in the shelter.
    speckle(a, rand, 2600, ['rgba(178,146,102,.11)', 'rgba(255,246,222,.24)', 'rgba(118,118,96,.09)'], 0.6, 2.6)
    // Damp and lichen pooling. Green-grey, and deliberately stronger than
    // before: this is where cool lives on a warm surface.
    for (let i = 0; i < 12; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const r = 34 + rand() * 62
      // Rotated off hue 88 (olive) to hue 132 and pulled back from .30 to .24:
      // twelve blobs up to 96 texels across is 40% of the tile, and sandstone
      // is the largest area in almost every frame, so this one call was a
      // measurable share of the deck's green.
      blob(a, x, y, r, 'rgba(106,128,112,.24)', 'rgba(106,128,112,0)')
      blob(m, x, y, r, mg(0.95, 0, 0.5), mg(0.95, 0, 0))
    }
    // Chipped arrises: where a corner has broken off, fresh unweathered stone
    // shows, which is LIGHTER and less saturated than the patinated face.
    // Deliberately few and small — at 4.6 mm per texel a 10-texel chip is 5 cm,
    // and a floor covered in those reads as blisters rather than as wear.
    for (let i = 0; i < 14; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const r = 2 + rand() * 4
      blob(a, x, y, r, 'rgba(250,240,218,.50)', 'rgba(250,240,218,0)')
      dome(h, x, y, r * 1.4, HEIGHT_MID - 30, HEIGHT_MID)
    }
  },

  /**
   * Aged brass: the signature material, and the one that says "you can
   * wall-run on me".
   *
   * Three deliberate reversals from the version the art director rejected:
   *
   *  1. NO AXIAL GRAIN. The old painter drew 460 full-height vertical streaks.
   *     That is a drawing of wood. Rolled and planished plate carries fine
   *     marks ACROSS the roll, and turned bosses carry concentric rings — and
   *     both of those live in roughness, not in colour.
   *  2. The rings, teeth and rivets are HEIGHT. They were albedo line art,
   *     which is why they read as a blurry brown stencil.
   *  3. The base albedo is the physical F0 of brass (pale yellow-gold), not the
   *     colour brass *appears*. On a metal, appearance is reflection tinted by
   *     F0; painting the appearance into albedo and then multiplying by a
   *     reflection is how you get flat orange.
   */
  brass(a, h, m, rand) {
    // On a metal, albedo IS the specular colour, and the colour you see is the
    // environment TINTED by it. This sky is orange; a neutral-pale F0 therefore
    // returns orange, which is how the first pass ended up with a brass wall
    // and a terracotta balustrade at the same hue.
    //
    // So this F0 is deliberately GREEN-gold rather than the red-gold real brass
    // has: linear (0.92, 0.87, 0.27), i.e. the green channel essentially equal
    // to the red. The sun and sky arrive with green at ~0.6 of red, so an F0
    // with G < R multiplies down to orange no matter what else we do; only an
    // F0 with G >= R lands the reflection back in the gold band. The art review
    // asked for "a greener gold" and this is the arithmetic behind it.
    a.fillStyle = '#f4ec80'
    a.fillRect(0, 0, SIZE, SIZE)
    h.fillStyle = hg(HEIGHT_MID)
    h.fillRect(0, 0, SIZE, SIZE)
    /**
     * 0.26 for the open plate, NOT the 0.14 this used to be — and that is a
     * widening, not a dulling.
     *
     * A material reads as metal from the RANGE of its polish, not its mean: a
     * plate at 0.14 and a rivet crown at 0.11 are the same finish, and the
     * measured result was a 24-luma span across a 200x200 patch of "polished
     * brass". Everything ornamental below now cuts well under this — rivet
     * crowns at 0.05, gear rims at 0.07 — and everything recessed goes well
     * over it, at 0.55-0.70. The plate is the middle of a real spread.
     */
    m.fillStyle = mg(0.26, 1.0)
    m.fillRect(0, 0, SIZE, SIZE)

    // --- planishing ------------------------------------------------------
    /**
     * Fine marks ACROSS the plate, in roughness only, at FULL alpha and over a
     * much wider range than before (0.08 to 0.46 against the old 0.06-0.22 at
     * 55% alpha).
     *
     * This is the cheap stand-in for anisotropy, and it does two jobs. A
     * highlight crossing the plate breaks into horizontal streaks instead of
     * washing it evenly, which is what brushed metal looks like; and because
     * the streaks run along the wall's long axis, a wall-run gets directional
     * parallax off the surface it is running along, which the review found
     * completely absent. True anisotropic GGX would be better and is noted in
     * the roadmap; it needs tangents on the level geometry, which is not ours.
     */
    for (let i = 0; i < 620; i++) {
      const y = rand() * SIZE
      // Under 1.5 texels (7 mm) — these are tool marks, not planks. At 2.6 the
      // streaks were wide enough that a grazing view smeared the whole plate
      // into what read as motion blur rather than as a brushed finish.
      const t = 0.4 + rand() * 1.1
      m.fillStyle = mg(0.12 + rand() * 0.26, 1.0)
      m.fillRect(0, y, SIZE, t)
    }
    // A whisper of the same signal in height, so grazing light finds it.
    for (let i = 0; i < 220; i++) {
      h.fillStyle = hg(HEIGHT_MID + (rand() < 0.5 ? 5 : -5))
      h.globalAlpha = 0.5
      h.fillRect(0, rand() * SIZE, SIZE, 0.6 + rand() * 1.4)
    }
    h.globalAlpha = 1

    // --- machined bands and rivets ---------------------------------------
    // Bands sit at 0 and SIZE/2 so they wrap exactly. The band is a real
    // channel: floor down, shoulders up, domed rivet heads proud of both.
    const rivetPitch = SIZE / 16
    const bandHalf = 9
    for (const y of [0, SIZE / 2, SIZE]) {
      wrapped(h, () => {
        // Channel floor.
        h.fillStyle = hg(88)
        h.fillRect(0, y - bandHalf, SIZE, bandHalf * 2)
        // Rolled shoulders either side, ramping back up to the plate.
        for (const s of [-1, 1]) {
          const g = h.createLinearGradient(0, y + s * bandHalf, 0, y + s * (bandHalf + 5))
          g.addColorStop(0, hg(88))
          g.addColorStop(1, hg(HEIGHT_MID + 10))
          h.fillStyle = g
          h.fillRect(0, s < 0 ? y - bandHalf - 5 : y + bandHalf, SIZE, 5)
        }
      })
      // Rivet heads: proud domes standing out of the channel floor. The dome
      // is the entire relief cue — there is no drawn highlight anywhere.
      for (let i = 0; i < 16; i++) {
        const cx = (i + 0.5) * rivetPitch
        dome(h, cx, y, 7.2, 196, 88)
        // Rivet heads are hammered, so they are polished where they are struck
        // and dull in the ring where the tool never touched.
        wrapped(m, () => {
          const g = m.createRadialGradient(cx, y, 0, cx, y, 7.6)
          // 0.05 at the crown: a struck rivet head is the most polished thing
          // on the plate, and it needs to be far enough below the plate's 0.26
          // that the highlight visibly BREAKS on the ornament instead of
          // washing across it.
          g.addColorStop(0, mg(0.05, 1.0))
          g.addColorStop(0.7, mg(0.12, 1.0))
          g.addColorStop(1, mg(0.40, 1.0, 0))
          m.fillStyle = g
          m.beginPath()
          m.arc(cx, y, 7.6, 0, Math.PI * 2)
          m.fill()
        })
      }
      // The channel is where dirt and water sit, so it is duller than the plate
      // by a wide margin — this is the dark end of the roughness spread.
      wrapped(m, () => {
        m.fillStyle = mg(0.66, 1.0, 0.8)
        m.fillRect(0, y - bandHalf, SIZE, bandHalf * 2)
      })
    }

    // --- geared medallions -------------------------------------------------
    // The clockwork read. Concentric turned lands and channels plus real teeth,
    // all in height, plus the concentric roughness rings a lathe leaves behind.
    const medallion = (cx, cy, R) => {
      wrapped(h, () => {
        // Body: a raised boss, so the whole medallion stands off the plate.
        // Domed rather than a flat plateau — a flat top mips down to a
        // featureless disc, which in the last capture read as a pale blister
        // on the wall rather than as a fitting.
        // Same fine sampling as dome(): four stops here put three concentric
        // slope creases across a 30 cm boss, and the normal map draws all of
        // them as rings.
        const gb = h.createRadialGradient(cx, cy, 0, cx, cy, R * 1.02)
        for (let i = 0; i <= 12; i++) {
          const t = i / 12
          // Nearly flat land out to 0.8R, then a rolled shoulder to the plate.
          const p = t < 0.8 ? 1.0 - 0.12 * (t / 0.8)
                            : 0.88 * ( 0.5 + 0.5 * Math.cos(Math.PI * (t - 0.8) / 0.2) )
          gb.addColorStop(t, hg(HEIGHT_MID + (184 - HEIGHT_MID) * p))
        }
        h.fillStyle = gb
        h.beginPath()
        h.arc(cx, cy, R * 1.02, 0, Math.PI * 2)
        h.fill()

        // Teeth: trapezoid blocks around the rim, proud of the boss. Drawn as
        // wedges rather than radial lines — a line has no width to catch light.
        const teeth = 20
        for (let t = 0; t < teeth; t++) {
          const a0 = (t / teeth) * Math.PI * 2
          const hw = (Math.PI / teeth) * 0.42
          h.fillStyle = hg(198)
          h.beginPath()
          h.moveTo(cx + Math.cos(a0 - hw) * R * 0.9, cy + Math.sin(a0 - hw) * R * 0.9)
          h.lineTo(cx + Math.cos(a0 - hw * 0.6) * (R + 9), cy + Math.sin(a0 - hw * 0.6) * (R + 9))
          h.lineTo(cx + Math.cos(a0 + hw * 0.6) * (R + 9), cy + Math.sin(a0 + hw * 0.6) * (R + 9))
          h.lineTo(cx + Math.cos(a0 + hw) * R * 0.9, cy + Math.sin(a0 + hw) * R * 0.9)
          h.closePath()
          h.fill()
        }

        // Turned channels: alternating lands and grooves cut into the boss.
        for (let k = 0; k < 5; k++) {
          const r = R * (0.80 - k * 0.145)
          h.strokeStyle = hg(k % 2 ? 84 : 212)
          h.lineWidth = R * (k % 2 ? 0.10 : 0.06)
          h.beginPath()
          h.arc(cx, cy, r, 0, Math.PI * 2)
          h.stroke()
        }
        // Hub: a proud centre with a bored hole, so the eye has a focus.
        dome(h, cx, cy, R * 0.24, 208, 176)
        h.fillStyle = hg(74)
        h.beginPath()
        h.arc(cx, cy, R * 0.085, 0, Math.PI * 2)
        h.fill()
      })

      // Lathe finish: fine concentric roughness rings on the boss itself. They
      // stop AT the rim — running them out over the plate was a mistake in the
      // first pass, because a 2R-wide ring set on a wall reads as a big soft
      // circle drawn on the surface, which is the stencil failure again.
      // Ring parameters are drawn before the replay, for the same reason
      // carvedBlock hoists its set height: nine copies must be the same rings.
      const rings = []
      for (let k = 0; k < 22; k++) {
        rings.push([R * (0.12 + k * 0.042), 0.10 + rand() * 0.26, 0.7 + rand() * 1.1])
      }
      wrapped(m, () => {
        for (const [r, rough, lw] of rings) {
          m.strokeStyle = mg(rough, 1.0, 0.8)
          m.lineWidth = lw
          m.beginPath()
          m.arc(cx, cy, r, 0, Math.PI * 2)
          m.stroke()
        }
        // The recessed channels hold grime and are markedly duller.
        for (let k = 1; k < 5; k += 2) {
          m.strokeStyle = mg(0.70, 0.9, 0.85)
          m.lineWidth = R * 0.085
          m.beginPath()
          m.arc(cx, cy, R * (0.80 - k * 0.145), 0, Math.PI * 2)
          m.stroke()
        }
        // The tooth ring is the proud edge of the whole fitting, so it is where
        // the plate gets rubbed and where the highlight should catch first.
        // 0.07 against the plate's 0.26 is a visibly different finish, which is
        // the entire point of an ornament on a metal: it breaks the specular.
        m.strokeStyle = mg(0.07, 1.0, 0.9)
        m.lineWidth = R * 0.20
        m.beginPath()
        m.arc(cx, cy, R * 0.97, 0, Math.PI * 2)
        m.stroke()
      })
    }
    medallion(SIZE * 0.5, SIZE * 0.25, 58)
    medallion(0, SIZE * 0.75, 44)
    medallion(SIZE * 0.72, SIZE * 0.70, 30)

    /**
     * --- ROUGHNESS FROM THE HEIGHT FIELD ---------------------------------
     *
     * The art director's note is that a full-screen brass wall at arm's length
     * has "no reflection gradient" — measured, a 440x180 patch of plate spanned
     * 12.4 luma of standard deviation and the rivet BAND, which is a channel
     * cut 40 code values INTO the plate, came back 6.8 luma BRIGHTER than the
     * plate it is cut into. That is not a lighting problem: every ornament was
     * given its polish by hand, so the open field between ornaments was one
     * value (0.26) over ~90% of the tile and the specular had nothing to break
     * on.
     *
     * So polish is now a function of the form. Proud metal is what hands, boots
     * and weather burnish; a recess is where the dirt film sits and never gets
     * rubbed. The mapping is the brief's numbers directly:
     *
     *   height 0.80+ (rivet crowns 0.77, gear teeth 0.78, turned lands 0.83)
     *     -> 0.18, a near-mirror that returns a narrow horizon band
     *   height 0.30- (band floors 0.35, turned grooves 0.33, hub bore 0.29)
     *     -> 0.55, satin, which smears the same band over tens of degrees
     *   the open plate at 0.50 lands at 0.44, i.e. in the recessed field's
     *     range, because relative to a rivet crown that is exactly what it is.
     *
     * Blended 60/40 with the painted channel rather than replacing it, so the
     * planishing marks, the lathe rings and the hammered-crown gradient all
     * survive as a modulation on top of the form-derived base.
     */
    {
      const hf = readHeight(h)
      modulateField(m, (px, i) => {
        // 0.30..0.80 is the working span of this tile's height field; see the
        // per-feature values quoted above.
        const formRough = 0.55 - 0.37 * smoothstep(0.30, 0.80, hf[i])
        const painted = px[1] / 255
        px[1] = Math.max(0.03, Math.min(0.95, painted * 0.40 + formRough * 0.60)) * 255
      })

      /**
       * --- CAVITY INTO ALBEDO ------------------------------------------
       *
       * "No dark recesses" was the other half of the note, and on a metal there
       * is no other way to get one: metalness is 1, so there is no diffuse term
       * at all and albedo IS the specular colour. Darkening F0 in a pocket is
       * the standard stand-in for the radiance a channel loses to its own
       * walls, and it is what puts a black line under a band shoulder and a
       * dark ring under a medallion's teeth.
       *
       * Radius 16 texels (~7.4 cm) rather than the verdigris pass's 6: a band
       * channel is 18 texels wide and a medallion undercut wider still, so at
       * radius 6 only the lips of those read as pockets and their floors read
       * as open plate. Gain 2.6 puts a full channel floor at ~1.
       *
       * Floor 0.60, i.e. the brief's "0.55-0.65 in band channels and medallion
       * undercuts". Not lower: a crevice that goes to black stops being metal.
       */
      const cavBroad = cavityField(h, 16, 2.6)
      modulateField(a, (px, i) => {
        const k = 1.0 - 0.40 * cavBroad[i]
        px[0] *= k; px[1] *= k; px[2] *= k
      })
    }

    /**
     * --- verdigris -------------------------------------------------------
     *
     * DRIVEN ENTIRELY BY THE GEOMETRY, not by an independent noise field.
     *
     * The previous version sampled the height at a random point and accepted it
     * "almost always if low, rarely if proud" — but the rarely-if-proud escape
     * hatch fired 8% of the time on a tile that is 90% proud plate, so about
     * two-fifths of the crust landed on open plate. That is what the review saw
     * in chain.png and crossing.png: soft grey-green gaussians floating in the
     * middle of flat panels, which reads as mould or compression mush.
     *
     * Copper carbonate is not a random event. It forms where water sits and
     * where water runs, so the mask here is exactly that: the cavity field of
     * the height map we just painted (rivet channels, gear-tooth roots, turned
     * grooves, the band floors) plus a downward drip smear out of each of them,
     * modulated by a coherent patchiness field so one band corrodes and the
     * next does not. There is no term in it that can put crust on a crown.
     */
    // radius 6 texels ~ 2.8 cm: the scale a band channel is a pocket AT. Gain
    // 5.5 turns the ~0.18 height drop across a channel lip into a full mask.
    const cav = cavityField(h, 6, 5.5)
    const drip = dripDown(cav, 0.972)   // ~24 texel (11 cm) e-folding run
    const patch = coherent(rand, 9)     // ~57 texel (26 cm) patches
    const grain = coherent(rand, 64)    // crust texture, ~2 cm

    /**
     * The mask is capped well under opaque. Driving it from the cavity got the
     * PLACEMENT right immediately — the crust lands in the gear-tooth roots and
     * the rivet channels and nowhere else — but at full strength that reads as
     * a green gear painted onto a gold plate, which is a different failure with
     * the same cause: the ornament stops being metal. A patina is a thin film;
     * you should still read the boss underneath it.
     */
    const CRUST_MAX = 0.40
    overlayField(a, (i, x, y) => {
      // Crust in the pocket, a weaker stain running below it.
      let k = cav[i] + drip[i] * 0.55
      // Patchiness: real corrosion is local. Below 0.40 nothing grows at all,
      // which is what keeps most of the plate and most of the ornament clean.
      k *= Math.max(0, patch(x, y) - 0.40) * 2.2
      k *= 0.55 + 0.75 * grain(x, y)
      if (k <= 0.01) return null
      // Pushed toward CYAN-green (hue ~163) rather than the grey-green it was:
      // the review's note is that it has to separate from gold instead of
      // muddying it, and this is the coolest pixel the material owns.
      return [72, 152, 132, Math.min(CRUST_MAX, k) * 255]
    })
    overlayField(m, (i, x, y) => {
      let k = cav[i] + drip[i] * 0.45
      k *= Math.max(0, patch(x, y) - 0.40) * 2.2
      if (k <= 0.01) return null
      // A DIELECTRIC crust: metalness drops and roughness climbs wherever the
      // film sits. Matte green immediately beside a bright mirror is most of
      // what makes brass read as a corroded alloy rather than as painted metal,
      // and this channel can run harder than the albedo one because a roughness
      // change does not hide the form underneath it.
      return [0, 230, 8, Math.min(0.85, k * 1.6) * 255]
    })
    // The crust stands proud of the groove it grew in. Deliberately weak: a
    // strong lift here would fill the channel back in and undo the relief the
    // mask was derived from.
    overlayField(h, (i, x, y) => {
      const k = cav[i] * Math.max(0, patch(x, y) - 0.34) * 2.4
      if (k <= 0.02) return null
      return [118, 118, 118, Math.min(150, k * 130)]
    })

    // Scuff wear along the run line: brass that gets touched gets polished.
    for (let i = 0; i < 26; i++) {
      const y = rand() * SIZE
      const x = rand() * SIZE
      const w = 40 + rand() * 150
      m.fillStyle = mg(0.09, 1.0, 0.5)
      m.fillRect(x, y, w, 1.5 + rand() * 4)
      a.fillStyle = 'rgba(255,248,222,.16)'
      a.fillRect(x, y, w, 1.5 + rand() * 4)
    }
  },

  /**
   * Moss: the landing pads. Thick, clumped, saturated — the softest and most
   * obviously safe thing in the frame, and the material that carries most of
   * the cool half of the palette.
   */
  moss(a, h, m, rand) {
    /**
     * THE BASE COLOUR IS A THIRD BRIGHTER AND A HUE-WEDGE GREENER than it was,
     * and both numbers came off a measurement rather than a preference.
     *
     * The art review sampled five points across the gaps deck and got a mean of
     * rgb(43,44,7): value 0.17, red and green EQUAL, blue essentially zero —
     * hue 62 degrees, which is khaki, not moss. The sandstone two metres below
     * it measured 0.44. Two causes, and this is the first: the old base
     * #4a7a36 has a linear green of 0.19 against sandstone's 0.63, so at equal
     * irradiance moss was arithmetically guaranteed to come back 3x darker.
     *
     * #72ac47 has a linear green of 0.40 and a hue of 95 degrees. The blue
     * channel is genuinely present (linear 0.062, up from 0.037) because the
     * sun arrives at (1.00, 0.58, 0.20) linear and crushes blue by a factor of
     * five — a base with no blue in it cannot come back green, only yellow.
     * The second cause is the lighting response, and that is the wrap term in
     * materials/shader.js.
     *
     * DOWN 5% IN VALUE from #67ad55, and that is not a reversal of the above.
     * The review's follow-up finding is that moss, not sandstone, is now the
     * brightest large surface in frame, and taste.md wants the masonry to be
     * the thing the eye lands on. 5% off the base plus the clump mask below —
     * which takes the hollows a further 18% down — moves the MEAN without
     * touching the crowns, so the deck stays legible as a landing pad.
     */
    a.fillStyle = '#62a44f'
    a.fillRect(0, 0, SIZE, SIZE)
    h.fillStyle = hg(112)
    h.fillRect(0, 0, SIZE, SIZE)
    m.fillStyle = mg(0.96, 0.0)
    m.fillRect(0, 0, SIZE, SIZE)

    // Clumps first: moss grows in mounds. The mound is now real height, so a
    // moss cap has a lit crown and a shaded flank instead of being a green
    // noise field with painted-on blotches. Crowns are the sun-tipped part of
    // the mat, so they are the yellowest and brightest thing on it.
    for (let i = 0; i < 44; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const r = 26 + rand() * 62
      dome(h, x, y, r, 150 + rand() * 52, 112)
      blob(a, x, y, r, `rgba(${(140 + rand() * 44) | 0},${(186 + rand() * 34) | 0},${(84 + rand() * 26) | 0},.42)`,
           'rgba(148,192,88,0)')
    }
    // Damp hollows between the mounds: deeper, darker, cooler, and wetter —
    // hence smoother, which is what makes a hollow catch a sky glint. Lifted
    // out of near-black: a hollow in a 6 cm mat is shaded, not a hole, and the
    // old rgba(30,58,40) was most of why the deck averaged value 0.17.
    for (let i = 0; i < 24; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const r = 18 + rand() * 44
      dome(h, x, y, r, 78, 112)
      blob(a, x, y, r, 'rgba(58,104,58,.34)', 'rgba(58,104,58,0)')
      blob(m, x, y, r * 0.8, mg(0.72, 0, 0.45), mg(0.9, 0, 0))
    }

    // Blades. Fine directional structure is what separates moss from a green
    // noise field; they go into height as well so the mat has a nap.
    for (let i = 0; i < 4200; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const len = 3 + rand() * 9
      const ang = -Math.PI / 2 + (rand() - 0.5) * 1.5
      const bright = rand()
      // Both ends of the blade spread moved up. The dark end used to bottom out
      // at rgb(34,70,38) — a near-black that 40% of 4200 strokes then smeared
      // over the mat at 34% alpha, dragging the whole deck down.
      a.strokeStyle = bright > 0.60
        ? `rgba(${(176 + rand() * 54) | 0},${(214 + rand() * 41) | 0},${(112 + rand() * 44) | 0},.44)`
        : `rgba(${(72 + rand() * 30) | 0},${(118 + rand() * 30) | 0},${(58 + rand() * 24) | 0},.32)`
      a.lineWidth = 0.8 + rand() * 1.1
      a.beginPath()
      a.moveTo(x, y)
      a.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len)
      a.stroke()

      if (i % 3 === 0) {
        h.strokeStyle = hg(HEIGHT_MID + (bright > 0.6 ? 46 : -34))
        h.lineWidth = 0.9 + rand() * 1.2
        h.globalAlpha = 0.3
        h.beginPath()
        h.moveTo(x, y)
        h.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len)
        h.stroke()
      }
    }
    h.globalAlpha = 1

    // Tiny warm flowers — the reference's orange/white specks. Few enough to
    // stay an accent; they are the warm note in the coolest material.
    for (let i = 0; i < 64; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const r = 1.2 + rand() * 2.0
      a.fillStyle = rand() < 0.6 ? 'rgba(242,150,70,.80)' : 'rgba(250,240,224,.74)'
      a.beginPath()
      a.arc(x, y, r, 0, Math.PI * 2)
      a.fill()
      dome(h, x, y, r * 2.2, 190, HEIGHT_MID)
    }

    /**
     * --- THE CLUMP MASK ---------------------------------------------------
     *
     * The finding this exists for: a 12 m moss disc is a single flat value.
     * Everything above works at 5-40 cm — clumps, hollows, blades — and every
     * one of those has mipped to its mean by the time the disc fills the lower
     * third of the frame, which is the only view of it that matters. Measured
     * on `gaps.png`, a 660x180 patch of deck sat at hue 78.2 with a luma
     * standard deviation of 17.4 on a mean of 99, and most of that 17.4 is the
     * scattered tufts and the flower specks, not the mat.
     *
     * So: a two-octave coherent field at 2 and 4 cells. Moss is the one
     * material sampling world-planar (see SURFACE.moss.worldUv), so the tile
     * field is CONTINUOUS across a whole cap rather than restarting per box —
     * 2 cells across a 2.38 m tile is a 1.19 m clump and 4 cells is 60 cm,
     * which is the review's "~1.5 m" band. The ~4 m band is the macro shader's
     * job (materials/shader.js band 1, 1-4 m) and moss's macroAlbedo is raised
     * to match.
     *
     * Value and hue move together, and that is the point: a clump is a crown
     * that gets sun and dries out, so it is brighter AND yellower; a hollow
     * holds water and shade, so it is darker AND bluer. Moving value alone is
     * what makes a mask read as a lighting artefact rather than as growth.
     *
     *   value  +/-18%   (the review's number)
     *   hue    +/-10 degrees, via R up / B down on the clumps and the reverse
     *          in the hollows. On the base 98,164,79 that is R x1.075 and
     *          B x0.91 at full clump, which walks hue 106.6 -> 96.6.
     */
    {
      const clumpA = coherent(rand, 2)   // 1.19 m
      const clumpB = coherent(rand, 4)   // 0.60 m
      modulateField(a, (px, i, x, y) => {
        // -1..1, weighted toward the coarse octave so the read is clumps
        // rather than mottle.
        const k = (clumpA(x, y) - 0.5) * 1.30 + (clumpB(x, y) - 0.5) * 0.70
        const v = 1 + 0.18 * k
        px[0] *= v * (1 + 0.075 * k)
        px[1] *= v
        px[2] *= v * (1 - 0.090 * k)
      })
      // A hollow is damp, and damp moss is smoother — this is what lets the
      // hollows catch a sky glint and the crowns stay matte, so the mask has a
      // specular consequence and not only an albedo one.
      modulateField(m, (px, i, x, y) => {
        const k = (clumpA(x, y) - 0.5) * 1.30 + (clumpB(x, y) - 0.5) * 0.70
        px[1] = Math.max(0, Math.min(255, px[1] - k * 26))
      })
    }
  },

  /**
   * Fired terracotta: roof tiles and the warm accents that edge the route.
   * Pushed further toward red than brass is toward yellow — the two used to
   * sit 18 degrees apart in hue, which is why a brass wall and a terracotta
   * balustrade were telling the player the same thing.
   */
  terracotta(a, h, m, rand) {
    /**
     * SANDY PEACH AND OCHRE, not a hazard stripe.
     *
     * The previous pass took this to hue 14 at 0.80 saturation on the argument
     * that terracotta's job is to be unmistakably RED-orange against brass's
     * gold. The separation worked and the colour did not: measured on the
     * underpass slab it delivers hue 17.4 at saturation 0.81 — a safety cone,
     * and it is the whole mid-mass of that frame plus the rim of every island.
     * docs/art-direction.md asks for "sandy peach and ochre".
     *
     * 0xc0764e is hue 22.6 at saturation 0.59: still the reddest thing in the
     * palette and still ~17 degrees off brass, so the reserved-accent contract
     * (level.js: terracotta means the route acts here) is intact. What it gives
     * up is the shout, and the shout is what made every island a three-layer
     * cake of green plate, red stripe, grey block.
     */
    a.fillStyle = '#c0764e'
    a.fillRect(0, 0, SIZE, SIZE)
    h.fillStyle = hg(84)
    h.fillRect(0, 0, SIZE, SIZE)
    m.fillStyle = mg(0.84, 0.0)
    m.fillRect(0, 0, SIZE, SIZE)

    const tile = SIZE / 4
    const gap = 3.5
    for (let ty = 0; ty < 4; ty++) {
      for (let tx = -1; tx <= 4; tx++) {
        // Half-lap per row, wrapped: the same running bond the masonry uses.
        const ox = (ty % 2) * tile * 0.5
        const v = 0.84 + rand() * 0.34
        // Hoisted out of the wrapped() replays below for the same reason
        // carvedBlock hoists its set height — nine copies, one tile.
        const rough = 0.62 + rand() * 0.28
        const x = tx * tile + ox + gap
        const y = ty * tile + gap
        const w = tile - gap * 2
        const hh = tile - gap * 2
        wrapped(a, () => {
          // Per-tile colour, tracking the new base: a fired batch varies in
          // value, and the darker units of a peach batch are ochre rather than
          // a deeper red.
          a.fillStyle = `rgb(${(188 * v) | 0},${(117 * v) | 0},${(78 * v) | 0})`
          a.fillRect(x, y, w, hh)
        })
        wrapped(h, () => {
          // Fired tiles are domed: a crown down the middle falling to the lap.
          const g = h.createLinearGradient(0, y, 0, y + hh)
          g.addColorStop(0, hg(146))
          g.addColorStop(0.42, hg(186))
          g.addColorStop(1, hg(116))
          h.fillStyle = g
          h.fillRect(x, y, w, hh)
          // Edge roll-off so the lap between tiles is a real step.
          const gx = h.createLinearGradient(x, 0, x + gap * 2, 0)
          gx.addColorStop(0, hg(84))
          gx.addColorStop(1, hg(160))
          h.fillStyle = gx
          h.fillRect(x, y, gap * 2, hh)
        })
        wrapped(m, () => {
          m.fillStyle = mg(rough, 0.0)
          m.fillRect(x, y, w, hh)
        })
      }
    }
    // The lap shadow line, as MATERIAL not as a painted shadow: the gap is
    // where damp sits, so it goes cool-green and matte.
    wrapped(a, () => {
      a.fillStyle = 'rgba(96,104,86,0.5)'
      for (let ty = 0; ty < 4; ty++) {
        const ox = (ty % 2) * tile * 0.5
        a.fillRect(0, ty * tile - gap, SIZE, gap * 2)
        for (let tx = -1; tx <= 4; tx++) a.fillRect(tx * tile + ox - gap, ty * tile, gap * 2, tile)
      }
    })

    // The dark speckle tracks the base too: at hue 14 it was a deeper red and
    // read as soot on a hazard stripe. 0x683e26 is the same ochre, three stops
    // down, which is what an under-fired patch on a peach tile looks like.
    speckle(a, rand, 1600, ['rgba(104,62,38,.15)', 'rgba(255,204,166,.16)'], 0.6, 2.6)
    // Lichen crusting on a few tiles: the cool accent on the warmest material.
    for (let i = 0; i < 11; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const r = 18 + rand() * 40
      blob(a, x, y, r, 'rgba(150,160,110,.30)', 'rgba(150,160,110,0)')
      blob(m, x, y, r, mg(0.96, 0, 0.6), mg(0.9, 0, 0))
      dome(h, x, y, r * 0.6, HEIGHT_MID + 10, HEIGHT_MID)
    }
  },

  /**
   * The boulder rock the islands are made of. Cooler and GREENER than the built
   * stone above it: this is the one material in the set allowed to be a cool
   * grey, and it is what stops the frame being a single orange wedge when a
   * whole island underside fills the lower third.
   */
  stone(a, h, m, rand) {
    /**
     * OFF THE YELLOW-GREEN POLE. 0x8e968b was hue 96 at saturation 0.073, and
     * hue 96 is the olive corner: the grade multiplies saturation by 1.30 and
     * adds green to the shadow term, so every push this material receives is a
     * push further into olive. `level.js` also paves with it — `BUILT`/`WILD`
     * both pass `kind: 'stone'` for the drum body and the scenery islands take
     * it for their rims — and an olive walking deck under a peach balustrade is
     * the review's "the floor is green" in one sentence.
     *
     * 0x8c9492 is hue 165 at saturation 0.054: the same value, a third less
     * saturation, and rotated to the CYAN side of green where "cool damp rock"
     * lives and "olive" does not. It is still the one genuinely cool material
     * in the set and still the counterweight to the warm masonry — it just
     * cannot be amplified into a substance colour any more.
     *
     * The other half of the fix is in shader.js: up-facing stone takes the
     * golden-hour sky's warm bias at nearly full strength, so a stone DECK
     * reads sandy while a stone UNDERSIDE stays cool grey. The roadmap's
     * preferred fix — stop paving with this kind at all — is a `level.js`
     * change and is not in this lane.
     */
    a.fillStyle = '#8c9492'
    a.fillRect(0, 0, SIZE, SIZE)
    h.fillStyle = hg(HEIGHT_MID)
    h.fillRect(0, 0, SIZE, SIZE)
    m.fillStyle = mg(0.92, 0.0)
    m.fillRect(0, 0, SIZE, SIZE)

    // Rounded cobbles rather than a fracture pattern: this rock is weathered,
    // not quarried. Real domes now, so the crown lights and the skirt shades
    // without either being drawn on.
    for (let i = 0; i < 46; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const r = 22 + rand() * 58
      dome(h, x, y, r, 168 + rand() * 40, HEIGHT_MID)
      // Cobble crowns track the base's rotation to hue ~165; leaving them at
      // hue 95 would put the olive straight back on the proud faces, which are
      // the ones the frame actually sees.
      blob(a, x, y, r,
           `rgba(${(152 + rand() * 26) | 0},${(160 + rand() * 22) | 0},${(158 + rand() * 22) | 0},.24)`,
           'rgba(152,160,158,0)')
    }
    // Crevices between them: deep, cool, damp.
    for (let i = 0; i < 26; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const r = 10 + rand() * 24
      dome(h, x, y, r, 74, HEIGHT_MID)
      blob(a, x, y, r, 'rgba(62,74,64,.28)', 'rgba(62,74,64,0)')
    }
    speckle(a, rand, 3200, ['rgba(112,120,118,.18)', 'rgba(194,202,200,.22)', 'rgba(62,72,70,.12)'], 1, 5)
    // Mineral streaking down the faces, cool and grey-green.
    for (let i = 0; i < 22; i++) {
      a.strokeStyle = 'rgba(72,84,72,.16)'
      a.lineWidth = 1.4 + rand() * 3.0
      a.beginPath()
      const x = rand() * SIZE
      a.moveTo(x, 0)
      a.bezierCurveTo(x + 20, SIZE * 0.33, x - 20, SIZE * 0.66, x + (rand() - 0.5) * 30, SIZE)
      a.stroke()
    }
  },
}

// ------------------------------------------------------- height -> normal

/**
 * Separable box blur with wrap, used to build the cavity signal.
 *
 * Cavity is local height minus regional height, not height itself: on a wall
 * built of blocks the whole lower course might sit shy of the upper one, and
 * treating "low" as "occluded" would shade an entire course as if it were a
 * crack. What we want is the crack.
 */
function boxBlurWrap(src, dst, size, radius) {
  const inv = 1 / (radius * 2 + 1)
  const tmp = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    let sum = 0
    for (let k = -radius; k <= radius; k++) sum += src[y * size + ((k % size) + size) % size]
    for (let x = 0; x < size; x++) {
      tmp[y * size + x] = sum * inv
      const out = src[y * size + ((x - radius) % size + size) % size]
      const add = src[y * size + ((x + radius + 1) % size + size) % size]
      sum += add - out
    }
  }
  for (let x = 0; x < size; x++) {
    let sum = 0
    for (let k = -radius; k <= radius; k++) sum += tmp[(((k % size) + size) % size) * size + x]
    for (let y = 0; y < size; y++) {
      dst[y * size + x] = sum * inv
      const out = tmp[((((y - radius) % size) + size) % size) * size + x]
      const add = tmp[((((y + radius + 1) % size) + size) % size) * size + x]
      sum += add - out
    }
  }
}

/**
 * Differentiate the height field into a tangent-space normal map, and pack the
 * cavity into alpha.
 *
 * `depth` is metres of relief across the full 0..1 height range. Everything is
 * expressed that way rather than as an opaque gain, so "the rivet stands 6 mm
 * proud" is a statement you can check against the geometry rather than a number
 * someone tuned until it looked all right.
 *
 * The gradient is a 3x3 Sobel, not a two-tap difference: a two-tap on an 8-bit
 * height field returns the quantisation as much as the slope, and the result is
 * a normal map that sparkles under a moving highlight.
 */
function normalFromHeight(hctx, depth, cavityRadius, cavityGain) {
  const src = hctx.getImageData(0, 0, SIZE, SIZE).data
  const hf = new Float32Array(SIZE * SIZE)
  for (let i = 0; i < SIZE * SIZE; i++) hf[i] = src[i * 4] / 255

  const blurred = new Float32Array(SIZE * SIZE)
  boxBlurWrap(hf, blurred, SIZE, cavityRadius)

  // Metres per texel: the tile spans 1/0.42 m and is SIZE texels across.
  const METRES_PER_TEXEL = (1 / 0.42) / SIZE
  const gain = depth / METRES_PER_TEXEL

  const out = new Uint8Array(SIZE * SIZE * 4)
  const at = (x, y) => hf[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)]

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1)
      const l = at(x - 1, y), r = at(x + 1, y)
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1)
      // Sobel / 8 -> the average slope per texel.
      const dx = ((tr + 2 * r + br) - (tl + 2 * l + bl)) * 0.125 * gain
      const dy = ((bl + 2 * b + br) - (tl + 2 * t + tr)) * 0.125 * gain
      // Canvas y runs DOWN and texture v runs UP, so the v slope is negated to
      // land on three's OpenGL-style (green-up) tangent-space convention.
      let nx = -dx, ny = dy, nz = 1
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1)
      nx *= inv; ny *= inv; nz *= inv

      const i = (y * SIZE + x) * 4
      out[i] = Math.round((nx * 0.5 + 0.5) * 255)
      out[i + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      out[i + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      // Cavity: 1 = proud or flat, 0 = deep in a pocket. Only the negative side
      // is kept — a proud edge is not an occluder of itself.
      const c = 1 + Math.min(0, hf[y * SIZE + x] - blurred[y * SIZE + x]) * cavityGain
      out[i + 3] = Math.round(Math.max(0, Math.min(1, c)) * 255)
    }
  }
  return out
}

// ------------------------------------------------------------------ public

function tex(source, { srgb = false, data = false } = {}) {
  const t = data
    ? new THREE.DataTexture(source, SIZE, SIZE, THREE.RGBAFormat)
    : new THREE.CanvasTexture(source)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = 8
  if (data) {
    t.magFilter = THREE.LinearFilter
    t.minFilter = THREE.LinearMipmapLinearFilter
    t.generateMipmaps = true
    t.needsUpdate = true
  }
  return t
}

/**
 * Paint one material kind and return its texture set.
 *
 * @param {string} kind
 * @param {number} depth  metres of relief across the full height range
 * @param {number} cavityRadius  texels; the scale a pocket is measured against
 * @param {number} cavityGain
 */
export function surfaceTextures(kind, { depth, cavityRadius = 10, cavityGain = 3.0 }) {
  const painter = PAINTERS[kind]
  if (!painter) throw new Error(`unknown surface kind: ${kind}`)

  const [ac, a] = canvas2d()
  const [hc, h] = canvas2d()
  const [mc, m] = canvas2d()
  painter(a, h, m, rng(hash(kind)))

  const normal = normalFromHeight(h, depth, cavityRadius, cavityGain)

  return {
    map: tex(ac, { srgb: true }),
    normalMap: tex(normal, { data: true }),
    // One texture serving roughness (G) and metalness (B), which is the channel
    // layout three already reads them from — so this costs one sampler, not two.
    ormMap: tex(mc),
  }
}

export function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
