import * as THREE from 'three'

/**
 * Analytic sky IBL.
 *
 * The scene has a HemisphereLight and a fill light and that is all the indirect
 * light there was: two constants. A hemisphere light cannot know that the sun
 * is low and to the left, so shaded surfaces facing the sun's side of the sky
 * came back exactly as cool as surfaces facing away from it, and the whole
 * warm-key/cool-fill split this art direction is built on lived only in the
 * direct term.
 *
 * So: build a sunset sky analytically into a small half-float equirect on the
 * CPU, run it through PMREM, hand it to `scene.environment`. Now a wall facing
 * the sun picks up gold in shadow, a wall facing away picks up the cool green
 * zenith, and a soffit picks up the cloud deck. That directionality is the
 * entire point; the absolute level is handled below.
 *
 * ============================ THE 20% RULE ==================================
 * The map is normalised so that its irradiance on an up-facing surface is
 * ~20% of the sun's. This is not a taste knob, it is the thing that decides
 * whether the frame looks lit or looks like a WebGL demo: ambient that
 * approaches the key light flattens every form, kills the shadow shapes the
 * key is drawing, and no amount of grading afterwards gets the contrast back.
 * A clear sky really is about a fifth of direct sun, so this is also correct.
 * We MEASURE the generated map's cosine-weighted irradiance and rescale to hit
 * the target, rather than tuning a magic multiplier until it looks right —
 * change a colour below and the level stays put.
 * ============================================================================
 *
 * PMREM is regenerated only when the sun direction actually moves (see
 * `update`). The sun in this game follows the player but keeps a constant
 * direction, so in practice this builds once, on the first frame. Regenerating
 * a PMREM per frame costs more than the entire rest of the pipeline.
 */

/** Equirect resolution. */
// 128x64 is 8192 texels: enough for a smooth gradient and a broad sun aureole,
// far too coarse for a sun disc — which is deliberate. The DirectionalLight
// already carries the sun's direct energy; putting a disc in here as well would
// double-count the brightest thing in the scene.
const W = 128
const H = 64

const DEFAULTS = {
  /**
   * Cool, slightly green zenith. THE COOL HALF OF THE WARM/COOL SPLIT. Shaded
   * up-facing surfaces read almost entirely off this colour, so it is what
   * makes the shadows green-cool instead of neutral grey, and the green
   * (rather than pure blue) is the moss and the vegetation-heavy islands
   * feeding back into the sky term.
   */
  zenith: 0x4d7f83,
  /** Peach/cream mid-to-horizon band, away from the sun. */
  horizon: 0xffcfa0,
  /** The gold aureole around a low sun. Broad, bright, no disc. */
  sunHaze: 0xffbe70,
  /**
   * The cloud sea below. Unusually bright for a "ground" term: this is not
   * earth albedo, it is a sunlit cloud deck, which is one of the brightest
   * diffuse surfaces there is. Everything that overhangs — soffits, the
   * undersides of the islands, the underside of every ledge — is lit by this,
   * and getting it wrong is what makes floating geometry look grounded.
   */
  cloud: 0xffd7a8,
  /** Relative radiance gains for the four bands, before normalisation. */
  zenithGain: 1.0,
  horizonGain: 1.7,
  sunHazeGain: 2.4,
  cloudGain: 1.9,
  /**
   * Extra sunset warming applied on top of whatever the sun's real elevation
   * says. The rig's sun sits higher than the reference art, and this lets the
   * SKY read golden-hour without the shadow frustum in world.js having to
   * change first. 0 = physically-driven only, 1 = full sunset.
   */
  goldenBias: 0.7,
}

/** Rec.709 luminance of a linear-light triple. */
function lum(r, g, b) {
  return r * 0.2126 + g * 0.7152 + b * 0.0722
}

