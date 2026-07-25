import * as THREE from 'three'

/**
 * Static collision world: axis-aligned boxes only.
 *
 * This is a deliberate constraint, not a shortcut. Wall-running and vaulting
 * need collision that is *predictable* far more than they need to be general —
 * a player has to be able to trust that a brass wall behaves the same way
 * every single time they throw themselves at it. A triangle-soup BVH is on the
 * roadmap for the capability phase; it is not an upgrade for the game.
 *
 * The player is a vertical capsule, which makes the closest-point query
 * against an AABB exact and cheap: the problem separates per axis.
 */

const _seg = new THREE.Vector3()
const _box = new THREE.Vector3()
const _delta = new THREE.Vector3()

export class Contact {
  constructor() {
    this.normal = new THREE.Vector3()
    this.depth = 0
    this.top = 0
    this.tag = ''
  }
}

export class CollisionWorld {
  constructor() {
    /** @type {{min: THREE.Vector3, max: THREE.Vector3, tag: string}[]} */
    this.boxes = []
    // Reused contact objects — the resolve path runs a few dozen times a frame
    // and must not allocate.
    this._pool = Array.from({ length: 16 }, () => new Contact())
  }

  addBox(min, max, tag = '') {
    this.boxes.push({ min: min.clone(), max: max.clone(), tag })
  }

  /** Convenience: centre + size, matching how level.js declares geometry. */
  addCenteredBox(cx, cy, cz, sx, sy, sz, tag = '') {
    this.addBox(
      new THREE.Vector3(cx - sx / 2, cy - sy / 2, cz - sz / 2),
      new THREE.Vector3(cx + sx / 2, cy + sy / 2, cz + sz / 2),
      tag,
    )
  }

  /**
   * Collect every contact between the capsule and the world.
   *
   * @param pos    feet position (bottom centre of the capsule)
   * @param radius capsule radius
   * @param height total capsule height, feet to crown
   * @returns array of live Contact objects (owned by the pool — consume before
   *          the next resolve call)
   */
  resolve(pos, radius, height, out = []) {
    out.length = 0

    // Capsule axis endpoints: the segment between the two sphere centres.
    const y0 = pos.y + radius
    const y1 = pos.y + height - radius
    // Broadphase bounds for the whole capsule.
    const bx0 = pos.x - radius, bx1 = pos.x + radius
    const bz0 = pos.z - radius, bz1 = pos.z + radius
    const by0 = pos.y, by1 = pos.y + height

    let n = 0
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i]
      const min = b.min, max = b.max

      // Cheap reject before any real work.
      if (max.x < bx0 || min.x > bx1) continue
      if (max.y < by0 || min.y > by1) continue
      if (max.z < bz0 || min.z > bz1) continue

      // Closest point on the box to the capsule axis, solved per axis.
      const cx = clamp(pos.x, min.x, max.x)
      const cz = clamp(pos.z, min.z, max.z)

      // Y is the only axis where the capsule has extent, so it needs the
      // overlap test rather than a plain clamp.
      let sy, cy
      const loY = Math.max(y0, min.y)
      const hiY = Math.min(y1, max.y)
      if (loY <= hiY) {
        sy = cy = (loY + hiY) * 0.5   // axis overlaps the box in Y
      } else if (y1 < min.y) {
        sy = y1; cy = min.y           // capsule entirely below
      } else {
        sy = y0; cy = max.y           // capsule entirely above
      }

      _seg.set(pos.x, sy, pos.z)
      _box.set(cx, cy, cz)
      _delta.subVectors(_seg, _box)

      const distSq = _delta.lengthSq()
      if (distSq >= radius * radius) continue

      if (n >= this._pool.length) this._pool.push(new Contact())
      const c = this._pool[n++]
      c.tag = b.tag
      c.top = max.y

      if (distSq > 1e-8) {
        const dist = Math.sqrt(distSq)
        c.normal.copy(_delta).divideScalar(dist)
        c.depth = radius - dist
      } else {
        // Axis is inside the box: escape along the shallowest face.
        this._deepestEscape(_seg, min, max, radius, c)
      }
      out.push(c)
    }
    return out
  }

  /** Minimum-translation escape when the capsule axis is inside a box. */
  _deepestEscape(p, min, max, radius, c) {
    const dxMin = p.x - min.x, dxMax = max.x - p.x
    const dyMin = p.y - min.y, dyMax = max.y - p.y
    const dzMin = p.z - min.z, dzMax = max.z - p.z

    let best = dxMin, nx = -1, ny = 0, nz = 0
    if (dxMax < best) { best = dxMax; nx = 1; ny = 0; nz = 0 }
    if (dyMin < best) { best = dyMin; nx = 0; ny = -1; nz = 0 }
    if (dyMax < best) { best = dyMax; nx = 0; ny = 1; nz = 0 }
    if (dzMin < best) { best = dzMin; nx = 0; ny = 0; nz = -1 }
    if (dzMax < best) { best = dzMax; nx = 0; ny = 0; nz = 1 }

    c.normal.set(nx, ny, nz)
    c.depth = best + radius
  }

  /** True if the capsule would be free-standing at `pos`. Used by vaulting. */
  isClear(pos, radius, height, scratch = []) {
    return this.resolve(pos, radius, height, scratch).length === 0
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}
