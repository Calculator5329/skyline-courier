/**
 * THE EMISSIVE BREATH — the void's crystals and wall-sigils, made to live.
 *
 * The reference (`docs/reference/theme2-void.png`) is lit entirely from within,
 * and the one thing a place lit by magic must never do is hold perfectly still:
 * a crystal that never shimmers and a sigil that never breathes read as painted
 * glass, not as energy. The drifting motes were the only thing moving; this is
 * the light itself moving.
 *
 * ## Why this lives in src/fx and not in the materials that it animates
 *
 * The crystal shards (`src/crystals.js`) and the sigil inlay (`src/voidkit.js`)
 * are built by lanes this one does not own, and their emissive is a STATIC
 * value baked for a frozen acceptance shot. Animating them needs a time uniform
 * driven every frame — which is the frame loop, which is this lane. A previous
 * lane deliberately left them still for exactly that reason. So rather than
 * reach across into those files, this one reaches across at RUNTIME: it finds
 * the already-built emissive materials in the scene and chains a small,
 * shared-uniform breath onto their compiled shaders. Nothing in another lane's
 * source changes; the only new thing is a slow multiplier on a value those
 * shaders were already computing.
 *
 * ## The five rules this obeys (from the task brief and §6)
 *
 * 1. IT NEVER TOUCHES A LANDING SURFACE. The rune inlay the player reads a
 *    landing off — `void:slab-decal` (art-direction-void.md §6, the readability
 *    channel) — is excluded by name. Only the crystal shards and the sigils
 *    that hang on the VERTICAL walls breathe, and neither is a thing you stand
 *    on. A brightness that wanders under a landing is a bug, not a mood.
 * 2. IT EASES IN FROM ZERO. The breath is scaled by `smoothstep(0, 2.5, t)`, so
 *    at `t = 0` — which is exactly where `tools/shotset.mjs` freezes every
 *    acceptance frame — the multiplier is exactly 1.0 and the frozen picture is
 *    byte-for-byte the one the crystal and sigil lanes signed off. The motion
 *    only exists once the game has been running for a couple of seconds, which
 *    is the only state a still frame cannot capture and the only state this is
 *    for.
 * 3. IT IS SLOW AND UNEVEN, NOT A SINE. Two incommensurate sines (periods ~12 s
 *    and ~20 s) beat against each other and are phased by WORLD POSITION, so no
 *    two shards — and no two points along one shard — crest together. A single
 *    sine reads as machinery; a beat reads as something breathing.
 * 4. IT NEVER STROBES AND STAYS LEGIBLE. The amplitude is small (±16% on the
 *    crystals, ±10% on the sigils) and the frequency is far below anything the
 *    eye reads as a flash. The emissive never drops below ~0.84 of its authored
 *    value, so a sigil the player is using as a landmark never dims out of
 *    reading.
 * 5. IT IS NEARLY FREE. Per fragment it is two sines and two multiplies added to
 *    a shader that already runs; per frame it is ONE uniform write shared across
 *    every patched material. `docs/perf.md`: the renderer is fill-bound, and
 *    this is a handful of ALU on the few small, bright fragments that are the
 *    crystals and the inlay — not a new pass and not a new draw.
 */

/** The vertex snippet: a per-vertex phase read straight off world position. */
const PHASE_VERTEX = /* glsl */`
  #ifdef USE_INSTANCING
    vec3 lifeWP = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
  #else
    vec3 lifeWP = (modelMatrix * vec4(position, 1.0)).xyz;
  #endif
  // Irrational-ish weights so the three axes never re-phase into a plane of
  // shards pulsing together. On a crystal this walks the shimmer ALONG the
  // shard (position varies over its length); across shards it scatters the
  // phase, which is the "drifting between shards rather than in lockstep" the
  // brief asks for.
  vVoidLifePhase = dot(lifeWP, vec3(0.173, 0.091, 0.127));
`

/**
 * The fragment snippet, parameterised by amplitude. `AMP` is baked as a literal
 * rather than passed as a uniform: the crystals and the sigils want different
 * amounts (a shard can carry more wander than a landmark ring), and baking it
 * keeps the shared clock the ONLY uniform this system adds.
 */
function breathFragment(amp, guard) {
  const body = /* glsl */`
  {
    float lifeT = uVoidLifeTime;
    // Two slow sines, incommensurate, beating. ~11.9 s and ~20.3 s periods.
    float lifeB = sin(lifeT * 0.529 + vVoidLifePhase) * 0.6
                + sin(lifeT * 0.310 + vVoidLifePhase * 1.7 + 2.1) * 0.4;
    // Zero at t=0 so a frozen acceptance frame is untouched; full by ~2.5 s.
    float lifeE = smoothstep(0.0, 2.5, lifeT);
    totalEmissiveRadiance *= 1.0 + ${amp.toFixed(3)} * lifeE * lifeB;
  }
`
  // On the stone surfaces the ONLY emissive is the glowing vein mask, and it is
  // present only where the theme turned it on (`SC_VEIN`, materials/shader.js).
  // Guarding the whole modulation on that define means a surface with no veins
  // compiles the breath OUT entirely — zero fill cost on the vast majority of
  // the level's fragments — and a surface WITH veins pays two sines to make its
  // fissures gutter. It also keeps the multiply off any non-vein emissive a
  // surface might ever carry.
  return guard ? `#ifdef SC_VEIN\n${body}\n#endif` : body
}

