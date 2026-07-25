import * as THREE from 'three'
import { extendSurfaceMaterial, setGroundLevels } from './materials/shader.js'

/**
 * Every surface in the game is generated here. No image files, ever.
 *
 * The world is a clockwork sky-garden archipelago floating over a sea of golden
 * sunset cloud: warm carved sandstone, ornate machined brass, lush saturated
 * moss, and cooler grey boulder rock underneath the islands. Polished stylised
 * film, not photoreal and never grey.
 *
 * Two layers do the work, and they answer two different failures:
 *
 *   A. THE TILE (this file). Canvas textures painted at load, carrying detail
 *      below ~2 m: carved ashlar courses and their bevels, machined brass bands
 *      and rivets, moss blades and clumps. This is what you read standing on a
 *      surface.
 *   B. THE MACRO LAYER (materials/shader.js). Everything ABOVE the size of a
 *      tile — relief that tilts the shading normal so flat slabs catch the sun
 *      in ridges, two bands of albedo/roughness drift, moss creeping out of
 *      every wall/floor junction, sun-bleach on upward faces, and stochastic
 *      de-tiling. This is what stops a 32 m wall reading as thirteen copies of
 *      the same 2.4 m, which is the actual "engine primitive" tell.
 *
 * Plus, from level.js: world-consistent texel density (0.42 repeats/metre), and
 * per-box tint jitter with baked contact shading in the vertex colours. This
 * file never touches those channels.
 */

export const PALETTE = {
  // Warm carved sandstone. The neutral ground you run along — sandy/peach, and
  // deliberately NOT a pale cream: at golden hour a cream surface goes white.
  porcelain: 0xe8d5b0,
  // The signature material. Golden, machined, ornate.
  brass: 0xd4a244,
  // Lush and saturated. Vegetation is a major element here, not an accent.
  moss: 0x4f7a33,
  // Rich fired orange for roof tiles and warm accents.
  terracotta: 0xcf6a34,
  // The boulder rock under the islands: warm-grey, cooler than the built stone.
  stone: 0x9a8f7d,
  // Golden-hour haze rather than a clear blue zenith.
  sky: 0xe9b57a,
  ink: 0x2b2622,
}

/** Deterministic RNG — the world must look the same every reload. */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

const SIZE = 256

