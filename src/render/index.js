import * as THREE from 'three'
import { blit, detectHdrSupport, renderTarget } from './pass.js'
import { AutoExposure } from './exposure.js'
import { Bloom } from './bloom.js'
import { createGradeLut, GRADE } from './lut.js'
import { createComposite } from './composite.js'

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
    // The full-screen triangle geometry is a module singleton shared with any
    // other pipeline instance, so it is deliberately NOT disposed here.
  }
}

export { GRADE, createGradeLut }
