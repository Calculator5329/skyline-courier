import * as THREE from 'three'

/**
 * The brass cuff's line, and the anchor highlight.
 *
 * Two jobs, and the first one matters more than it sounds: **showing the
 * player what they can grab before they commit.** An ability whose targeting
 * is invisible feels unreliable even when it is working perfectly — that is
 * exactly how the air dash got reported as broken. So a valid anchor pulses
 * a brass ring the moment it comes into range and on-axis, and the reticle
 * changes at the same instant.
 *
 * Both halves used to be the cheapest thing that could possibly work: a
 * `THREE.Line` (one device pixel wide, whatever the distance) and a plain
 * `RingGeometry` in flat white. Captured in the actual game they read as a
 * stray hair across the sky and a HUD circle stuck to the world — nothing to
 * do with a world of machined brass. Both are now shaded quads instead:
 *
 *   - the line is a **tapered camera-facing ribbon** with a pulse of light
 *     running out along it, so it has thickness, direction and travel;
 *   - the highlight is a **clockwork sight** — a toothed cog ring with a
 *     counter-rotating inner dial that spins up and locks when the cuff bites.
 *
 * Neither costs anything worth measuring: one 28-triangle strip and one quad,
 * both with their motion computed in the fragment shader from a clock rather
 * than by touching geometry per frame.
 */

const SEGMENTS = 14

// Half-width of the cord in world units, at the cuff and at the anchor. A
// grapple line reads as *thrown* if it is fattest at the wrist and tapers
// away toward the thing it has bitten, the way a real thrown rope does.
const WIDTH_NEAR = 0.045
const WIDTH_FAR = 0.016

const LINE_VERT = /* glsl */`
  attribute float aT;      // 0 at the cuff, 1 at the anchor
  attribute float aSide;   // -1 / +1 across the ribbon
  varying float vT;
  varying float vSide;
  void main() {
    vT = aT;
    vSide = aSide;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const LINE_FRAG = /* glsl */`
  precision mediump float;
  varying float vT;
  varying float vSide;
  uniform float uTime;
  uniform float uOpacity;

  void main() {
    // Soft edges across the cord. A hard-edged additive strip aliases into a
    // dashed line the moment it goes near-vertical on screen.
    float across = 1.0 - vSide * vSide;
    across *= across;

    // A pulse of light running from the cuff out to the anchor. This is the
    // whole reason the line reads as powered rather than drawn: the eye picks
    // up the direction of travel long before it picks up the geometry.
    float ph = fract(uTime * 1.7);
    float d = vT - ph;
    float pulse = exp(-45.0 * d * d);

    // Brighter at the anchor end, so the eye is pulled to the thing you are
    // about to be dragged toward rather than to your own wrist.
    float along = 0.55 + 0.45 * vT;

    // Heavily biased away from neutral: additive light over a pale golden sky
    // tone-maps toward white long before it clips, so a cord mixed at what
    // looks like brass in a swatch arrives on screen as a white cable.
    vec3 brass = vec3(1.50, 0.62, 0.16) * along;
    vec3 hot = vec3(2.60, 1.70, 0.85) * pulse;
    gl_FragColor = vec4(brass + hot, (along + pulse * 0.8) * across * uOpacity);
  }