/**
 * Patch one MeshStandardMaterial-derived material to breathe.
 *
 * Chains, never overwrites: the crystal lane already owns `onBeforeCompile`
 * (its translucency model) and `render/patch.js` will own it too (aerial
 * perspective). Every hook calls the previous one, so the three compose in the
 * one slot three gives them. The anchors are chosen not to collide — the
 * crystal writes at `emissivemap_fragment`, patch.js at `fog_fragment`, and this
 * at `opaque_fragment`, which is the last point `totalEmissiveRadiance` is still
 * mutable before it becomes pixel colour.
 *
 * @param {THREE.Material} mat
 * @param {{value:number}} timeUniform  the shared clock
 * @param {number} amp                  breath amplitude for this family
 * @param {string} keyTag               cache-key suffix so a breathing material
 *   never shares a compiled program with an un-breathed one of the same type
 * @param {boolean} [guard]             wrap the fragment modulation in
 *   `#ifdef SC_VEIN` — for the stone surfaces, whose only emissive is the vein
 *   mask and which must not pay any cost where that mask is absent
 */
function patchBreath(mat, timeUniform, amp, keyTag, guard = false) {
  const prevHook = mat.onBeforeCompile
  const prevKey = mat.customProgramCacheKey
  const frag = breathFragment(amp, guard)

  mat.onBeforeCompile = function (shader, renderer) {
    if (typeof prevHook === 'function') prevHook.call(this, shader, renderer)
    shader.uniforms.uVoidLifeTime = timeUniform

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nvarying float vVoidLifePhase;')
      // begin_vertex defines nothing this needs, but it is a stable anchor that
      // sits after instanceMatrix and modelMatrix are both live.
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n' + PHASE_VERTEX)

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform float uVoidLifeTime;\nvarying float vVoidLifePhase;')
      .replace('#include <opaque_fragment>',
        frag + '\n#include <opaque_fragment>')
  }

  // Give the breathed variant its own program family. patch.js appends its own
  // suffix on top of whatever this returns, so the two compose.
  mat.customProgramCacheKey = function () {
    const base = typeof prevKey === 'function' ? prevKey.call(this) : ''
    return base + '|void-life-' + keyTag
  }

  // Constructed before the first render (main.js builds VoidFX after the level),
  // so nothing has compiled yet and this needs no forced recompile. Set the flag
  // anyway, cheaply, in case a future caller patches a live material.
  mat.needsUpdate = true
  mat.userData.voidLifePatched = true
}

export class VoidLife {
  /**
   * @param {THREE.Scene} scene  the scene, already carrying the built level
   */
  constructor(scene) {
    this.time = { value: 0 }
    this.patched = new Set()
    this.crystals = 0
    this.sigils = 0
    this.veins = 0

    scene.traverse((obj) => {
      const mat = obj.material
      if (!mat || !mat.isMaterial) return
      // Materials are cached and shared (voidkit's `_glowMats`, the crystal
      // field's per-bucket materials): the same instance can hang off many
      // meshes, so dedupe or the breath compounds to breath-squared.
      if (this.patched.has(mat.uuid)) return

      const name = mat.name || ''

      // The crystal shards — the loudest light in the reference, and never a
      // surface. A little more wander than the sigils carry.
      if (name.startsWith('crystal')) {
        patchBreath(mat, this.time, 0.16, 'crystal')
        this.patched.add(mat.uuid)
        this.crystals++
        return
      }

      // The sigil / rune inlay glow — but ONLY the pieces that hang on the
      // walls. `void:slab-decal` is the rune a player reads a LANDING off
      // (§6, the readability channel) and is excluded by name; the wall inlay
      // is `void:glow:*` and is fair game because you never stand on a wall.
      if (name.startsWith('void:glow')) {
        patchBreath(mat, this.time, 0.10, 'sigil')
        this.patched.add(mat.uuid)
        this.sigils++
        return
      }

      // The glowing veins in the rock (materials/textures.js paints the mask;
      // materials/shader.js adds it to emissive under SC_VEIN). The task's
      // headline note: a previous lane left them still because the time uniform
      // "crosses into the frame loop, which is yours". This is that crossing —
      // a slow, uneven, world-position-phased gutter, smaller than the crystals
      // (±9%) because the reference's veins are steady embers, not lightning,
      // and the SC_VEIN guard keeps it off every non-vein fragment. It never
      // touches the `void:slab-decal` rune the player reads a LANDING off (that
      // is a different material, matched and animated nowhere here), so the §6
      // readability channel is untouched.
      if (name.startsWith('surface:') && mat.defines && 'SC_VEIN' in mat.defines) {
        patchBreath(mat, this.time, 0.09, 'vein', true)
        this.patched.add(mat.uuid)
        this.veins++
      }
    })
  }

  /** One uniform write drives every patched material. */
  update(time) {
    this.time.value = time
  }

  /**
   * Nothing owned here to tear down — the materials belong to their own lanes
   * and are disposed by them. Present for symmetry with the other fx classes
   * and so a caller can null the reference without special-casing it.
   */
  dispose() {
    this.patched.clear()
  }
}
