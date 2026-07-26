import * as THREE from 'three'

/**
 * THE SLAB-TOP DECAL — Ethan's painted platform face, on the landing surfaces.
 *
 * `public/tex/void-slab-top.png`: carved stone, gold border courses, a glowing
 * violet sigil at centre. It is the one authored image the void's PLAY
 * geometry carries, and it exists because the procedural rune inlay it replaces
 * could state "a glyph is here" but never "this stone was cut by someone".
 *
 * ================== WHY THIS IS ALLOWED, AND WHAT IT IS NOT =================
 *
 * CLAUDE.md rule 1 bans art assets the GAME LOADS, with two standing
 * exceptions (generated music, and one painted sky dome per theme). This is a
 * third, and Ethan supplied the file for exactly this use. It is worth being
 * precise about why it does not reopen what rule 1 closed:
 *
 * The rule exists because generated-3D-asset intake stalled the predecessor —
 * every item needed hands-on cleanup and in-viewport judgement, so the loop
 * could never verify its own work. A flat decal on a flat face has none of
 * those properties. There is no mesh to clean, no rigging, no silhouette to
 * reconcile against a collider: the slab's collider is declared by `runeSlab`
 * exactly as before and this image is painted onto the face that collider
 * already had. It is authored once and judged once.
 *
 * It is NOT permission to load meshes, and it does not remove the procedural
 * path — see THE FALLBACK below, which is load-bearing rather than polite.
 *
 * ============================== THE MAPPING RULE ============================
 *
 * The file is 1536 x 1024, which is NOT the shape of a platform. Measured
 * rather than assumed: the artwork is a 1024 x 1024 SQUARE centred
 * horizontally, with flat neutral-grey generator padding either side. Column
 * standard deviation of luminance sits at 4-5 through x < 255 and x > 1277 and
 * jumps to 16-17 inside that; the violet content runs 294..1273. So:
 *
 *   1. CROP, don't fit. `offset`/`repeat` take the square and nothing else.
 *      No tiling — `ClampToEdgeWrapping`, because this is one carved face and
 *      a second copy of the border halfway across a slab would be nonsense.
 *   2. STRETCH the square across the slab's whole top face, u along +X and v
 *      along +Z. On a square slab that is 1:1. The border courses are a FRAME,
 *      and a frame is the one motif that stretches honestly — it stays a
 *      frame at any aspect.
 *   3. GATE ON ASPECT. The sigil is not a frame and does not stretch honestly;
 *      past about 1.3:1 it reads as an oval and stops being a glyph. Slabs
 *      past that ratio keep the procedural rune, which is radial and has no
 *      aspect to lose.
 *   4. SPIN in multiples of 90 degrees, per slab, from the slab's own seed —
 *      so 51 platforms do not read as 51 copies of one decal. A square crop is
 *      what makes 90 degrees free.
 *
 * ============================ THE GLOW IS THE POINT =========================
 *
 * art-direction-void.md §6, flagged non-negotiable: "a glowing rune means you
 * may stand here", and in a near-black level it is the only readability
 * channel there is. A painted violet pixel is not that — it is a slightly less
 * black pixel at 40 m. So the sigil is lit, not printed: `emissiveMap` is
 * derived from the image at load, isolating the violet and leaving stone and
 * gold at zero.
 *
 * The isolation is `b - max(r, g)` rather than a hue test, because the stone is
 * itself violet-tinted and a hue test selects the whole slab. Blue-over-green
 * separates a lit glyph from lit rock; hue does not.
 *
 * Bloom threshold is 1.05 on the max channel after exposure, so the emissive
 * has to clear that at the sigil's core and stay under it across the rest of
 * the glyph — otherwise the platform becomes a light source, which is the
 * failure `levels/void.js` already had to dial `runeIntensity` back from.
 *
 * ================================ THE FALLBACK ==============================
 *
 * The decal material is backed by a CANVAS from the first frame, painted with
 * a plain frame-and-sigil stand-in, and the image is drawn OVER that canvas
 * when it arrives. Nothing waits on a fetch and nothing branches on one:
 *
 *   - the level builds synchronously, as it always did;
 *   - a failed or slow load degrades to a legible frame and glyph rather than
 *     to bare rock, so the §6 promise cannot be broken by a network;
 *   - `runeSlab`'s procedural rune remains the path for every slab the aspect
 *     gate rejects, for `detail: 0`, and for `rune: false`.
 */

