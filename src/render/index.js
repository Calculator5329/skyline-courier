import * as THREE from 'three'
import { blit, detectHdrSupport, renderTarget } from './pass.js'
import { AutoExposure } from './exposure.js'
import { Bloom } from './bloom.js'
import { createGradeLut, GRADE } from './lut.js'
import { createComposite } from './composite.js'
import { GBuffer } from './gbuffer.js'
import { ContactShadows } from './contact.js'
import { MaterialPatcher } from './patch.js'
import { SkyEnvironment } from './skyenv.js'

/** Rec.709 luminance of a linear-light colour, for the light-budget maths. */
function colorLum(c) {
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722
}

/**
 * The post-processing pipeline for Skyline Courier.
 *
 * Drop-in replacement for `renderer.render(scene, camera)`:
 *
 *     const pipeline = new RenderPipeline(renderer, scene, camera)
 *     pipeline.setSize(window.innerWidth, window.innerHeight)
 *     // per frame:
 *     pipeline.render(dt)
 *
 * The chain, in order:
 *
 *   scene -> HDR half-float target (MSAA, depth)
 *   -> auto-exposure  (GPU reduction to a 1x1, no readback, no stall)
 *   -> bloom          (6-level Jimenez pyramid, thresholded post-exposure)
 *   -> composite      (exposure, CA, bloom, vignette, AgX, LUT, grain,
 *                      sharpen, dither) -> canvas
 *
 * Tone mapping happens in the composite and nowhere else. The renderer's own
 * `toneMapping` is irrelevant once this is installed — three disables it when
 * rendering into a render target, and the composite is a raw ShaderMaterial
 * that does not include three's tonemapping or colorspace chunks — but it
 * should still be set to `THREE.NoToneMapping` so nobody has to work that out.
 *
 * Nothing in render() allocates. Every uniform is a pre-built vector that is
 * written in place.
 */
export class RenderPipeline {
  constructor(renderer, scene, camera, options = {}) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera

    /**
     * Can we render into a float colour buffer?
     *
     * Without it there is no HDR: the scene target clips at 1.0, auto-exposure
     * is metering a clipped image and threshold bloom has nothing above white
     * to find. Rather than throw, we build the identical target graph in RGBA8,
     * skip the exposure chain in favour of a fixed value, and drop the bloom
     * threshold below white so there is still a glow on the lanterns. The game
     * runs and looks like a slightly flatter version of itself.
     */
    this.hdrSupported = detectHdrSupport(renderer)

    // Half-float, not full float: identical dynamic range for our purposes
    // (max 65504, and nothing in this scene exceeds ~50), half the bandwidth,
    // and filterable without an extension on WebGL2.
    this._type = this.hdrSupported ? THREE.HalfFloatType : THREE.UnsignedByteType

    /**
     * MSAA sample count on the scene target.
     *
     * main.js asks for `antialias: true`, which only ever applied to the
     * default framebuffer — the moment the scene renders into an offscreen
     * target that request is silently dropped and every roofline goes jagged.
     * 4x on the render target restores it. This is the whole reason to care:
     * a parkour game is read through its silhouettes.
     */
    this.samples = options.samples ?? 4

    /** Render scale, for a quality slider. 1 = native. */
    this.renderScale = options.renderScale ?? 1

    this._width = 1
    this._height = 1
    this._time = 0

    // --- scene target ------------------------------------------------------
    this.sceneTarget = renderTarget(1, 1, this._type, {
      name: 'sc-hdr',
      depthBuffer: true,
      samples: this.samples,
    })

    // --- auto exposure -----------------------------------------------------
    this.exposure = this.hdrSupported ? new AutoExposure(this._type, options.exposure || {}) : null

    // Fallback exposure carrier: a 1x1 FloatType DataTexture holding a fixed
    // multiplier, so the composite has exactly one code path whether or not
    // metering is available. Sampling a float texture is core WebGL2 (only
    // *rendering* to one needs the extension), and NearestFilter sidesteps
    // OES_texture_float_linear.
    this._fixedExposure = new THREE.DataTexture(
      // 0.85: with the ACES-ish lighting rig in world.js (2.5 sun + 1.05 hemi)
      // an unmetered frame sits a little hot, and 0.85 lands the sunlit
      // porcelain just under white. Only used on the no-float path.
      new Float32Array([0.85, 0, 0, 1]),
      1,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    )
    this._fixedExposure.minFilter = THREE.NearestFilter
    this._fixedExposure.magFilter = THREE.NearestFilter
    this._fixedExposure.needsUpdate = true
    this._fixedExposure.name = 'sc-fixed-exposure'

