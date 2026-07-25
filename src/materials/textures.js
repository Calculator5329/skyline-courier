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
  wrapped(h, () => {
    // Per-block set height: hand-cut stone is not shimmed to a common plane,
    // and a +/-3% proud/shy variation is the cheapest thing that stops a wall
    // from reading as one poured slab with lines scored into it.
    const top = 168 + (rand() - 0.5) * 22
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
 * COURSES must stay even: the half-block offset alternates per course, so an
 * odd count puts two identically-aligned courses next to each other across the
 * vertical wrap and the running bond visibly breaks once per tile.
 */
const COURSES = 4              // 4 courses over 2.38 m -> ~0.6 m course height
const BLOCKS_PER_COURSE = 3    // ~0.79 m blocks: cut stone, not brickwork

const PAINTERS = {
  /**
   * Warm carved sandstone: the ashlar the whole archipelago is built from.
   * Warm proud faces, COOL green-grey joints. That contrast is the smallest
   * unit of the warm-key/cool-shadow split and it costs nothing.
   */
  porcelain(a, h, m, rand) {
    a.fillStyle = '#e7d3ac'
    a.fillRect(0, 0, SIZE, SIZE)
    // Joints are painted first and left exposed by the block faces on top: a
    // recess sees sky, not sun, so it is COOLER and greener than the face.
    // This is the cheapest correct source of cool in the whole frame.
    m.fillStyle = mg(0.88, 0.0)
    m.fillRect(0, 0, SIZE, SIZE)
    h.fillStyle = hg(96)
    h.fillRect(0, 0, SIZE, SIZE)

    const ch = SIZE / COURSES
    const bw = SIZE / BLOCKS_PER_COURSE
    const joint = 4.5   // ~21 mm mortar channel
    const bevel = 7     // ~32 mm arris chamfer: a hand-cut stone, not a CNC edge

    for (let r = 0; r < COURSES; r++) {
      const offset = (r % 2) * bw * 0.5
      for (let b = -1; b <= BLOCKS_PER_COURSE; b++) {
        const x = b * bw + offset
        const y = r * ch
        carvedBlock(h, x, y, bw, ch, rand, joint, bevel)

        // Albedo: face colour only. Value jitter tracks the same idea as the
        // height jitter — different stones out of a different part of the bed.
        const v = 0.92 + rand() * 0.15
        wrapped(a, () => {
          a.fillStyle = `rgb(${(231 * v) | 0},${(211 * v) | 0},${(172 * v) | 0})`
          a.fillRect(x + joint, y + joint, bw - joint * 2, ch - joint * 2)
        })
        wrapped(m, () => {
          // A dressed face is smoother than a mortar joint, and blocks vary.
          m.fillStyle = mg(0.62 + rand() * 0.16, 0.0)
          m.fillRect(x + joint, y + joint, bw - joint * 2, ch - joint * 2)
        })
      }
    }

    // The cool joint colour, laid back over the exposed channel.
    wrapped(a, () => {
      a.fillStyle = 'rgba(126,134,118,0.62)'
      for (let r = 0; r < COURSES; r++) {
        const offset = (r % 2) * bw * 0.5
        a.fillRect(0, r * ch - joint, SIZE, joint * 2)
        for (let b = -1; b <= BLOCKS_PER_COURSE; b++) {
          a.fillRect(b * bw + offset - joint, r * ch, joint * 2, ch)
        }
      }
    })

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
      blob(a, x, y, r, 'rgba(112,130,96,.30)', 'rgba(112,130,96,0)')
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
    // and a terracotta balustrade at the same hue. So the blue channel is
    // pulled well down (linear ~0.94, 0.80, 0.25): a genuinely yellow-gold
    // tint that bends an orange sky toward gold instead of passing it through.
    a.fillStyle = '#f8e88c'
    a.fillRect(0, 0, SIZE, SIZE)
    h.fillStyle = hg(HEIGHT_MID)
    h.fillRect(0, 0, SIZE, SIZE)
    // 0.14: polished, not mirror. Low enough that the reflection still carries
    // the horizon line between bright cloud deck and cool zenith, which is the
    // structure that makes a surface read as reflective at all.
    m.fillStyle = mg(0.14, 1.0)
    m.fillRect(0, 0, SIZE, SIZE)

    // --- planishing ------------------------------------------------------
    // Fine marks ACROSS the plate, in roughness only. Horizontal because the
    // bands and the run direction are horizontal, and because anisotropy along
    // the direction of travel is what makes a wall-run surface read as one
    // continuous machined run rather than as stacked planks.
    for (let i = 0; i < 520; i++) {
      const y = rand() * SIZE
      const t = 0.4 + rand() * 2.0
      m.fillStyle = mg(0.14 + (rand() - 0.5) * 0.16, 1.0, 0.55)
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
          g.addColorStop(0, mg(0.11, 1.0))
          g.addColorStop(0.7, mg(0.17, 1.0))
          g.addColorStop(1, mg(0.40, 1.0, 0))
          m.fillStyle = g
          m.beginPath()
          m.arc(cx, y, 7.6, 0, Math.PI * 2)
          m.fill()
        })
      }
      // The channel is where dirt and water sit, so it is duller than the plate.
      wrapped(m, () => {
        m.fillStyle = mg(0.52, 1.0, 0.72)
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
      wrapped(m, () => {
        for (let k = 0; k < 22; k++) {
          const r = R * (0.12 + k * 0.042)
          m.strokeStyle = mg(0.14 + (rand() - 0.5) * 0.14, 1.0, 0.5)
          m.lineWidth = 0.7 + rand() * 1.1
          m.beginPath()
          m.arc(cx, cy, r, 0, Math.PI * 2)
          m.stroke()
        }
        // The recessed channels hold grime and are markedly duller.
        for (let k = 1; k < 5; k += 2) {
          m.strokeStyle = mg(0.58, 0.9, 0.8)
          m.lineWidth = R * 0.085
          m.beginPath()
          m.arc(cx, cy, R * (0.80 - k * 0.145), 0, Math.PI * 2)
          m.stroke()
        }
      })
    }
    medallion(SIZE * 0.5, SIZE * 0.25, 58)
    medallion(0, SIZE * 0.75, 44)
    medallion(SIZE * 0.72, SIZE * 0.70, 30)

    // --- verdigris ---------------------------------------------------------
    // Read the height field back and bias the corrosion into the LOW ground:
    // copper salts form where water sits, and water sits in channels and around
    // rivets. Guessing at coordinates put it on proud faces before.
    const hpx = h.getImageData(0, 0, SIZE, SIZE).data
    let placed = 0
    let guard = 0
    while (placed < 20 && guard++ < 4000) {
      const x = (rand() * SIZE) | 0
      const y = (rand() * SIZE) | 0
      const hv = hpx[(y * SIZE + x) * 4]
      // Accept low ground almost always, mid ground rarely, proud never.
      if (hv > 116 && rand() > 0.08) continue
      placed++
      // Small and tight. Big soft green blobs on a metal wall read as mould,
      // not as corrosion: real verdigris is a crust that follows a seam.
      const r = 5 + rand() * 14
      // A genuinely cool blue-green — the coolest pixel we own.
      blob(a, x, y, r, 'rgba(98,148,128,.70)', 'rgba(98,148,128,0)')
      // ...and it is a DIELECTRIC crust. Dropping metalness here is what gives
      // brass its material contrast: bright mirror next to dead matte green.
      blob(m, x, y, r * 0.86, mg(0.88, 0.04, 0.9), mg(0.5, 0.6, 0))
      // Crusty, so it also stands slightly proud.
      dome(h, x, y, r * 0.7, HEIGHT_MID + 14, HEIGHT_MID)
    }
    speckle(a, rand, 420, ['rgba(96,142,124,.16)', 'rgba(60,44,18,.10)'], 0.8, 3)

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
    a.fillStyle = '#4a7a36'
    a.fillRect(0, 0, SIZE, SIZE)
    h.fillStyle = hg(112)
    h.fillRect(0, 0, SIZE, SIZE)
    m.fillStyle = mg(0.96, 0.0)
    m.fillRect(0, 0, SIZE, SIZE)

    // Clumps first: moss grows in mounds. The mound is now real height, so a
    // moss cap has a lit crown and a shaded flank instead of being a green
    // noise field with painted-on blotches.
    for (let i = 0; i < 44; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const r = 26 + rand() * 62
      dome(h, x, y, r, 150 + rand() * 52, 112)
      blob(a, x, y, r, `rgba(${(112 + rand() * 44) | 0},${(158 + rand() * 34) | 0},${(66 + rand() * 22) | 0},.40)`,
           'rgba(118,160,70,0)')
    }
    // Damp hollows between the mounds: deeper, darker, cooler, and wetter —
    // hence smoother, which is what makes a hollow catch a sky glint.
    for (let i = 0; i < 24; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const r = 18 + rand() * 44
      dome(h, x, y, r, 78, 112)
      blob(a, x, y, r, 'rgba(30,58,40,.36)', 'rgba(30,58,40,0)')
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
      a.strokeStyle = bright > 0.60
        ? `rgba(${(146 + rand() * 54) | 0},${(188 + rand() * 44) | 0},${(92 + rand() * 40) | 0},.42)`
        : `rgba(${(34 + rand() * 28) | 0},${(70 + rand() * 26) | 0},${(38 + rand() * 20) | 0},.34)`
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
  },

  /**
   * Fired terracotta: roof tiles and the warm accents that edge the route.
   * Pushed further toward red than brass is toward yellow — the two used to
   * sit 18 degrees apart in hue, which is why a brass wall and a terracotta
   * balustrade were telling the player the same thing.
   */
  terracotta(a, h, m, rand) {
    a.fillStyle = '#c4552f'
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
        const v = 0.9 + rand() * 0.22
        const x = tx * tile + ox + gap
        const y = ty * tile + gap
        const w = tile - gap * 2
        const hh = tile - gap * 2
        wrapped(a, () => {
          a.fillStyle = `rgb(${(196 * v) | 0},${(85 * v) | 0},${(47 * v) | 0})`
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
          m.fillStyle = mg(0.70 + rand() * 0.2, 0.0)
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

    speckle(a, rand, 1600, ['rgba(92,40,22,.15)', 'rgba(255,196,152,.16)'], 0.6, 2.6)
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
    a.fillStyle = '#8f9280'
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
      blob(a, x, y, r,
           `rgba(${(160 + rand() * 30) | 0},${(162 + rand() * 26) | 0},${(140 + rand() * 22) | 0},.24)`,
           'rgba(160,162,140,0)')
    }
    // Crevices between them: deep, cool, damp.
    for (let i = 0; i < 26; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const r = 10 + rand() * 24
      dome(h, x, y, r, 74, HEIGHT_MID)
      blob(a, x, y, r, 'rgba(62,74,64,.28)', 'rgba(62,74,64,0)')
    }
    speckle(a, rand, 3200, ['rgba(118,122,106,.18)', 'rgba(202,204,182,.22)', 'rgba(64,70,60,.12)'], 1, 5)
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