export class SkyEnvironment {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} [options] see DEFAULTS, plus `irradiance` (the absolute
   *        target, normally sunIrradiance * 0.20).
   */
  constructor(renderer, options = {}) {
    this.renderer = renderer
    this.ok = false

    this.colors = {
      zenith: new THREE.Color(options.zenith ?? DEFAULTS.zenith),
      horizon: new THREE.Color(options.horizon ?? DEFAULTS.horizon),
      sunHaze: new THREE.Color(options.sunHaze ?? DEFAULTS.sunHaze),
      cloud: new THREE.Color(options.cloud ?? DEFAULTS.cloud),
    }
    this.gains = {
      zenith: options.zenithGain ?? DEFAULTS.zenithGain,
      horizon: options.horizonGain ?? DEFAULTS.horizonGain,
      sunHaze: options.sunHazeGain ?? DEFAULTS.sunHazeGain,
      cloud: options.cloudGain ?? DEFAULTS.cloudGain,
    }
    this.goldenBias = options.goldenBias ?? DEFAULTS.goldenBias

    /** Absolute target: irradiance on an up-facing surface, in light units. */
    this.irradiance = options.irradiance ?? 0.46

    this._sunDir = new THREE.Vector3(0, 1, 0)
    this._builtDir = new THREE.Vector3(0, -1, 0) // impossible, forces a build
    this._dirty = true

    this._data = new Uint16Array(W * H * 4)
    // Scratch for the radiance pass, so generation allocates nothing either.
    this._linear = new Float32Array(W * H * 3)

    this._equirect = new THREE.DataTexture(this._data, W, H, THREE.RGBAFormat, THREE.HalfFloatType)
    this._equirect.mapping = THREE.EquirectangularReflectionMapping
    this._equirect.minFilter = THREE.LinearFilter
    this._equirect.magFilter = THREE.LinearFilter
    // NoColorSpace: these are radiance values we computed in linear light. Any
    // colour-space conversion here would apply a transfer function to numbers
    // that are already scene-referred.
    this._equirect.colorSpace = THREE.NoColorSpace
    this._equirect.name = 'sc-sky-equirect'

    this._pmrem = null
    this._target = null
  }

  /** Absolute irradiance target — normally driven by the 20% rule upstream. */
  setIrradiance(v) {
    if (v === this.irradiance) return
    this.irradiance = v
    this._dirty = true
  }

  /** @param {object} c any subset of {zenith, horizon, sunHaze, cloud} as hex. */
  setColors(c) {
    for (const k in c) {
      if (this.colors[k]) this.colors[k].set(c[k])
    }
    this._dirty = true
  }

  /** @param {object} g any subset of the four *Gain values. */
  setGains(g) {
    for (const k in g) {
      if (k in this.gains) this.gains[k] = g[k]
    }
    this._dirty = true
  }

  setGoldenBias(v) {
    if (v === this.goldenBias) return
    this.goldenBias = v
    this._dirty = true
  }

  /**
   * Point the sky at `sunDir` (unit, TOWARD the sun) and rebuild if it moved.
   * Returns the PMREM texture, or null if the context could not build one.
   *
   * Threshold is 0.9999 on the dot product, i.e. about 0.8 degrees. Below that
   * the change in the diffuse SH is far under a display code value, and
   * rebuilding is a stall the player would feel as a hitch.
   */
  update(sunDir) {
    this._sunDir.copy(sunDir)
    if (!this._dirty && this._builtDir.dot(this._sunDir) > 0.9999) {
      return this._target ? this._target.texture : null
    }
    this._builtDir.copy(this._sunDir)
    this._dirty = false
    this._build()
    return this._target ? this._target.texture : null
  }

  get texture() {
    return this._target ? this._target.texture : null
  }

  // -------------------------------------------------------------- generation

  _build() {
    const sun = this._sunDir
    const lin = this._linear
    const c = this.colors
    const g = this.gains

    // How low is the sun, 0 = high, 1 = on the horizon. The 2.4 puts the ramp
    // entirely inside the bottom ~25 degrees, which is where real sunset colour
    // actually happens; above that a clear sky is barely warmer than at noon.
    const sunUp = Math.max(0, sun.y)
    const physicalLow = Math.pow(1 - Math.min(1, sunUp * 2.4), 2)
    const low = Math.min(1, physicalLow + this.goldenBias * (1 - physicalLow))

    // Sun-side azimuth, for the warm band that hugs the horizon under the sun.
    const sax = sun.x
    const saz = sun.z
    const sazLen = Math.hypot(sax, saz) || 1

    let p = 0
    // Cosine-weighted irradiance accumulator for an up-facing normal.
    let eR = 0
    let eG = 0
    let eB = 0
    const dPhi = (Math.PI * 2) / W
    const dTheta = Math.PI / H

    for (let y = 0; y < H; y++) {
      // GL texture rows start at the BOTTOM of the image, so row 0 must be the
      // nadir or the equirect comes out upside down and the cloud deck lights
      // the tops of things.
      const theta = (1 - (y + 0.5) / H) * Math.PI
      const sinT = Math.sin(theta)
      const cosT = Math.cos(theta) // = dir.y
      // Solid angle of one texel on this row.
      const dOmega = sinT * dTheta * dPhi

      for (let x = 0; x < W; x++) {
        const phi = ((x + 0.5) / W) * Math.PI * 2 - Math.PI
        const dx = sinT * Math.sin(phi)
        const dy = cosT
        const dz = sinT * Math.cos(phi)

        const cosGamma = Math.min(1, Math.max(-1, dx * sun.x + dy * sun.y + dz * sun.z))
        const gamma = Math.acos(cosGamma)

        // --- vertical gradient -------------------------------------------
        // pow 0.42 rather than a linear blend: it holds the warm band down in
        // the bottom third of the dome and lets the cool zenith own the top,
        // which is the shape of a real sunset sky and the shape that produces
        // a genuinely two-colour ambient rather than a mush in between.
        const t = Math.pow(Math.max(0, dy), 0.42)
        let r = (c.horizon.r * g.horizon) * (1 - t) + (c.zenith.r * g.zenith) * t
        let gg = (c.horizon.g * g.horizon) * (1 - t) + (c.zenith.g * g.zenith) * t
        let b = (c.horizon.b * g.horizon) * (1 - t) + (c.zenith.b * g.zenith) * t

        // --- Mie forward lobe --------------------------------------------
        // Two exponentials: a tight aureole (the bright ring you cannot look
        // at) and a wide one carrying warmth a long way around the sky. This
        // is what makes the ambient directional — the whole reason we are
        // doing an IBL instead of leaving the HemisphereLight alone.
        const mie = 1.35 * Math.exp(-gamma * 3.1) + 0.34 * Math.exp(-gamma * 0.62)
        r += c.sunHaze.r * g.sunHaze * mie
        gg += c.sunHaze.g * g.sunHaze * mie
        b += c.sunHaze.b * g.sunHaze * mie

        // --- warm band along the sun-side horizon -------------------------
        // Separate from the lobe above because at golden hour the brightness
        // runs ALONG the horizon, not just radially around the sun. Gated on
        // both height (within ~20 degrees of the horizon) and azimuth.
        if (dy > -0.35 && dy < 0.35) {
          const azi = Math.max(0, (dx * sax + dz * saz) / sazLen)
          const band = Math.pow(azi, 2.0) * Math.exp(-Math.abs(dy) * 6.0)
          r += c.sunHaze.r * g.sunHaze * band * 0.55 * low
          gg += c.sunHaze.g * g.sunHaze * band * 0.55 * low
          b += c.sunHaze.b * g.sunHaze * band * 0.55 * low
        }

        // --- sunset warming ------------------------------------------------
        // Longer path through the atmosphere removes short wavelengths. The
        // asymmetry (red up, blue down hard, green barely) is what separates
        // "warm" from "orange filter over everything".
        r *= 1 + low * 0.55
        gg *= 1 - low * 0.10
        b *= 1 - low * 0.38

        // --- the cloud sea --------------------------------------------------
        // Below the horizon this is not ground, it is a sunlit cloud deck, and
        // it is BRIGHT. It also carries its own forward-scatter toward the sun,
        // because the cloud tops nearest the sun are the ones edge-lit by it.
        if (dy < 0) {
          // Fully cloud by ~17 degrees below the horizon; the feather stops a
          // visible seam appearing in the reflections on the polished surfaces.
          const k = Math.min(1, -dy * 3.4)
          const glow = 1 + 0.9 * Math.pow(Math.max(0, cosGamma), 3.0)
          const cr = c.cloud.r * g.cloud * glow
          const cg = c.cloud.g * g.cloud * glow
          const cb = c.cloud.b * g.cloud * glow
          r = r * (1 - k) + cr * k
          gg = gg * (1 - k) + cg * k
          b = b * (1 - k) + cb * k
        }

        lin[p] = r
        lin[p + 1] = gg
        lin[p + 2] = b
        p += 3

        // Only the upper hemisphere contributes to an up-facing normal's
        // irradiance; the cloud deck is measured by the downward-facing
        // surfaces it actually lights, and folding it into the normalisation
        // reference would let a brighter cloud deck darken the sky.
        if (dy > 0) {
          const w = dy * dOmega
          eR += r * w
          eG += gg * w
          eB += b * w
        }
      }
    }

    // --- normalise to the 20% target ------------------------------------
    const measured = lum(eR, eG, eB)
    const scale = measured > 1e-6 ? this.irradiance / measured : 0
    const toHalf = THREE.DataUtils.toHalfFloat
    const data = this._data
    for (let i = 0, j = 0; i < W * H; i++) {
      data[j] = toHalf(lin[i * 3] * scale)
      data[j + 1] = toHalf(lin[i * 3 + 1] * scale)
      data[j + 2] = toHalf(lin[i * 3 + 2] * scale)
      data[j + 3] = toHalf(1)
      j += 4
    }
    this._equirect.needsUpdate = true

    // --- PMREM ------------------------------------------------------------
    // Wrapped: PMREM needs to render to a half-float target, and on a context
    // without the colour-buffer-float extensions that throws rather than
    // degrading. Losing the IBL is a flatter frame; throwing is a black screen.
    try {
      if (!this._pmrem) {
        this._pmrem = new THREE.PMREMGenerator(this.renderer)
        this._pmrem.compileEquirectangularShader()
      }
      // Reusing the target across rebuilds: fromEquirectangular allocates a new
      // one every call otherwise, and a sun that tracks the time of day would
      // leak a cube render target per rebuild.
      this._target = this._pmrem.fromEquirectangular(this._equirect, this._target)
      this._target.texture.name = 'sc-sky-env'
      this.ok = true
    } catch (e) {
      this.ok = false
      this._target = null
    }
  }

  dispose() {
    if (this._target) this._target.dispose()
    if (this._pmrem) this._pmrem.dispose()
    this._equirect.dispose()
    this._target = null
    this._pmrem = null
  }
}
