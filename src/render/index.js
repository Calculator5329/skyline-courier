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
    this.exposure = this.hdrSupported ? new AutoExposure(this._type) : null

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
    if (!this.hdrSupported) {
      // In an LDR buffer nothing can exceed 1.0, so a threshold at 1.05 would
      // never fire. 0.72 picks out the lanterns and the sun-facing brass, which
      // is the intent of the effect, at the cost of a little glow on bright
      // diffuse surfaces.
      this.bloom.threshold = 0.72
      this.bloom.knee = 0.25
    }

    // --- grade + composite -------------------------------------------------
    this.lut = createGradeLut(options.grade ?? GRADE)
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

    /** Analytic sunset sky through PMREM -> scene.environment. */
    this.skyEnv = this.hdrSupported ? new SkyEnvironment(renderer, options.sky) : null

    /**
     * THE 20% RULE, as a budget rather than a magic number.
     *
     * Total indirect irradiance on an up-facing surface is held at
     * `skyIrradianceRatio` of the sun's irradiance, and split between the sky
     * IBL and the scene's existing HemisphereLight by `iblShare`. Both numbers
     * are measured off the actual lights during the scene walk, so changing the
     * sun's intensity in world.js moves the ambient with it automatically and
     * the ratio holds.
     */
    this.skyIrradianceRatio = options.skyIrradianceRatio ?? 0.2
    /**
     * 0.75 to the IBL. The IBL is the half that carries DIRECTION — gold on the
     * sun side, cool green at the zenith, bright cloud deck underneath — and
     * that split is the look. The HemisphereLight keeps a quarter because it is
     * the only ambient that reaches materials this pipeline has not patched.
     */
    this.iblShare = options.iblShare ?? 0.75
    this._ambientAuto = true

    // --- scene walk state --------------------------------------------------
    // Rebuilt periodically rather than per frame; see _walk().
    this._walkCountdown = 0
    this._prepassHidden = []
    this._prepassHiddenVis = []
    this._sunLight = null
    this._hemiLight = null
    this._sunAuto = true
    this._sunDirWorld = new THREE.Vector3(-0.42, 0.46, 0.78).normalize()
    this._sunDirView = new THREE.Vector3(0, 1, 0)
    this._scratchDir = new THREE.Vector3()
    // Bound once so scene.traverse() allocates no closure per frame.
    this._visit = (object) => this._visitObject(object)
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
    this._sunLight = null
    this._hemiLight = null
    this.scene.traverse(this._visit)

    // --- the ambient budget -------------------------------------------------
    const sunIrradiance = this._sunLight
      ? this._sunLight.intensity * colorLum(this._sunLight.color)
      : 2.5
    const target = sunIrradiance * this.skyIrradianceRatio
    const iblTarget = target * this.iblShare
    if (this.skyEnv) this.skyEnv.setIrradiance(iblTarget)

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
      const t = this._sunLight.target
      this._sunDirWorld
        .copy(this._sunLight.position)
        .sub(t ? t.position : this._scratchDir.set(0, 0, 0))
      if (this._sunDirWorld.lengthSq() < 1e-8) this._sunDirWorld.set(-0.42, 0.46, 0.78)
      this._sunDirWorld.normalize()
    }
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
      // The sun is the one that casts. The fill light deliberately does not,
      // and must not be mistaken for the key or the contact shadows point the
      // wrong way across the whole level.
      if (object.castShadow && !this._sunLight) this._sunLight = object
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

  /** Haze colour away from the sun (hex, sRGB). Match the sky's horizon band. */
  setAerialColor(hex) {
    this.patcher.uniforms.scHaze.value.set(hex)
  }

  /** Haze colour looking INTO the sun (hex, sRGB), pre-boost. */
  setAerialSunColor(hex, boost = 1.55) {
    this.patcher.uniforms.scHazeSun.value.set(hex).multiplyScalar(boost)
  }

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
    } else {
      this.patcher.setContactEnabled(false)
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