`

const RING_FRAG = /* glsl */`
  precision mediump float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uLock;     // 0 = in range, 1 = latched

  float band(float r, float centre, float w) {
    return smoothstep(w, 0.0, abs(r - centre));
  }

  void main() {
    vec2 p = vUv - 0.5;
    float r = length(p) * 2.0;
    float a = atan(p.y, p.x);

    // Two rates, counter-rotating. One spinning ring is a loading spinner;
    // two at different rates and opposite senses is a machine.
    float spin = uTime * (0.55 + uLock * 3.2);

    // Main hoop.
    float m = band(r, 0.50, 0.045) * 0.9;

    // Twelve cog teeth stood off the outside of the hoop.
    float tooth = fract((a + spin) * 1.9098593);       // 12 / 2pi
    float toothOn = smoothstep(0.28, 0.40, tooth) * smoothstep(0.74, 0.62, tooth);
    m += toothOn * band(r, 0.60, 0.055);

    // Counter-rotating inner dial, finer pitch.
    float tick = fract((a - spin * 0.62) * 3.8197186); // 24 / 2pi
    float tickOn = smoothstep(0.18, 0.34, tick) * smoothstep(0.82, 0.66, tick);
    m += tickOn * band(r, 0.30, 0.030) * 0.75;

    // Four cardinal sight marks that swing in as the cuff bites, so "in range"
    // and "latched" are different pictures and not just different brightnesses.
    float cardinal = abs(cos(a * 2.0));
    m += pow(cardinal, 40.0) * band(r, 0.74 - uLock * 0.10, 0.05) * (0.35 + uLock);

    // Breathing, and a hard flash on the frame it locks.
    float breathe = 0.78 + 0.22 * sin(uTime * 4.6);
    // Brass, not white. Pushed well down in green and blue because the sight
    // is additive over a bright hazy sky and anything near neutral tone-maps
    // straight to white, which is the one colour this world does not use.
    vec3 col = mix(vec3(1.15, 0.52, 0.13), vec3(2.2, 1.45, 0.60), uLock);

    gl_FragColor = vec4(col, m * breathe * uOpacity);
  }