    // --- bloom -------------------------------------------------------------
    this.bloom = new Bloom(this._type, options.bloomLevels ?? 6)
    // Threshold 0.85 post-exposure, down from 1.05.
    //
    // 1.05 was correct for a scene that contained things above display white.
    // Measured, this one does not: across all eight harness shots the 99th
    // percentile never exceeded 185/255 and clipped-high was 0.0%, so the whole
    // six-level pyramid ran every frame and contributed nothing. A golden-hour
    // scene with no aureole on the sun and no glow on the lanterns has no light
    // source in it — the light is asserted by the grade rather than seen.
    //
    // 0.78 with a 0.3 knee starts the ramp at 0.48, which is above sunlit
    // sandstone (~0.35 exposed) and below the lantern globes, the sun-raked
    // brass and the solar disc. The narrower knee is the other half of the fix:
    // a 0.5 knee at a 1.05 threshold spread the ramp over a full stop that
    // nothing ever crossed.
    this.bloom.threshold = 0.78
    this.bloom.knee = 0.3
    if (!this.hdrSupported) {
      // In an LDR buffer nothing can exceed 1.0, so a threshold at 1.05 would
      // never fire. 0.72 picks out the lanterns and the sun-facing brass, which
      // is the intent of the effect, at the cost of a little glow on bright
      // diffuse surfaces.
      this.bloom.threshold = 0.72
      this.bloom.knee = 0.25
    }

    // --- grade + composite -------------------------------------------------
    // A theme supplies a PARTIAL grade — the handful of knobs that make it
    // cold or warm — over the shipped baseline, rather than a whole new table.
    // A theme that had to restate toeStrength and whitePoint to change a
    // shadow tint would drift from the baseline every time the baseline moved.
    this.lut = createGradeLut(options.grade ? { ...GRADE, ...options.grade } : GRADE)
    this.composite = createComposite(this.lut)

    /** Live handles on the composite's uniform vectors, for the tunables. */
    this._uLens = this.composite.uniforms.uLens.value
    this._uGrade = this.composite.uniforms.uGrade.value
    this._uLook = this.composite.uniforms.uLook.value

    // --- shading: prepass, contact shadows, sky IBL, aerial perspective ----
    //
    // Everything below degrades to "off" rather than throwing. The prepass and
    // the contact march both need a float/half-float colour attachment, and the
    // PMREM generator needs one too; on a context without them the game still
    // runs, with the shadow map's own filtering as the only contact and the
    // scene's HemisphereLight as the only ambient. Aerial perspective is pure
    // arithmetic in the material and survives regardless — which is deliberate,
    // because it is the effect doing the most work for this art direction.
    this.patcher = new MaterialPatcher()

    /**
     * Point the HAZE at the same sky the dome and the IBL are getting.
     *
     * This was a genuine hole rather than a nicety: `options.sky` reached the
     * IBL and world.js's dome, and the aerial perspective kept the module
     * defaults from skygrad.js. A theme could therefore repaint the entire
     * background and still have every distant surface fade into golden-hour
     * cream — which is precisely the "islands terminating against a colour the
     * sky never reaches" failure the shared gradient exists to prevent, only
     * arriving through the theme rather than through a stale constant.
     *
     * Note the key rename: the IBL calls them {sunHaze, cloud} and the sky
     * gradient calls them {sun, deck}. Mapped here, once, rather than asking
     * every caller to know both vocabularies.
     */
    if (options.sky) {
      this.patcher.setSkyColors({
        zenith: options.sky.zenith,
        horizon: options.sky.horizon,
        deck: options.sky.cloud,
        sun: options.sky.sunHaze,
        voidMode: options.sky.voidMode,
      })
    }

    /**
     * Per-theme aerial perspective, as a partial overlay over the measured
     * defaults in patch.js — the same contract `grade` and `exposure` use.
     *
     * `art-direction-void.md` §5 asks for depth in three named bands (near mass
     * nearly black, mid ruins in violet fog, far structures washed almost to
     * the fog colour), and the band structure is entirely a function of these
     * numbers: density sets where the bands land, `floor` sets whether the far
     * band keeps any identity at all, and `sunLobe` has to go to zero in a
     * world with no sun or the haze prints a solar hotspot onto a void.
     */
    const aerial = options.aerial
    if (aerial) {
      if (aerial.density !== undefined) this.patcher.aerialDensity = aerial.density
      if (aerial.scaleHeight !== undefined) this.patcher.aerialScaleHeight = aerial.scaleHeight
      if (aerial.referenceHeight !== undefined) {
        this.patcher.aerialReferenceHeight = aerial.referenceHeight
      }
      if (aerial.inscatter !== undefined) this.patcher.aerialInscatter = aerial.inscatter
      if (aerial.floor !== undefined) this.patcher.aerialFloor = aerial.floor
      if (aerial.rim !== undefined) this.patcher.aerialRim = aerial.rim
      if (aerial.chroma !== undefined) this.patcher.aerialChroma = aerial.chroma
      if (aerial.sunLobe !== undefined) this.patcher.aerialSunLobe = aerial.sunLobe
      if (aerial.extinction) {
        this.patcher.uniforms.scAerialBeta.value.set(...aerial.extinction)
      }
      if (aerial.hazeSun !== undefined) {
        this.patcher.uniforms.scHazeSun.value.set(aerial.hazeSun)
          .multiplyScalar(aerial.hazeSunBoost ?? 1.5)
      }
    }

