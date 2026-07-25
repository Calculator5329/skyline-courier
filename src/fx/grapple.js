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
 * The line itself is a taut brass cord that snaps out over a couple of frames
 * rather than appearing instantly, with a slight sag that tightens as you
 * accelerate along it.
 */

const SEGMENTS = 14

export class GrappleFX {
  constructor(scene) {
    // --- the line ---------------------------------------------------------
    const geo = new THREE.BufferGeometry()
    this._pts = new Float32Array((SEGMENTS + 1) * 3)
    geo.setAttribute('position', new THREE.BufferAttribute(this._pts, 3))
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0xffd28a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }))
    this.line.frustumCulled = false
    this.line.name = 'grapple-line'
    scene.add(this.line)

    // --- the anchor highlight ---------------------------------------------
    // A flat ring that always faces the player, sized in world units so it
    // shrinks with distance and therefore reads as attached to the anchor
    // rather than painted on the screen.
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.72, 28),
      new THREE.MeshBasicMaterial({
        color: 0xffc978,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    )
    this.ring.frustumCulled = false
    this.ring.renderOrder = 999
    this.ring.name = 'grapple-ring'
    scene.add(this.ring)

    this._extend = 0
    this._ringPulse = 0
    this._v = new THREE.Vector3()
    this._sag = new THREE.Vector3()
  }

  update(dt, player, camera) {
    const h = Math.min(dt, 1 / 30)

    // --- anchor highlight -------------------------------------------------
    const aimed = player.aimedAnchor
    const ringMat = this.ring.material
    if (aimed) {
      this._ringPulse += h * 4.2
      this.ring.position.copy(aimed)
      this.ring.quaternion.copy(camera.quaternion)   // billboard
      const pulse = 0.72 + 0.28 * Math.sin(this._ringPulse)
      ringMat.opacity += (pulse - ringMat.opacity) * (1 - Math.exp(-14 * h))
      const s = 1 + 0.10 * Math.sin(this._ringPulse * 1.3)
      this.ring.scale.setScalar(s)
      this.ring.visible = true
    } else {
      ringMat.opacity *= Math.exp(-16 * h)
      this.ring.visible = ringMat.opacity > 0.01
    }

    // --- the line ---------------------------------------------------------
    const mat = this.line.material
    if (player.grappling) {
      // Snap out fast, but not instantly — a line that simply *is* there
      // reads as a UI element, while one that travels reads as a thrown
      // object with weight.
      this._extend += (1 - this._extend) * (1 - Math.exp(-26 * h))
      mat.opacity += (0.95 - mat.opacity) * (1 - Math.exp(-24 * h))
    } else {
      this._extend *= Math.exp(-22 * h)
      mat.opacity *= Math.exp(-13 * h)
    }
    this.line.visible = mat.opacity > 0.02
    if (!this.line.visible) return

    // Origin at the lower-right of the view — the cuff is on that wrist, and
    // a line from dead centre would sit under the reticle and hide the target.
    this._v.set(0.28, -0.22, -0.45).applyQuaternion(camera.quaternion).add(camera.position)
    const target = player.grappleAnchor

    // Sag falls away as the line goes taut under acceleration.
    const slack = (1 - this._extend) * 1.4 + 0.35
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = (i / SEGMENTS) * this._extend
      const i3 = i * 3
      const droop = Math.sin(t * Math.PI) * slack
      this._pts[i3] = this._v.x + (target.x - this._v.x) * t
      this._pts[i3 + 1] = this._v.y + (target.y - this._v.y) * t - droop
      this._pts[i3 + 2] = this._v.z + (target.z - this._v.z) * t
    }
    this.line.geometry.attributes.position.needsUpdate = true
  }

  dispose() {
    this.line.geometry.dispose()
    this.line.material.dispose()
    this.ring.geometry.dispose()
    this.ring.material.dispose()
  }
}