/** Square crop out of the 1536 x 1024 file, in pixels. See THE MAPPING RULE. */
const ART = { x: 255, y: 0, w: 1024, h: 1024 }

/** Working resolution. The crop is 1024 and there is nothing to gain past it. */
const SIZE = 1024

/** Emissive is a glow, not a detail map; a quarter of the albedo is plenty. */
const GLOW_SIZE = 512

/**
 * How hard to pull the violet out of the albedo.
 *
 * `k` scales `b - max(r, g)` into 0..1 and `floor` cuts the stone's own violet
 * cast, which is small but covers the entire slab and would otherwise make the
 * whole face a dim emitter — a platform-sized area light, which is precisely
 * what §7.3's bloom budget cannot afford.
 */
const GLOW = {
  k: 3.4,
  floor: 0.10,
  gamma: 3.0,
  /**
   * The measured peak of `(b - max(r, g)) * k - floor` over this image, used to
   * normalise the mask into 0..1 so that `emissiveIntensity` is the ONLY dial
   * that means anything. Without it the mask tops out near 0.33 and the
   * intensity number has a hidden 3x baked into it.
   */
  peak: 0.35,
  /**
   * How much albedo the inlay gives up where it glows.
   *
   * THIS IS THE FIX FOR THE WHITE BLOB, and it is worth stating because two
   * plausible dials were tried first and both failed. Rendered, the sigil came
   * back as a featureless white cloud far larger than the glyph; the obvious
   * reads are "emissive too hot" and "mask too broad", and neither is what was
   * happening. At `emissiveIntensity: 0` the albedo alone renders the glyph
   * cleanly, with all its structure. The mask, dumped to a PNG and looked at,
   * is well shaped — it traces the sigil's line work.
   *
   * What is actually happening is BLOOM. The sigil's albedo in the source file
   * is near-white at its core (247, 233, 243), which already sits just under
   * the 1.05 threshold once the level's light is on it. Any emissive at all
   * pushes the whole bright region over, and bloom then spreads it into a
   * cloud the size of the glow's soft falloff.
   *
   * So the inlay gives its albedo up in exchange: emissive REPLACES reflected
   * light here rather than adding to it, which is also what an inlay of lit
   * stone physically is. Net brightness at the core lands in the same place,
   * but it is now emissive rather than diffuse, so it blooms at the LINES
   * instead of across the halo.
   */
  albedoTradeoff: 0.55,
}

let _cache = null

function canvas(size) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  return c
}

/**
 * The stand-in, painted before the file arrives.
 *
 * Deliberately plain: a double border course, a corner tick at each corner and
 * an eight-point star knot at centre, in the same places the image puts them.
 * It is not trying to be the artwork — it is trying to keep "border, and a
 * glyph in the middle" true for the frames before the artwork exists.
 */
function paintStandIn(ctx, glow) {
  const S = SIZE
  ctx.fillStyle = '#221c2e'
  ctx.fillRect(0, 0, S, S)

  ctx.strokeStyle = '#8a6f3c'
  ctx.lineWidth = S * 0.018
  ctx.strokeRect(S * 0.055, S * 0.055, S * 0.89, S * 0.89)
  ctx.lineWidth = S * 0.010
  ctx.strokeRect(S * 0.105, S * 0.105, S * 0.79, S * 0.79)

  // The glyph, on both canvases: violet on the albedo, white on the glow (an
  // emissiveMap is a MASK — the colour comes from the material's `emissive`).
  for (const [c, size, stroke] of [[ctx, SIZE, '#b884ff'], [glow, GLOW_SIZE, '#ffffff']]) {
    const r = size * 0.26, cx = size / 2, cy = size / 2
    c.save()
    if (c === glow) { c.fillStyle = '#000000'; c.fillRect(0, 0, size, size) }
    c.strokeStyle = stroke
    c.lineWidth = size * 0.016
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke()
    c.beginPath(); c.arc(cx, cy, r * 0.80, 0, Math.PI * 2); c.stroke()
    for (const phase of [0, Math.PI / 4]) {
      c.beginPath()
      for (let i = 0; i < 4; i++) {
        const a = phase + (i * Math.PI) / 2
        const x = cx + Math.cos(a) * r * 0.74, y = cy + Math.sin(a) * r * 0.74
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y)
      }
      c.closePath(); c.stroke()
    }
    c.restore()
  }
}