    /** Can we build the depth/normal prepass and march it? */
    this.contactSupported = this.hdrSupported
    this.gbuffer = null
    this.contact = null
    if (this.contactSupported) {
      try {
        // R32F where available. See the note in gbuffer.js on why half-float
        // depth is not good enough for the contact bias.
        this.gbuffer = new GBuffer(renderer.extensions.has('EXT_color_buffer_float'))
        this.contact = new ContactShadows()
      } catch (e) {
        this.contactSupported = false
        this.gbuffer = null
        this.contact = null
      }
    }
    this._contactEnabled = options.contactShadows ?? true

    /**
     * How much a SKY texel votes in the exposure meter, relative to a texel
     * with geometry in it. See the coverage block in exposure.js.
     */
    this._meterSkyWeight = options.meterSkyWeight ?? options.exposure?.skyWeight ?? 0.30

    /** Analytic sunset sky through PMREM -> scene.environment. */
    this.skyEnv = this.hdrSupported ? new SkyEnvironment(renderer, options.sky) : null

    /**
     * THE 20% RULE, as a budget rather than a magic number.
     *
     * ======================= WHAT THE BUDGET COVERS ==========================
     * It used to cover only the *ambient* terms, and that was the hole. The
     * scene's non-key light is not just ambient: world.js also runs a shadowless
     * side-fill DirectionalLight and a bounce DirectionalLight from below, and
     * measured against the key those two spend more than the entire ambient
     * budget over again. Total non-key came out at 43% of key — barely one stop
     * of shadow depth — which is exactly why a 2.8 m balustrade at a 9.8-degree
     * sun elevation threw no visible shadow across the terrace deck and every
     * box read as an untextured primitive lit identically on all faces.
     *
     * So the budget is now three numbers that sum to the 20% total, and every
     * one of them is enforced against a MEASURED irradiance rather than a hoped
     * intensity:
     *
     *   skyIrradianceRatio     0.15   ambient (sky IBL + HemisphereLight)
     *   bounceIrradianceRatio  0.04   DirectionalLights from below the horizon
     *   fillIrradianceRatio    0.00   DirectionalLights from above it
     *                          ----
     *                          0.19   -> ~2.4 stops of shadow depth
     *
     * Golden hour is a HIGH-CONTRAST condition. Under one stop of shadow depth
     * is not a stylistic choice, it is the absence of lighting.
     * =========================================================================
     */
    this.skyIrradianceRatio = options.skyIrradianceRatio ?? 0.15
    /**
     * 0.88 to the IBL. The IBL is the part that carries DIRECTION — gold on the
     * sun side, cool green at the zenith, bright cloud deck underneath — and
     * that split is the look. A HemisphereLight cannot know where the sun is, so
     * every unit of budget it holds is a unit spent flattening the frame. It
     * keeps a token eighth only because it is the sole ambient reaching any
     * material this pipeline has not patched.
     */
    this.iblShare = options.iblShare ?? 0.88
    /**
     * Budget for non-key DirectionalLights arriving from BELOW the horizon —
     * the bounce off the sunlit cloud deck. Real, and the thing that keeps the
     * undersides of floating islands from going black, so it keeps a share; it
     * was simply spending four times this.
     */
    this.bounceIrradianceRatio = options.bounceIrradianceRatio ?? 0.04
    /**
     * Budget for non-key DirectionalLights arriving from ABOVE the horizon.
     *
     * ZERO, deliberately. A shadowless fill from the opposite azimuth is the sky
     * IBL's job, and the IBL does it directionally and with the correct colour
     * per normal instead of as one flat wash. Running both is doing the job
     * twice and paying for it in shadow depth. Raise this only if you have
     * decided the IBL is off.
     */
    this.fillIrradianceRatio = options.fillIrradianceRatio ?? 0.0
    this._ambientAuto = true

    // --- scene walk state --------------------------------------------------
    // Rebuilt periodically rather than per frame; see _walk().
    this._walkCountdown = 0
    this._prepassHidden = []
    this._prepassHiddenVis = []
    this._sunLight = null
    this._hemiLight = null
    // Every DirectionalLight found by the walk, so the budget below can be
    // measured off the ones that are NOT the key. Reused by resetting .length,
    // so a steady-state walk allocates nothing.
    this._dirLights = []
    this._sunAuto = true
    this._sunDirWorld = new THREE.Vector3(-0.42, 0.46, 0.78).normalize()
    this._sunDirView = new THREE.Vector3(0, 1, 0)
    this._scratchDir = new THREE.Vector3()
    this._scratchDir2 = new THREE.Vector3()
    // Bound once so scene.traverse() allocates no closure per frame.
    this._visit = (object) => this._visitObject(object)