`

const RING_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export class GrappleFX {
  constructor(scene) {
    // --- the line ---------------------------------------------------------
    // Two vertices per segment, walked as a triangle strip. Positions are
    // rewritten every frame (the ribbon has to face the camera and the cuff
    // moves with the head); the parameterisation along and across it never
    // changes, so both of those attributes are uploaded exactly once.
    const geo = new THREE.BufferGeometry()
    this._pts = new Float32Array((SEGMENTS + 1) * 2 * 3)
    const along = new Float32Array((SEGMENTS + 1) * 2)
    const side = new Float32Array((SEGMENTS + 1) * 2)
    const index = new Uint16Array(SEGMENTS * 6)
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS
      along[i * 2] = t; along[i * 2 + 1] = t
      side[i * 2] = -1; side[i * 2 + 1] = 1
      if (i < SEGMENTS) {
        const v = i * 2, o = i * 6
        index[o] = v; index[o + 1] = v + 1; index[o + 2] = v + 2
        index[o + 3] = v + 1; index[o + 4] = v + 3; index[o + 5] = v + 2
      }
    }
    const posAttr = new THREE.BufferAttribute(this._pts, 3)
    posAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', posAttr)
    geo.setAttribute('aT', new THREE.BufferAttribute(along, 1))
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
    geo.setIndex(new THREE.BufferAttribute(index, 1))
    // The cord is rebuilt in world space every frame, so a bounding volume
    // computed from the buffer would always be a frame stale — and a stale one
    // culls the line exactly when the player swings hardest.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

    this.lineMat = new THREE.ShaderMaterial({
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
    this.line = new THREE.Mesh(geo, this.lineMat)
    this.line.frustumCulled = false
    this.line.name = 'grapple-line'
    scene.add(this.line)

    // --- the anchor highlight ---------------------------------------------
    // A flat quad that always faces the player, sized in world units so it
    // shrinks with distance and therefore reads as attached to the anchor
    // rather than painted on the screen.
    this.ringMat = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uLock: { value: 0 } },
      transparent: true,
      depthWrite: false,
      // Deliberately drawn through geometry: this is a targeting aid, and an
      // anchor half-occluded by the ledge in front of it is the case where the
      // player most needs to know it is there.
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), this.ringMat)
    this.ring.frustumCulled = false
    this.ring.renderOrder = 999
    this.ring.name = 'grapple-ring'
    scene.add(this.ring)

    this._extend = 0
    this._time = 0
    this._lock = 0
    this._v = new THREE.Vector3()
    this._dir = new THREE.Vector3()
    this._side = new THREE.Vector3()
    this._toCam = new THREE.Vector3()
  }

  update(dt, player, camera) {
    const h = Math.min(dt, 1 / 30)
    this._time += h
    this.lineMat.uniforms.uTime.value = this._time
    this.ringMat.uniforms.uTime.value = this._time

    // --- anchor highlight -------------------------------------------------
    // The latched anchor keeps its ring: losing the sight the instant the cuff
    // bites throws away the confirmation at the exact moment it is earned.
    const aimed = player.grappling ? player.grappleAnchor : player.aimedAnchor
    const ringU = this.ringMat.uniforms
    this._lock += ((player.grappling ? 1 : 0) - this._lock) * (1 - Math.exp(-18 * h))
    ringU.uLock.value = this._lock

    if (aimed) {
      this.ring.position.copy(aimed)
      this.ring.quaternion.copy(camera.quaternion)   // billboard
      ringU.uOpacity.value += (1 - ringU.uOpacity.value) * (1 - Math.exp(-14 * h))
      // Snaps in a little tighter on the bite — the size change is what makes
      // the lock feel like a mechanism closing rather than a colour swap.
      this.ring.scale.setScalar(1 - this._lock * 0.18)
      this.ring.visible = true
    } else {
      ringU.uOpacity.value *= Math.exp(-16 * h)
      this.ring.visible = ringU.uOpacity.value > 0.01
    }

    // --- the line ---------------------------------------------------------
    const lineU = this.lineMat.uniforms
    if (player.grappling) {
      // Snap out fast, but not instantly — a line that simply *is* there
      // reads as a UI element, while one that travels reads as a thrown
      // object with weight.
      this._extend += (1 - this._extend) * (1 - Math.exp(-26 * h))
      lineU.uOpacity.value += (1 - lineU.uOpacity.value) * (1 - Math.exp(-24 * h))
    } else {
      this._extend *= Math.exp(-22 * h)
      lineU.uOpacity.value *= Math.exp(-13 * h)
    }
    this.line.visible = lineU.uOpacity.value > 0.02
    if (!this.line.visible) return

    // Origin at the lower-right of the view — the cuff is on that wrist, and
    // a line from dead centre would sit under the reticle and hide the target.
    this._v.set(0.28, -0.22, -0.45).applyQuaternion(camera.quaternion).add(camera.position)
    const target = player.grappleAnchor

    // One side vector for the whole cord. The line is close enough to straight
    // that per-segment framing would cost fourteen cross products to produce a
    // ribbon nobody could tell apart from this one.
    this._dir.copy(target).sub(this._v)
    this._toCam.copy(camera.position).sub(this._v)
    this._side.copy(this._dir).cross(this._toCam)
    const sl = this._side.length()
    // Degenerate when the cord points straight at the eye — which happens the
    // moment you look along your own line. Any perpendicular will do there,
    // because the ribbon is edge-on and effectively invisible anyway.
    if (sl > 1e-4) this._side.divideScalar(sl)
    else this._side.set(0, 1, 0)

    // Sag falls away as the line goes taut under acceleration.
    const slack = (1 - this._extend) * 1.4 + 0.35
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = (i / SEGMENTS) * this._extend
      const droop = Math.sin(t * Math.PI) * slack
      const w = WIDTH_NEAR + (WIDTH_FAR - WIDTH_NEAR) * t
      const x = this._v.x + (target.x - this._v.x) * t
      const y = this._v.y + (target.y - this._v.y) * t - droop
      const z = this._v.z + (target.z - this._v.z) * t
      const o = i * 6
      this._pts[o] = x - this._side.x * w
      this._pts[o + 1] = y - this._side.y * w
      this._pts[o + 2] = z - this._side.z * w
      this._pts[o + 3] = x + this._side.x * w
      this._pts[o + 4] = y + this._side.y * w
      this._pts[o + 5] = z + this._side.z * w
    }
    this.line.geometry.attributes.position.needsUpdate = true
  }

  dispose() {
    this.line.geometry.dispose()
    this.lineMat.dispose()
    this.ring.geometry.dispose()
    this.ringMat.dispose()
  }
}