function canvas2d() {
  const c = document.createElement('canvas')
  c.width = c.height = SIZE
  return [c, c.getContext('2d')]
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
 * Draw something nine times, once per wrap offset.
 *
 * Anything drawn near an edge — a blob, a rivet, a boulder — would otherwise be
 * cut in half at the tile seam, and a cut-in-half feature repeated across a wall
 * is a ruled line pointing at the tiling. Everything soft goes through here.
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
 * One carved ashlar block: a recessed mortar joint plus a bevelled arris,
 * lit from above. The bevel is the whole point — a cut stone reads as cut
 * because its edges catch light differently from its face, and a flat rect
 * with a dark border around it reads as a drawn grid instead.
 */
function ashlar(ctx, x, y, w, h, rand, bevel, face, lightEdge, darkEdge, mortar) {
  wrapped(ctx, () => {
    // Per-block value jitter: the single cheapest thing that stops a wall from
    // reading as one poured surface with lines drawn on it.
    const v = 0.90 + rand() * 0.20
    ctx.fillStyle = face(v)
    ctx.fillRect(x, y, w, h)

    // Mortar recess around the block, drawn inside its own footprint so joints
    // between neighbours read as one shared channel.
    ctx.fillStyle = mortar
    ctx.fillRect(x, y, w, bevel * 0.9)
    ctx.fillRect(x, y, bevel * 0.9, h)

    // Bevel: sun on the top and left arris, shade on the bottom and right.
    ctx.fillStyle = lightEdge
    ctx.fillRect(x + bevel, y + bevel, w - bevel * 2, bevel)
    ctx.fillRect(x + bevel, y + bevel, bevel, h - bevel * 2)
    ctx.fillStyle = darkEdge
    ctx.fillRect(x + bevel, y + h - bevel * 2, w - bevel * 2, bevel)
    ctx.fillRect(x + w - bevel * 2, y + bevel, bevel, h - bevel * 2)
  })
}

/**
 * A course of running-bond masonry.
 *
 * COURSES must stay even: the half-block offset alternates per course, so an
 * odd count puts two identically-aligned courses next to each other across the
 * vertical wrap and the bond visibly breaks once per tile.
 */
const COURSES = 4              // 4 courses over 2.38 m -> ~0.6 m course height
const BLOCKS_PER_COURSE = 3    // ~0.79 m blocks: cut stone, not brickwork

function masonry(ctx, rand, opts) {
  const ch = SIZE / COURSES
  const bw = SIZE / BLOCKS_PER_COURSE
  for (let r = 0; r < COURSES; r++) {
    const offset = (r % 2) * bw * 0.5
    for (let b = -1; b <= BLOCKS_PER_COURSE; b++) {
      ashlar(ctx, b * bw + offset, r * ch, bw, ch, rand,
             opts.bevel, opts.face, opts.light, opts.dark, opts.mortar)
    }
  }
}

const PAINTERS = {
  // Warm carved sandstone: the ashlar the whole archipelago is built from.
  porcelain(ctx, rand) {
    ctx.fillStyle = '#e8d5b0'
    ctx.fillRect(0, 0, SIZE, SIZE)
    masonry(ctx, rand, {
      bevel: 2.4,
      // Value jitter applied as a warm sandstone ramp rather than a grey one,
      // so a darker block goes ochre instead of going muddy.
      face: (v) => `rgb(${(232 * v) | 0},${(213 * v) | 0},${(176 * v) | 0})`,
      light: 'rgba(255,244,214,.55)',
      dark: 'rgba(140,108,72,.34)',
      mortar: 'rgba(150,120,84,.45)',
    })
    // Weathering across the joints, so the courses are not pristine CAD.
    speckle(ctx, rand, 1500, ['rgba(176,142,96,.13)', 'rgba(255,246,220,.30)', 'rgba(122,96,64,.08)'], 0.5, 2.2)
    // Damp/lichen pooling in a few blocks. Wrapped blobs, so no seam.
    for (let i = 0; i < 7; i++) {
      blob(ctx, rand() * SIZE, rand() * SIZE, 24 + rand() * 40,
           'rgba(126,140,84,.20)', 'rgba(126,140,84,0)')
    }
  },

  /**
   * Aged brass: the signature material, and the one that says "you can
   * wall-run on me". Ornate machined metal — fine turned grain, studded bands,
   * a geared medallion, and verdigris collecting in the recesses.
   */
  brass(ctx, rand) {
    ctx.fillStyle = '#d4a244'
    ctx.fillRect(0, 0, SIZE, SIZE)

    // Fine turned grain. On a wall these run vertically, along the axis the
    // player is meant to read as climbable.
    for (let i = 0; i < 460; i++) {
      const x = rand() * SIZE
      const w = 0.5 + rand() * 2.4
      const light = rand() > 0.5
      ctx.fillStyle = light ? `rgba(255,232,168,${0.05 + rand() * 0.18})`
                            : `rgba(128,86,26,${0.05 + rand() * 0.18})`
      ctx.fillRect(x, 0, w, SIZE)
    }

    // Machined bands: a recessed groove with a bright arris either side, and a
    // row of rivets along it. Bands sit at 0 and SIZE/2 so they wrap exactly.
    const rivetPitch = SIZE / 16
    for (const y of [0, SIZE / 2, SIZE]) {
      ctx.fillStyle = 'rgba(84,54,18,.50)'
      ctx.fillRect(0, y - 4, SIZE, 8)
      ctx.fillStyle = 'rgba(255,236,182,.34)'
      ctx.fillRect(0, y - 5.5, SIZE, 1.5)
      ctx.fillRect(0, y + 4, SIZE, 1.5)
      for (let i = 0; i < 16; i++) {
        const cx = (i + 0.5) * rivetPitch
        wrapped(ctx, () => {
          const g = ctx.createRadialGradient(cx - 1, y - 1, 0.5, cx, y, 3.6)
          g.addColorStop(0, 'rgba(255,240,196,.95)')
          g.addColorStop(0.6, 'rgba(214,162,72,.9)')
          g.addColorStop(1, 'rgba(96,62,20,.85)')
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(cx, y, 3.6, 0, Math.PI * 2)
          ctx.fill()
        })
      }
    }

    // Geared medallions between the bands: concentric turned rings plus teeth.
    // This is the clockwork read, and it is what makes brass ornate rather than
    // just gold-coloured.
    const medallion = (cx, cy, R) => {
      wrapped(ctx, () => {
        for (let k = 0; k < 5; k++) {
          const r = R * (1 - k * 0.17)
          ctx.strokeStyle = k % 2 ? 'rgba(255,238,190,.30)' : 'rgba(92,58,18,.36)'
          ctx.lineWidth = 1.4 + (k % 2) * 1.2
          ctx.beginPath()
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.stroke()
        }
        // Teeth: short radial spokes on the outer ring.
        const teeth = 18
        for (let t = 0; t < teeth; t++) {
          const a = (t / teeth) * Math.PI * 2
          ctx.strokeStyle = 'rgba(88,56,18,.34)'
          ctx.lineWidth = 2.2
          ctx.beginPath()
          ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R)
          ctx.lineTo(cx + Math.cos(a) * (R + 5), cy + Math.sin(a) * (R + 5))
          ctx.stroke()
        }
      })
    }
    medallion(SIZE * 0.5, SIZE * 0.25, 40)
    medallion(0, SIZE * 0.75, 26)

    // Verdigris, biased into the recesses: the band grooves and the medallion
    // rings. Copper salts collect where water sits, never on a proud face.
    for (let i = 0; i < 22; i++) {
      const y = rand() < 0.6
        ? (rand() < 0.5 ? 0 : SIZE / 2) + (rand() - 0.5) * 14   // in the grooves
        : rand() * SIZE
      blob(ctx, rand() * SIZE, y, 6 + rand() * 16,
           'rgba(96,138,104,.34)', 'rgba(96,138,104,0)')
    }
    speckle(ctx, rand, 240, ['rgba(78,116,88,.16)'], 1, 4)
  },

  // Moss: the landing pads. Thick, clumped, saturated — the softest and most
  // obviously safe thing in the frame.
  moss(ctx, rand) {
    ctx.fillStyle = '#4f7a33'
    ctx.fillRect(0, 0, SIZE, SIZE)

    // Clumps first: moss grows in mounds, and a uniform speckle over a flat
    // green is exactly the "spray-painted primitive" read we are killing.
    for (let i = 0; i < 26; i++) {
      blob(ctx, rand() * SIZE, rand() * SIZE, 14 + rand() * 34,
           `rgba(${(118 + rand() * 40) | 0},${(160 + rand() * 30) | 0},70,.42)`,
           'rgba(118,160,70,0)')
    }
    for (let i = 0; i < 16; i++) {
      blob(ctx, rand() * SIZE, rand() * SIZE, 10 + rand() * 26,
           'rgba(36,62,26,.34)', 'rgba(36,62,26,0)')
    }

    // Blades: short strokes, mostly upright with scatter. Fine directional
    // structure is what separates moss from a green noise field.
    for (let i = 0; i < 2200; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const len = 2 + rand() * 5
      const a = -Math.PI / 2 + (rand() - 0.5) * 1.5
      const bright = rand()
      ctx.strokeStyle = bright > 0.62
        ? `rgba(${(150 + rand() * 50) | 0},${(190 + rand() * 40) | 0},${(96 + rand() * 40) | 0},.42)`
        : `rgba(${(40 + rand() * 30) | 0},${(74 + rand() * 26) | 0},${(34 + rand() * 20) | 0},.34)`
      ctx.lineWidth = 0.8 + rand() * 0.9
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len)
      ctx.stroke()
    }

    // A scatter of tiny warm flowers — the reference's orange/white specks. Few
    // enough to stay an accent; they are the warm note in the coolest material.
    for (let i = 0; i < 34; i++) {
      ctx.fillStyle = rand() < 0.6 ? 'rgba(238,146,72,.75)' : 'rgba(248,238,222,.7)'
      ctx.beginPath()
      ctx.arc(rand() * SIZE, rand() * SIZE, 0.9 + rand() * 1.3, 0, Math.PI * 2)
      ctx.fill()
    }
  },

  // Fired terracotta: roof tiles and the warm accents that edge the route.
  terracotta(ctx, rand) {
    ctx.fillStyle = '#cf6a34'
    ctx.fillRect(0, 0, SIZE, SIZE)
    const tile = SIZE / 4
    for (let ty = 0; ty < 4; ty++) {
      for (let tx = -1; tx <= 4; tx++) {
        // Half-lap per row, wrapped: the same running bond the masonry uses.
        const ox = (ty % 2) * tile * 0.5
        const v = 0.9 + rand() * 0.22
        wrapped(ctx, () => {
          const x = tx * tile + ox + 1.5
          const y = ty * tile + 1.5
          const w = tile - 3
          const h = tile - 3
          ctx.fillStyle = `rgb(${(207 * v) | 0},${(106 * v) | 0},${(52 * v) | 0})`
          ctx.fillRect(x, y, w, h)
          // Fired tiles are slightly domed: bright along the top, shaded below.
          const g = ctx.createLinearGradient(0, y, 0, y + h)
          g.addColorStop(0, 'rgba(255,206,152,.34)')
          g.addColorStop(0.45, 'rgba(255,180,120,.05)')
          g.addColorStop(1, 'rgba(96,38,20,.32)')
          ctx.fillStyle = g
          ctx.fillRect(x, y, w, h)
        })
      }
    }
    speckle(ctx, rand, 900, ['rgba(92,40,22,.16)', 'rgba(255,196,152,.18)'], 0.6, 2.4)
    // Lichen crusting on a few tiles.
    for (let i = 0; i < 6; i++) {
      blob(ctx, rand() * SIZE, rand() * SIZE, 12 + rand() * 26,
           'rgba(150,158,92,.22)', 'rgba(150,158,92,0)')
    }
  },

  // The boulder rock the islands are made of: rounded, chunky, cooler and
  // greyer than the cut stone above it, but still warm-grey rather than neutral.
  stone(ctx, rand) {
    ctx.fillStyle = '#9a8f7d'
    ctx.fillRect(0, 0, SIZE, SIZE)
    // Rounded cobbles rather than a fracture pattern: this rock is weathered,
    // not quarried, and rounded forms are what the sky-island undersides show.
    for (let i = 0; i < 30; i++) {
      const x = rand() * SIZE
      const y = rand() * SIZE
      const r = 12 + rand() * 30
      // Lit crown, shaded skirt: offsetting the highlight centre is what makes
      // a flat circle read as a boulder.
      blob(ctx, x, y, r, `rgba(196,186,166,${0.20 + rand() * 0.18})`, 'rgba(196,186,166,0)')
      blob(ctx, x + r * 0.35, y + r * 0.45, r * 0.8, 'rgba(72,66,58,.20)', 'rgba(72,66,58,0)')
    }
    speckle(ctx, rand, 2000, ['rgba(126,118,104,.20)', 'rgba(206,198,180,.24)', 'rgba(72,66,58,.12)'], 1, 5)
    // Crevices between the boulders.
    for (let i = 0; i < 12; i++) {
      ctx.strokeStyle = 'rgba(66,60,52,.20)'
      ctx.lineWidth = 1.0 + rand() * 1.6
      ctx.beginPath()
      ctx.moveTo(rand() * SIZE, 0)
      ctx.lineTo(rand() * SIZE, SIZE)
      ctx.stroke()
    }
  },
}