    /**
     * Self-registration, so the verification harness can reach the pipeline.
     *
     * `window.__game` is assembled in main.js and does not carry this object,
     * which meant no screenshot test could ever assert that contact shadows
     * were on — and they silently were not, for exactly as long as nobody could
     * check. Registering here rather than asking main.js to do it keeps the
     * guarantee inside the file that owns it: the pipeline is reachable the
     * instant it exists, whoever constructed it.
     *
     * Last-constructed wins, which is correct: the game builds exactly one, and
     * selftest.js builds throwaways that dispose themselves.
     */
    if (typeof globalThis !== 'undefined') globalThis.__scRender = this
  }

  // ------------------------------------------------------------- scene walk

  /**
   * Re-scan the scene: patch new materials, find the sun and the hemisphere
   * light, and rebuild the list of objects the prepass must skip.
   *
   * Every 60 frames rather than every frame. The level is built once and the
   * only thing that changes is which decorative props exist, so a per-frame
   * traverse of a merged-geometry scene would be pure overhead. Everything the
   * walk discovers is cached in preallocated fields, so render() itself never
   * touches the scene graph.
   */
  _walk() {
    this._prepassHidden.length = 0
    this._dirLights.length = 0
    this._sunLight = null
    this._hemiLight = null
    this.scene.traverse(this._visit)

    // The key is the first shadow-casting DirectionalLight. Chosen after the
    // traverse rather than during it so the classification below cannot depend
    // on scene-graph order.
    for (let i = 0; i < this._dirLights.length; i++) {
      if (this._dirLights[i].castShadow) {
        this._sunLight = this._dirLights[i]
        break
      }
    }

    // --- the ambient budget -------------------------------------------------
    const sunIrradiance = this._sunLight
      ? this._sunLight.intensity * colorLum(this._sunLight.color)
      : 2.5
    const target = sunIrradiance * this.skyIrradianceRatio
    const iblTarget = target * this.iblShare
    if (this.skyEnv) this.skyEnv.setIrradiance(iblTarget)

    // --- the non-key DIRECT budget -----------------------------------------
    // Same idea as the ambient trim, applied to the fill DirectionalLights,
    // which are the larger half of the overspend. Split by whether the light
    // arrives from above or below the horizon, matching the test the shader
    // does per fragment (see DIR_WRAPPER in patch.js) — the two classifications
    // must agree or a light gets measured in one bucket and trimmed by the
    // other's factor.
    let sideIrradiance = 0
    let bounceIrradiance = 0
    for (let i = 0; i < this._dirLights.length; i++) {
      const light = this._dirLights[i]
      if (light === this._sunLight) continue
      const irr = light.intensity * colorLum(light.color)
      if (irr <= 1e-6) continue
      if (this._lightDirection(light, this._scratchDir2).y < 0) bounceIrradiance += irr
      else sideIrradiance += irr
    }
    // min(1, ...) so this can only ever TRIM. If world.js dials its own fills
    // down to or below the budget, the trims measure out at 1.0 and this whole
    // mechanism costs one multiply per light per fragment and changes nothing —
    // which is the correct behaviour for a budget, as opposed to a target.
    const sideTrim =
      sideIrradiance > 1e-4
        ? Math.min(1, (sunIrradiance * this.fillIrradianceRatio) / sideIrradiance)
        : 1
    const bounceTrim =
      bounceIrradiance > 1e-4
        ? Math.min(1, (sunIrradiance * this.bounceIrradianceRatio) / bounceIrradiance)
        : 1
    this.patcher.setFillTrim(sideTrim, bounceTrim, !!this._sunLight)

    if (this._ambientAuto) {
      const hemiIrradiance = this._hemiLight
        ? this._hemiLight.intensity * colorLum(this._hemiLight.color)
        : 0
      // What is left of the budget after the IBL has taken its share, expressed
      // as a multiplier on the HemisphereLight that is already there. Clamped
      // to 1 so this can only ever trim, never boost — if world.js ever dials
      // its own ambient down below the budget, that is a decision, not an error
      // for this file to correct.
      this.patcher.ambientTrim =
        hemiIrradiance > 1e-4
          ? Math.min(1, Math.max(0, (target - iblTarget) / hemiIrradiance))
          : 1
    }

    if (this._sunAuto && this._sunLight) {
      this._lightDirection(this._sunLight, this._sunDirWorld)
    }
  }

  /**
   * Unit direction TOWARD `light`, world space, written into `out`.
   *
   * Local `position` rather than `matrixWorld`: the walk runs before the frame's
   * matrix update, so a world matrix read here can be a frame stale or, on the
   * very first frame, still identity — which would put every light at the origin
   * and classify the sun itself as a fill. Lights in this game are direct
   * children of the scene, so local and world are the same thing anyway.
   */
  _lightDirection(light, out) {
    const t = light.target
    out.copy(light.position).sub(t ? t.position : this._scratchDir.set(0, 0, 0))
    if (out.lengthSq() < 1e-8) out.set(-0.42, 0.46, 0.78)
    return out.normalize()
  }

  _visitObject(object) {
    // --- prepass exclusions -------------------------------------------------
    // The sky sphere must read as infinitely far, not as a surface 900 m away
    // wrapped around the player — a contact ray that hits it would shadow the
    // entire frame. Points/lines/sprites cannot be drawn with the prepass
    // override material meaningfully, and transparent geometry has no single
    // depth to write.
    const mat = object.material
    const transparent = Array.isArray(mat)
      ? mat.some((m) => m && m.transparent)
      : !!(mat && mat.transparent)
    if (
      object.name === 'sky' ||
      object.isPoints === true ||
      object.isLine === true ||
      object.isSprite === true ||
      transparent ||
      (object.userData && object.userData.scNoPrepass === true)
    ) {
      this._prepassHidden.push(object)
    }

    if (object.isDirectionalLight === true) {
      // Collected, not classified. The key is the one that casts — the fills
      // deliberately do not, and must not be mistaken for it or the contact
      // shadows point the wrong way across the whole level — but that decision
      // is made in _walk once the whole list exists.
      this._dirLights.push(object)
    } else if (object.isHemisphereLight === true) {
      if (!this._hemiLight) this._hemiLight = object
    }

    if (mat) {
      if (Array.isArray(mat)) {
        for (let i = 0; i < mat.length; i++) this.patcher.patch(mat[i])
      } else {
        this.patcher.patch(mat)
      }
    }
  }

  // ---------------------------------------------------------------- tunables

  /**
   * Relative vote of a sky texel in the exposure meter, 0..1. Lower = the
   * frame is exposed for its geometry and the sky is allowed to be bright.
   */
  get meterSkyWeight() { return this._meterSkyWeight }
  set meterSkyWeight(v) { this._meterSkyWeight = v }

  /** Stops of brightness on top of the meter. +1 = one stop brighter. */
  get exposureCompensation() {
    return this.exposure ? this.exposure.exposureCompensation : 0
  }
  set exposureCompensation(stops) {
    if (this.exposure) this.exposure.exposureCompensation = stops
  }

  /** Flat multiplier on the metered exposure — fades, flashbacks, damage hits. */
  get exposureScale() { return this._uLook.w }
  set exposureScale(v) { this._uLook.w = v }

  get bloomStrength() { return this._uGrade.x }
  set bloomStrength(v) { this._uGrade.x = v }

  get bloomThreshold() { return this.bloom.threshold }
  set bloomThreshold(v) { this.bloom.threshold = v }

  get lutStrength() { return this._uGrade.y }
  set lutStrength(v) { this._uGrade.y = v }

  get sharpen() { return this._uGrade.z }
  set sharpen(v) { this._uGrade.z = v }

  get chromaticAberration() { return this._uLens.x }
  set chromaticAberration(v) { this._uLens.x = v }

  get vignette() { return this._uLens.y }
  set vignette(v) { this._uLens.y = v }

  get grain() { return this._uLens.z }
  set grain(v) { this._uLens.z = v }

  // --- contact shadows -----------------------------------------------------

  /** Master switch. Reads false on a context that cannot support them. */
  get contactShadows() { return this._contactEnabled && this.contactSupported }
  set contactShadows(on) { this._contactEnabled = !!on }

  /** How much of the SUN term a full contact hit removes. 0..1. */
  get contactStrength() { return this.contact ? this.contact.strength : 0 }
  set contactStrength(v) { if (this.contact) this.contact.strength = v }

  /** World-space ray length in metres at 1x distance scaling. */
  get contactLength() { return this.contact ? this.contact.length : 0 }
  set contactLength(v) { if (this.contact) this.contact.length = v }

  /** Assumed thickness of an occluder, metres. Raise if shadows look hollow. */
  get contactThickness() { return this.contact ? this.contact.thickness : 0 }
  set contactThickness(v) { if (this.contact) this.contact.thickness = v }

  // --- ambient occlusion ---------------------------------------------------
  //
  // Shares the contact pass and its prepass. Two knobs: what the estimator
  // produces (intensity/radius, on the pass) and how much of it reaches the
  // shading (aoStrength, in the material).

  /** Estimator strength. 0 skips the AO taps entirely. */
  get aoIntensity() { return this.contact ? this.contact.aoIntensity : 0 }
  set aoIntensity(v) { if (this.contact) this.contact.aoIntensity = v }

  /** AO world radius, metres. Size it to the architecture, not to the screen. */
  get aoRadius() { return this.contact ? this.contact.aoRadius : 0 }
  set aoRadius(v) { if (this.contact) this.contact.aoRadius = v }

  /**
   * The short-radius tap set that draws interior corners. 0 disables it and
   * leaves only the broad architectural radius — which, measured, returns
   * "mostly open" at a 90-degree wall/floor junction. See contact.js.
   */
  get aoNearIntensity() { return this.contact ? this.contact.aoNearIntensity : 0 }
  set aoNearIntensity(v) { if (this.contact) this.contact.aoNearIntensity = v }

  /** Short-radius AO world radius, metres. */
  get aoNearRadius() { return this.contact ? this.contact.aoNearRadius : 0 }
  set aoNearRadius(v) { if (this.contact) this.contact.aoNearRadius = v }

  /** How much of the AO buffer is applied to the indirect terms. 0..1. */
  get aoStrength() { return this.patcher.aoStrength }
  set aoStrength(v) { this.patcher.aoStrength = v }

  // --- debug views ---------------------------------------------------------

  /**
   * 0 = normal output. 1 = contact-shadow visibility, 2 = AO, 3 = linear view
   * depth, 4 = prepass normals. Anything but 0 bypasses the whole display
   * transform — see scDebugView in composite.js for why.
   */
  get debugView() { return this.composite.uniforms.uDebug.value.x }
  set debugView(v) { this.composite.uniforms.uDebug.value.x = v | 0 }

  /**
   * One-call health report for the shading half of the chain, for the harness.
   *
   * Every field is read from the live object graph rather than from the options
   * that were requested, because the two disagreeing is the entire failure mode
   * this exists to catch.
   */
  shadingReport() {
    const tex = this.patcher.uniforms.scContactTex.value
    return {
      hdrSupported: this.hdrSupported,
      contactEnabled: this._contactEnabled,
      contactSupported: this.contactSupported,
      contactShadows: this.contactShadows,
      gbufferAllocated: !!(this.gbuffer && this.gbuffer.rt),
      gbufferSize: this.gbuffer ? [this.gbuffer.width, this.gbuffer.height] : null,
      contactTextureBound: !!tex,
      contactUniformArmed: this.patcher.uniforms.scFeat.value.x > 0.5,
      contactSize: this.contact && this.contact.rtA
        ? [this.contact.rtA.width, this.contact.rtA.height]
        : null,
      beautySize: [this._width, this._height],
      contactStrength: this.contactStrength,
      aoIntensity: this.aoIntensity,
      aoStrength: this.aoStrength,
      skyEnvOk: this.skyEnv ? this.skyEnv.ok : false,
      fillTrim: this.patcher.uniforms.scFill.value.toArray(),
      ambientTrim: this.patcher.ambientTrim,
      iblGain: this.patcher.iblGain,
      patchedMaterials: this.patcher.count,
    }
  }

  // --- ambient budget ------------------------------------------------------

  /** Direct multiplier on the sky IBL, on top of the measured budget. */
  get iblGain() { return this.patcher.iblGain }
  set iblGain(v) { this.patcher.iblGain = v }

  /**
   * Multiplier on the scene's HemisphereLight/AmbientLight. Setting this by
   * hand takes it off the automatic budget for the rest of the session.
   */
  get ambientTrim() { return this.patcher.ambientTrim }
  set ambientTrim(v) {
    this._ambientAuto = false
    this.patcher.ambientTrim = v
  }

  /** Re-arm the automatic 20% budget after a manual ambientTrim. */
  autoAmbient() {
    this._ambientAuto = true
    this._walkCountdown = 0
  }

  // --- sky -----------------------------------------------------------------

  /**
   * Pin the sun direction (unit, TOWARD the sun) instead of reading it off the
   * shadow-casting DirectionalLight. Call with no arguments to go back to auto.
   */
  setSunDirection(x, y, z) {
    if (x === undefined) {
      this._sunAuto = true
      this._walkCountdown = 0
      return
    }
    this._sunAuto = false
    this._sunDirWorld.set(x, y, z).normalize()
  }

  /** @param {object} c any subset of {zenith, horizon, sunHaze, cloud} as hex. */
  setSkyColors(c) {
    if (this.skyEnv) this.skyEnv.setColors(c)
  }

  /** @param {object} g any subset of {zenith, horizon, sunHaze, cloud} gains. */
  setSkyGains(g) {
    if (this.skyEnv) this.skyEnv.setGains(g)
  }

  /** 0 = sky warms only as much as the sun's real elevation says, 1 = full sunset. */
  get skyGoldenBias() { return this.skyEnv ? this.skyEnv.goldenBias : 0 }
  set skyGoldenBias(v) { if (this.skyEnv) this.skyEnv.setGoldenBias(v) }

  // --- aerial perspective --------------------------------------------------

  /** Haze density at the reference height, per metre. 0 disables the effect. */
  get aerialDensity() { return this.patcher.aerialDensity }
  set aerialDensity(v) { this.patcher.aerialDensity = v }

  /** Atmosphere scale height in metres — how fast the haze thins with altitude. */
  get aerialScaleHeight() { return this.patcher.aerialScaleHeight }
  set aerialScaleHeight(v) { this.patcher.aerialScaleHeight = v }

  /** World Y at which the density above is quoted. */
  get aerialReferenceHeight() { return this.patcher.aerialReferenceHeight }
  set aerialReferenceHeight(v) { this.patcher.aerialReferenceHeight = v }

  /** Brightness of the inscattered light. >1 makes distance LIGHTEN. */
  get aerialInscatter() { return this.patcher.aerialInscatter }
  set aerialInscatter(v) { this.patcher.aerialInscatter = v }

  /**
   * Floor on transmittance: the minimum fraction of its own colour a surface
   * keeps at any distance. This is what stops the far archipelago converging on
   * one value and reading as a wall of fog.
   */
  get aerialFloor() { return this.patcher.aerialFloor }
  set aerialFloor(v) { this.patcher.aerialFloor = v }

  /** Backlit silhouette rim strength, for separating distant islands from haze. */
  get aerialRim() { return this.patcher.aerialRim }
  set aerialRim(v) { this.patcher.aerialRim = v }

  /** Chroma restored at full haze — the counterweight to AgX's inset. */
  get aerialChroma() { return this.patcher.aerialChroma }
  set aerialChroma(v) { this.patcher.aerialChroma = v }

  // --- the warm/cool split -------------------------------------------------

  /**
   * Strength of the orientation-driven ambient tint: cool green-cyan on
   * sky-facing normals, warm cloud bounce on down-facing ones. 0 disables it.
   */
  get ambientSplit() { return this.patcher.ambientSplit }
  set ambientSplit(v) { this.patcher.ambientSplit = v }

  /** @param {number} hex sky-facing ambient tint, sRGB. Luminance-normalised. */
  setAmbientUpColor(hex) { this.patcher.setAmbientUpColor(hex) }

  /** @param {number} hex down-facing ambient tint, sRGB. Luminance-normalised. */
  setAmbientDownColor(hex) { this.patcher.setAmbientDownColor(hex) }

  /**
   * Re-point the haze's copy of the sky gradient.
   *
   * @param {object} c any subset of {zenith, horizon, deck, sun} as hex.
   *
   * This is the ONLY way to change what distance fades into, and it takes sky
   * colours rather than haze colours on purpose — see the block comment on
   * `scAerialPerspective` in patch.js. `setSkyColors` above changes the IBL's
   * copy; if you move one you almost certainly want to move all three (dome,
   * IBL, haze), and `skygrad.js` is where the dome's live.
   */
  setAerialSkyColors(c) {
    this.patcher.setSkyColors(c)
  }

  /** Colour of the forward-scatter lobe (hex, sRGB), pre-boost. */
  setAerialSunColor(hex, boost = 1.5) {
    this.patcher.uniforms.scHazeSun.value.set(hex).multiplyScalar(boost)
  }

  /** How far the inscatter departs from the sky down the solar azimuth. 0..1. */
  get aerialSunLobe() { return this.patcher.aerialSunLobe }
  set aerialSunLobe(v) { this.patcher.aerialSunLobe = v }

  /**
   * Per-channel extinction ratios. Blue > red makes distance warm; equal
   * channels makes it grey, which for this art direction is the failure mode.
   */
  setAerialExtinction(r, g, b) {
    this.patcher.uniforms.scAerialBeta.value.set(r, g, b)
  }

  /** Snap the exposure instead of adapting — respawn, teleport, level load. */
  resetExposure() {
    if (this.exposure) this.exposure.reset()
  }

  // ------------------------------------------------------------------- size

  /**
   * Resize every target.
   *
   * Accepts EITHER CSS pixels (the usual `window.innerWidth/innerHeight`, the
   * same thing you hand `renderer.setSize`) OR an already-multiplied
   * drawing-buffer size. Both are common in the wild and getting it wrong is a
   * silent 4x cost or a soft image, so we detect rather than assume: if the
   * incoming size already matches the canvas backing store, it is
   * device-pixel; otherwise multiply by the renderer's pixel ratio.
   */
  setSize(width, height) {
    const pr = this.renderer.getPixelRatio()
    const canvas = this.renderer.domElement
    const alreadyDevicePixels =
      Math.abs(width - canvas.width) <= 1 && Math.abs(height - canvas.height) <= 1

    let w = alreadyDevicePixels ? width : width * pr
    let h = alreadyDevicePixels ? height : height * pr

    w = Math.max(1, Math.round(w * this.renderScale))
    h = Math.max(1, Math.round(h * this.renderScale))

    if (w === this._width && h === this._height) return
    this._width = w
    this._height = h

    this.sceneTarget.setSize(w, h)
    this.bloom.setSize(w, h)
    this.composite.uniforms.uTexel.value.set(1 / w, 1 / h)
    // The prepass and the contact buffer are read by gl_FragCoord in the
    // material, so they MUST stay exactly the size of the beauty pass — a
    // half-resolution contact buffer here would offset every shadow by half a
    // frame's width, not soften it.
    if (this.gbuffer) this.gbuffer.setSize(w, h)
    if (this.contact) this.contact.setSize(w, h)
    this.patcher.setScreenSize(w, h)
  }

  /** Drawing-buffer size the chain is currently configured for. */
  getSize(target) {
    const out = target ?? new THREE.Vector2()
    return out.set(this._width, this._height)
  }

  // ----------------------------------------------------------------- render

  /**
   * Render one frame. `dt` is seconds since the last call and drives exposure
   * adaptation and the grain's temporal decorrelation.
   */
  render(dt = 1 / 60) {
    const renderer = this.renderer

    // Lazily size ourselves if the caller never did, so a missing setSize is a
    // correct frame rather than a 1x1 one.
    if (this._width <= 1 || this._height <= 1) {
      this.setSize(renderer.domElement.width, renderer.domElement.height)
    }

    this._time += dt

    // --- 0. scene walk (amortised) -----------------------------------------
    if (this._walkCountdown <= 0) {
      this._walk()
      // 60 frames ~ 1 second. New geometry picks up its patch within a second
      // of appearing, which is imperceptible, and the traverse cost disappears
      // into the noise.
      this._walkCountdown = 60
    }
    this._walkCountdown--

    // --- 0a. sky IBL -------------------------------------------------------
    // Internally a no-op unless the sun has actually moved (~0.8 degrees) or a
    // colour was changed. Never rebuilds per frame.
    if (this.skyEnv) {
      const envTex = this.skyEnv.update(this._sunDirWorld)
      if (envTex && this.scene.environment !== envTex) this.scene.environment = envTex
    }

    // renderer.render() would do this for us, but the prepass, the contact
    // march and the sun-direction rotation below all read the view matrix
    // BEFORE the first render call of the frame. Without this the contact
    // shadows lag the camera by a frame, which reads as them sliding across the
    // geometry whenever the player turns — and a parkour game turns constantly.
    // Allocation-free, and exactly what three does internally.
    this.camera.updateMatrixWorld()
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert()

    // The material only ever sees VIEW space, so the world sun direction is
    // rotated into it here, once, into a preallocated vector.
    this._sunDirView.copy(this._sunDirWorld).transformDirection(this.camera.matrixWorldInverse)
    this.patcher.uniforms.scSunDirView.value.copy(this._sunDirView)
    this.patcher.uniforms.scSunDirWorld.value.copy(this._sunDirWorld)

    // --- 0b. depth/normal prepass + contact shadows ------------------------
    // Both run BEFORE the beauty pass, because the beauty pass reads the
    // contact buffer inside the material. This is the whole reason contact
    // shadows are not a post-process: by the time you have a colour buffer, the
    // sun's contribution has already been added to the ambient and cannot be
    // attenuated on its own.
    const wantContact = this._contactEnabled && this.contactSupported && this.gbuffer && this.contact
    if (wantContact) {
      this.gbuffer.render(
        renderer,
        this.scene,
        this.camera,
        this._prepassHidden,
        this._prepassHiddenVis
      )
      const tex = this.contact.render(renderer, this.gbuffer, this.camera, this._sunDirView)
      this.patcher.setContactTexture(tex)
      this.patcher.setContactEnabled(true)
      this.composite.uniforms.tDebugContact.value = tex
      this.composite.uniforms.tDebugNormal.value = this.gbuffer.normalTexture
    } else {
      this.patcher.setContactEnabled(false)
    }

    // The meter's sky mask, from the prepass we just drew. Set every frame
    // rather than once, because `wantContact` can be toggled at runtime and a
    // meter still holding a stale coverage texture would reject the wrong
    // texels for as long as it stayed off.
    if (this.exposure) {
      this.exposure.setCoverage(
        wantContact ? this.gbuffer.normalTexture : null,
        this._meterSkyWeight
      )
    }

    // --- 1. scene -> HDR ---------------------------------------------------
    // Explicit clear: blit() leaves autoClear off, and relying on the caller's
    // autoClear state for the one pass that genuinely needs a depth clear is
    // how you get a frame of ghosting on the first resize.
    renderer.setRenderTarget(this.sceneTarget)
    renderer.clear(true, true, false)
    renderer.render(this.scene, this.camera)

    // --- 2. auto-exposure --------------------------------------------------
    let exposureTexture = this._fixedExposure
    if (this.exposure) {
      exposureTexture = this.exposure.update(
        renderer,
        this.sceneTarget.texture,
        this._width,
        this._height,
        dt
      )
    }

    // --- 3. bloom ----------------------------------------------------------
    const bloomTexture = this.bloom.render(
      renderer,
      this.sceneTarget.texture,
      this._width,
      this._height,
      exposureTexture
    )

    // --- 4. composite -> canvas -------------------------------------------
    const u = this.composite.uniforms
    u.tColor.value = this.sceneTarget.texture
    u.tBloom.value = bloomTexture
    u.tExposure.value = exposureTexture
    // Wrapped at 1024s: the grain hash multiplies time by ~137, and a float
    // that has been running for an hour has lost enough mantissa that the
    // noise visibly freezes into a static pattern.
    this._uLens.w = this._time % 1024

    blit(renderer, this.composite.material, null)
    renderer.setRenderTarget(null)
  }

  // ---------------------------------------------------------------- dispose

  dispose() {
    this.sceneTarget.dispose()
    if (this.exposure) this.exposure.dispose()
    this.bloom.dispose()
    this.composite.dispose()
    this.lut.texture.dispose()
    this._fixedExposure.dispose()
    if (this.gbuffer) this.gbuffer.dispose()
    if (this.contact) this.contact.dispose()
    if (this.skyEnv) {
      // Drop the environment we installed before disposing it, or the scene
      // holds a reference to a freed cube target and the next render throws.
      if (this.scene.environment === this.skyEnv.texture) this.scene.environment = null
      this.skyEnv.dispose()
    }
    this.patcher.dispose()
    // The full-screen triangle geometry is a module singleton shared with any
    // other pipeline instance, so it is deliberately NOT disposed here.
  }
}

export { GRADE, createGradeLut }
