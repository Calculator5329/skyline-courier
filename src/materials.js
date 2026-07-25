import * as THREE from 'three'

/**
 * Every surface in the game is generated here. No image files, ever.
 *
 * Textures are painted onto a 2D canvas at load and uploaded once. The point
 * is not photorealism — it is defeating the "engine primitives" read that
 * killed the predecessor. Three things do that work:
 *
 *   1. World-consistent texel density (see level.js), so a big wall and a
 *      small ledge share a material scale and read as the same substance.
 *   2. Surface-specific detail that encodes *function*. Brass is vertically
 *      brushed and panelled because brass is what you wall-run on, and the
 *      direction of the grain points the way you are meant to travel.
 *   3. Per-box tint jitter and baked bottom-shading in vertex colours, so a
 *      row of identical boxes never reads as a row of identical boxes.
 */

export const PALETTE = {
  porcelain: 0xf0e4cf,
  brass: 0xc9973f,
  moss: 0x6d8f56,
  terracotta: 0xbe6a45,
  stone: 0x9c9384,
  sky: 0x9ec7d8,
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

const PAINTERS = {
  // Cream porcelain: the neutral ground you run along.
  porcelain(ctx, rand) {
    ctx.fillStyle = '#f0e4cf'
    ctx.fillRect(0, 0, SIZE, SIZE)
    speckle(ctx, rand, 2600, ['rgba(180,166,140,.14)', 'rgba(255,252,244,.5)', 'rgba(150,138,118,.08)'], 0.5, 2.2)
    // Faint glaze pooling towards the lower edge.
    const g = ctx.createLinearGradient(0, 0, 0, SIZE)
    g.addColorStop(0, 'rgba(255,255,255,.06)')
    g.addColorStop(1, 'rgba(120,108,92,.12)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, SIZE, SIZE)
  },

  // Aged brass: vertical brushed grain + panel banding. This is the "you can
  // wall-run on me" material, and its grain runs the way you travel.
  brass(ctx, rand) {
    ctx.fillStyle = '#c9973f'
    ctx.fillRect(0, 0, SIZE, SIZE)
    for (let i = 0; i < 420; i++) {
      const x = rand() * SIZE
      const w = 0.5 + rand() * 2.4
      const light = rand() > 0.5
      ctx.fillStyle = light ? `rgba(255,226,160,${0.05 + rand() * 0.16})`
                            : `rgba(120,82,28,${0.05 + rand() * 0.18})`
      ctx.fillRect(x, 0, w, SIZE)
    }
    // Horizontal panel seams every quarter.
    for (let y = 0; y <= SIZE; y += SIZE / 4) {
      ctx.fillStyle = 'rgba(92,62,22,.42)'
      ctx.fillRect(0, y - 1.5, SIZE, 3)
      ctx.fillStyle = 'rgba(255,232,178,.28)'
      ctx.fillRect(0, y + 1.5, SIZE, 1.5)
    }
    speckle(ctx, rand, 300, ['rgba(96,120,86,.13)'], 1, 5)   // verdigris
  },

  // Moss: the landing pads. Softest, darkest, most obviously safe.
  moss(ctx, rand) {
    ctx.fillStyle = '#6d8f56'
    ctx.fillRect(0, 0, SIZE, SIZE)
    speckle(ctx, rand, 1500, ['rgba(126,164,96,.5)', 'rgba(72,100,54,.45)', 'rgba(158,186,120,.3)'], 1.5, 7)
    speckle(ctx, rand, 700, ['rgba(48,70,40,.28)'], 0.6, 2)
  },

  // Terracotta: rooftops and warm accents.
  terracotta(ctx, rand) {
    ctx.fillStyle = '#be6a45'
    ctx.fillRect(0, 0, SIZE, SIZE)
    const tile = SIZE / 4
    for (let ty = 0; ty < 4; ty++) {
      for (let tx = 0; tx < 4; tx++) {
        const ox = (ty % 2) * tile * 0.5
        ctx.fillStyle = `rgba(${(160 + rand() * 40) | 0},${(84 + rand() * 26) | 0},${(56 + rand() * 20) | 0},.5)`
        ctx.fillRect(tx * tile + ox + 1.5, ty * tile + 1.5, tile - 3, tile - 3)
      }
    }
    speckle(ctx, rand, 900, ['rgba(90,44,28,.16)', 'rgba(232,168,132,.16)'], 0.6, 2.4)
  },

  // Structural stone: everything that is scenery rather than route.
  stone(ctx, rand) {
    ctx.fillStyle = '#9c9384'
    ctx.fillRect(0, 0, SIZE, SIZE)
    speckle(ctx, rand, 2200, ['rgba(130,122,110,.22)', 'rgba(190,182,168,.3)', 'rgba(80,74,66,.12)'], 1, 5)
    for (let i = 0; i < 14; i++) {
      ctx.strokeStyle = 'rgba(74,68,60,.18)'
      ctx.lineWidth = 0.8 + rand() * 1.4
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
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
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

  const mat = new THREE.MeshStandardMaterial({
    map,
    roughnessMap: _rough,
    roughness: kind === 'brass' ? 0.42 : kind === 'porcelain' ? 0.55 : 0.88,
    metalness: kind === 'brass' ? 0.55 : 0.0,
    vertexColors: true,
    envMapIntensity: 0.6,
  })
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

function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