/** Grey noise reused as the roughness break-up for every material. */
function roughnessTexture() {
  const [c, ctx] = canvas2d()
  const rand = rng(0xBEEF)
  ctx.fillStyle = '#9a9a9a'
  ctx.fillRect(0, 0, SIZE, SIZE)
  speckle(ctx, rand, 4000, ['rgba(255,255,255,.22)', 'rgba(0,0,0,.18)'], 1, 4)
  // Broad wet/dry patches on top of the grain, so a highlight travels across a
  // surface as you move instead of sitting at one constant sheen.
  for (let i = 0; i < 10; i++) {
    blob(ctx, rand() * SIZE, rand() * SIZE, 30 + rand() * 60,
         rand() < 0.5 ? 'rgba(255,255,255,.20)' : 'rgba(0,0,0,.18)', 'rgba(128,128,128,0)')
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}

/**
 * Per-kind surfacing.
 *
 * `relief`, `detile`, `wedge` and `topDust` are the four knobs that decide how
 * much of the macro layer a material pays for; 0 compiles the feature out
 * entirely. Everything else is documented in materials/shader.js.
 */
const SURFACE = {
  porcelain: {
    roughness: 0.72,
    metalness: 0.0,
    envMapIntensity: 0.75,
    // Sandstone is carved and slumped: the strongest relief of the built set,
    // so a 30 m terrace reads as tooled masses rather than one flat plane.
    relief: 1.1,
    reliefAlbedo: 0.16,
    detile: 0.85,
    macroAlbedo: 0.30,
    macroRough: 0.16,
    macroHue: 0.42,
    bigAlbedo: 0.11,
    wedge: 0.9,
    wedgeColor: 0x3f6a2c,
    topDust: 0.42,
    topColor: 0xf2e0ba,
    topRough: 0.16,
  },
  brass: {
    roughness: 0.34,
    metalness: 0.72,
    // Polished metal at golden hour is mostly what it reflects, so it takes
    // more of the environment than anything else in the frame.
    envMapIntensity: 1.0,
    // Rolled plate oil-cans slightly; it does not slump like clay. Low, but
    // non-zero — dead-flat metal is the most primitive-looking material there is.
    relief: 0.4,
    reliefAlbedo: 0.07,
    // Kept low: the medallions and rivet rows are authored features and a heavy
    // de-tile blend smears them into each other.
    detile: 0.45,
    // Metal varies more in polish than in colour, so the roughness bands carry
    // the variation and the albedo bands stay restrained.
    macroAlbedo: 0.20,
    macroRough: 0.24,
    macroHue: 0.28,
    bigAlbedo: 0.07,
    bigRough: 0.14,
    wedge: 0.85,
    // Verdigris-toward-moss where brass meets a planted deck.
    wedgeColor: 0x4b7440,
    topDust: 0.45,
    topColor: 0xe8cf9a,
    topRough: 0.14,
  },
  moss: {
    roughness: 0.95,
    metalness: 0.0,
    envMapIntensity: 0.6,
    // The thickest relief in the set: moss caps sit on stone as mounds with an
    // overhanging lip, and the tilt is what sells that at platform scale.
    relief: 1.25,
    reliefAlbedo: 0.22,
    detile: 0.95,
    macroAlbedo: 0.34,
    macroRough: 0.12,
    macroHue: 0.50,
    bigAlbedo: 0.13,
    // Moss on moss: the corner just goes deeper and damper.
    wedge: 0.35,
    wedgeColor: 0x2f5222,
    // Sun-bleached tips on the upward faces, which is where the light lands.
    topDust: 0.28,
    topColor: 0xa8c06a,
    topRough: 0.10,
  },
  terracotta: {
    roughness: 0.8,
    metalness: 0.0,
    envMapIntensity: 0.75,
    relief: 0.75,
    reliefAlbedo: 0.13,
    detile: 0.8,
    macroAlbedo: 0.28,
    macroRough: 0.16,
    macroHue: 0.38,
    bigAlbedo: 0.12,
    wedge: 0.95,
    wedgeColor: 0x44662c,
    topDust: 0.50,
    topColor: 0xecd2a6,
    topRough: 0.18,
  },
  stone: {
    roughness: 0.92,
    metalness: 0.0,
    envMapIntensity: 0.7,
    relief: 0.95,
    reliefAlbedo: 0.18,
    detile: 0.9,
    macroAlbedo: 0.32,
    macroRough: 0.14,
    // Cooler than the built stone: less hue drift, so it stays grey-warm and
    // reads as the raw rock underneath rather than as more sandstone.
    macroHue: 0.22,
    bigAlbedo: 0.13,
    // Island undersides are where the vines trail off, so this gets the most.
    wedge: 1.0,
    wedgeColor: 0x395c28,
    topDust: 0.55,
    topColor: 0xd8cdb4,
    topRough: 0.20,
  },
}

const _cache = new Map()
let _rough = null

export function surfaceMaterial(kind) {
  if (_cache.has(kind)) return _cache.get(kind)
  if (!_rough) _rough = roughnessTexture()

  const painter = PAINTERS[kind]
  if (!painter) throw new Error(`unknown surface kind: ${kind}`)

  const [c, ctx] = canvas2d()
  painter(ctx, rng(hash(kind)))

  const map = new THREE.CanvasTexture(c)
  map.wrapS = map.wrapT = THREE.RepeatWrapping
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 8

  const s = SURFACE[kind]
  const mat = new THREE.MeshStandardMaterial({
    map,
    roughnessMap: _rough,
    roughness: s.roughness,
    metalness: s.metalness,
    vertexColors: true,
    envMapIntensity: s.envMapIntensity,
  })
  mat.name = `surface:${kind}`
  extendSurfaceMaterial(mat, s)

  _cache.set(kind, mat)
  return mat
}

/** Emissive material for the lanterns and the finish bell. */
export function glowMaterial(color, intensity = 1.4) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.4,
    metalness: 0.1,
  })
}

/**
 * Tell the moss-creep wedge which world-Y planes count as floors (max four).
 * Defaults cover the course as built; see materials/shader.js.
 */
export { setGroundLevels }

function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