/**
 * Derive the emissive mask from the albedo, and take the inlay's albedo back
 * out of the albedo canvas. See THE GLOW IS THE POINT and `GLOW.albedoTradeoff`.
 *
 * Order matters: the mask has to be read from the UNTOUCHED albedo, because
 * darkening the sigil is exactly what would stop it being detected as violet.
 */
function deriveGlow(albedoCanvas, albedoCtx, glowCtx) {
  glowCtx.drawImage(albedoCanvas, 0, 0, GLOW_SIZE, GLOW_SIZE)
  const img = glowCtx.getImageData(0, 0, GLOW_SIZE, GLOW_SIZE)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255
    let v = (b - Math.max(r, g)) * GLOW.k - GLOW.floor
    v = v <= 0 ? 0 : Math.pow(Math.min(1, v / GLOW.peak), GLOW.gamma)
    const k = Math.round(Math.min(1, v) * 255)
    d[i] = d[i + 1] = d[i + 2] = k
    d[i + 3] = 255
  }
  glowCtx.putImageData(img, 0, 0)

  // The trade. `multiply` by (1 - tradeoff * mask), built by drawing the mask
  // white-on-black over a white field in `difference`... which is one trick too
  // many for something this small: build the inverse directly.
  const inv = canvas(GLOW_SIZE)
  const ictx = inv.getContext('2d')
  const iimg = ictx.createImageData(GLOW_SIZE, GLOW_SIZE)
  for (let i = 0; i < d.length; i += 4) {
    const k = Math.round(255 * (1 - GLOW.albedoTradeoff * (d[i] / 255)))
    iimg.data[i] = iimg.data[i + 1] = iimg.data[i + 2] = k
    iimg.data[i + 3] = 255
  }
  ictx.putImageData(iimg, 0, 0)
  albedoCtx.save()
  albedoCtx.globalCompositeOperation = 'multiply'
  albedoCtx.drawImage(inv, 0, 0, SIZE, SIZE)
  albedoCtx.restore()
}

/**
 * The shared decal textures. One albedo, one emissive mask, for every slab in
 * the course — so the whole decal layer is one material and one draw call.
 *
 * @returns {{map: THREE.Texture, emissiveMap: THREE.Texture}}
 */
export function slabDecalTextures() {
  if (_cache) return _cache
  if (typeof document === 'undefined') return null   // node self-tests

  const ac = canvas(SIZE), actx = ac.getContext('2d')
  const gc = canvas(GLOW_SIZE), gctx = gc.getContext('2d')
  paintStandIn(actx, gctx)

  const map = new THREE.CanvasTexture(ac)
  map.colorSpace = THREE.SRGBColorSpace
  const emissiveMap = new THREE.CanvasTexture(gc)
  emissiveMap.colorSpace = THREE.NoColorSpace
  for (const t of [map, emissiveMap]) {
    // CLAMP, NOT REPEAT. This is one carved face; a wrapped copy of the border
    // course would appear the moment a uv rounded past 1 at a slab edge.
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
    t.anisotropy = 8
  }

  const img = new Image()
  img.onload = () => {
    actx.drawImage(img, ART.x, ART.y, ART.w, ART.h, 0, 0, SIZE, SIZE)
    deriveGlow(ac, actx, gctx)
    map.needsUpdate = true
    emissiveMap.needsUpdate = true
  }
  // A missing file leaves the stand-in in place, which is the whole point of
  // painting it first. Nothing to handle beyond not throwing.
  img.onerror = () => {}
  img.src = 'tex/void-slab-top.png'

  _cache = { map, emissiveMap }
  return _cache
}
