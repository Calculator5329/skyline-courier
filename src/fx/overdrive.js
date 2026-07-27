import * as THREE from 'three'
import { getTheme } from '../theme.js'

/**
 * The OVERDRIVE layer — the look of a speed band above the cap, running out.
 *
 * This is deliberately NOT the speed layer (src/fx/speed.js). That effect sells
 * "fast": warm radial streaks and a tightening vignette out at the edge of
 * vision, keyed off how quick you are going. It says more-of-the-same the
 * faster you move. Overdrive is a different statement — "you are PAST the cap
 * and it is DRAINING" — so it is built on three axes the speed layer is not:
 *
 *   COLD, NOT WARM. A hard electric cyan-white, chosen so it reads on BOTH
 *   themes: it pops against golden Skyline and it is distinct from the void's
 *   violet beams (a warm effect would vanish on the golden background and a
 *   violet one would drown among the void's verticals). The whole point is that
 *   the frame changes TEMPERATURE when you cross the cap, not just intensity.
 *
 *   A RIM, NOT A FIELD. Everything lives in a thin frame hugging the screen
 *   border. The centre stays perfectly clear — overdrive happens at the exact
 *   moment the player most needs to read the next platform, so the effect may
 *   never cover it. A border is the one shape that screams "engaged" while
 *   touching none of the middle.
 *
 *   IT DRAINS. Rim thickness and brightness track the band directly, so as
 *   overdrive decays the frame visibly recedes — the player feels the band
 *   emptying without reading a number. A travelling pulse runs the rim, and it
 *   speeds UP as the band runs low, which reads as urgency: the "hurry, it's
 *   going" cue. Entry punches a one-off flash so crossing the cap has a moment.
 *
 * One extra full-screen triangle, a cheap shader, no depth interaction. It is
 * rendered by SpeedFX after the speed overlay so it composites on top — see the
 * call site in src/fx/speed.js. Instantiated there rather than in main.js so it
 * is guaranteed to be driven every frame by a layer that already is.
 */

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;

  uniform float uTime;
  uniform float uAmt;     // 0..1, the live band — drives thickness AND brightness
  uniform float uFlash;   // 0..1, one-off entry punch
  uniform float uAspect;
  uniform vec3  uColor;
  uniform vec3  uHot;     // near-white core colour at the very edge

  void main() {
    // Distance to the nearest screen edge, in a space where x is aspect-
    // corrected so the rim is the same physical thickness top/bottom and
    // left/right rather than stretched on a wide monitor.
    float ax = (0.5 - abs(vUv.x - 0.5)) * uAspect;
    float ay = (0.5 - abs(vUv.y - 0.5));
    float edge = min(ax, ay);

    float amt = clamp(uAmt, 0.0, 1.0);
    // The rim thickens with the band. At full it reaches ~14% of the half-
    // height in from the border; drained it is a hairline. The centre — well
    // inside this — is never touched, which is the hard constraint.
    float width = 0.03 + 0.11 * amt + 0.05 * uFlash;

    // Two bands: a soft glow bleeding inward from the border, and a bright
    // hairline right at the very edge that gives the frame a hard lit lip.
    float glow = smoothstep(width, 0.0, edge);
    glow *= glow;                               // bias the light toward the edge
    float lip = smoothstep(0.012, 0.0, edge);

    // A pulse travelling around the perimeter. 'perim' is a coordinate that
    // runs continuously along the border; the sine sweeps along it so the rim
    // has moving energy rather than being a static outline. The pulse rate
    // RISES as the band drains (2..7 Hz-ish), which is the "running out" read.
    float perim = (ax < ay) ? vUv.y * 3.0 : vUv.x * 3.0 * uAspect;
    float rate = mix(7.0, 2.5, amt);
    float pulse = 0.6 + 0.4 * sin((perim * 6.0) - uTime * rate * 6.2831853);

    // Corners run a touch hotter, which reads as a targeting frame snapping on
    // — reinforcing "past the cap" over "merely fast". 'min(ax,ay)' is small
    // only near a corner (both edges close at once), so this lights the four
    // corners and nothing else.
    float cornerBoost = smoothstep(0.22, 0.0, min(ax, ay)) * 0.5;

    float body = glow * (0.65 + 0.35 * pulse) * (1.0 + cornerBoost);
    // The entry flash floods the whole rim bright for a beat, independent of
    // the pulse, so engaging the band lands as an event.
    body += glow * uFlash * 1.4;

    float amount = (body + lip * (0.8 + uFlash)) * (0.35 + 0.65 * amt + uFlash);

    // Colour: the cold rim, with the near-white core showing through at the lit
    // lip and under the flash, so the very edge burns hot while the inward glow
    // stays a clean cyan.
    vec3 col = mix(uColor, uHot, clamp(lip + uFlash * 0.6, 0.0, 1.0));
    float alpha = clamp(amount, 0.0, 1.0);

    gl_FragColor = vec4(col * amount, alpha);
  }
`

/** One themed overdrive colour, cold by default so it reads on either theme. */
function overdriveColor(key, fallback) {
  try {
    const t = getTheme()
    const v = t && t.accents && t.accents[key]
    return v == null ? fallback : v
  } catch { return fallback }
}

export class OverdriveFX {
  constructor() {
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    // A single full-screen triangle — one draw, no diagonal seam.
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2))

    this.uniforms = {
      uTime: { value: 0 },
      uAmt: { value: 0 },
      uFlash: { value: 0 },
      uAspect: { value: 1 },
      // Cold electric cyan and a near-white core. Optional theme overrides
      // (`accents.overdrive` / `accents.overdriveHot`) if a theme ever wants to
      // tune the temperature; the defaults already read on both shipped themes.
      uColor: { value: new THREE.Color(overdriveColor('overdrive', 0x39c6ff)) },
      uHot: { value: new THREE.Color(overdriveColor('overdriveHot', 0xd6f4ff)) },
    }

    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // Additive: the rim is light being added to the frame, so it glows on the
      // near-black void without punching a dark box, and burns bright on gold.
      blending: THREE.AdditiveBlending,
    }))
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)

    this.time = 0
    this._amt = 0
    this._flash = 0
    this._prevOd = 0
  }

  setSize(width, height) {
    this.uniforms.uAspect.value = width / height
  }

  /**
   * Drive the rim from `player.overdrive`.
   *
   * The displayed amount follows the band directly (so the drain is visible
   * frame for frame), but a fresh entry — a step up in `overdrive` — punches a
   * flash that decays on its own faster clock, so engaging the band pops.
   */
  update(dt, player) {
    const h = Math.min(dt, 1 / 30)
    this.time += h
    this.uniforms.uTime.value = this.time

    const od = player.overdrive || 0
    // A step up in the band is a fresh entry (decay only ever lowers it): flash.
    if (od > this._prevOd + 0.15) this._flash = 1
    this._prevOd = od

    // Follow the band almost directly, easing a hair so the onset is not a hard
    // switch. The band itself is already the authored decay curve.
    this._amt += (od - this._amt) * (1 - Math.exp(-14 * h))
    this._flash *= Math.exp(-6 * h)
    this.uniforms.uAmt.value = this._amt
    this.uniforms.uFlash.value = this._flash
  }

  /** Draw the rim. Called by SpeedFX.render, after the speed overlay. */
  render(renderer) {
    // Below a floor the rim is a handful of invisible pixels costing a draw —
    // skip it so a run that never touches overdrive pays nothing.
    if (this._amt < 0.004 && this._flash < 0.004) return
    const prevAutoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.render(this.scene, this.camera)
    renderer.autoClear = prevAutoClear
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
