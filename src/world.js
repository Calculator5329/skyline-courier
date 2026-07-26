import * as THREE from 'three'
import { PALETTE } from './materials.js'
import { SKY, SKY_GRADIENT_GLSL } from './render/skygrad.js'
import { getTheme, themeSunDir } from './theme.js'
import { voidBeamSites } from './fx/voidfx.js'
import { VoidBackdrop } from './fx/voidbackdrop.js'

/**
 * Sky, light, and atmosphere.
 *
 * Clockwork Garden's last playtest correction was blunt about this: a painted
 * backdrop card is not a sky, because its edge appears the moment the camera
 * turns. So the sky here is a real gradient shader on a sphere that the camera
 * can never reach the edge of, depth is carried by fog and by genuine distant
 * geometry, and the sun is a shaded disc in that gradient rather than a sprite.
 */

const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const SKY_FRAG = /* glsl */`
  varying vec3 vDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uTime;
  // x: world Y of the deck plane, y: metres per noise unit for the billow
  // layer, z: the same for the bank layer, w: unused.
  uniform vec4 uDeck;

  // --- the painted void dome (theme.sky.dome; skyline leaves these at zero) --
  //
  // See the long note on sky.dome in src/theme.js for why an image is allowed
  // here at all and what it is and is not permitted to do. The short version:
  // this samples a MULTIPLIER, never a colour. The colour and the whole
  // vertical ramp remain scSkyGradient's — the same single evaluation the
  // aerial perspective and scene.fog read.
  uniform sampler2D uDomeMap;
  // x: horizontal repeats, y: sin(elTop), z: sin(elBottom), w: master amount
  // (0 disables the whole branch, which is the shipped skyline path).
  uniform vec4 uDomeGeo;
  // x: lo multiplier, y: hi multiplier, z: gamma, w: fade width, in v units.
  uniform vec4 uDomeTone;
  // x: black point, y: white point — the window of the PAINTING's own range
  // that is expanded across the whole output range. zw unused.
  uniform vec4 uDomeLevels;

  ${SKY_GRADIENT_GLSL}

  /**
   * The painted dome, expressed ENTIRELY in scVoidGradient's own two anchors.
   *
   * This function does not introduce a colour. It picks, per direction, a point
   * on the line between two values the void gradient already produces:
   *
   *   SILHOUETTE, base * lo  — darker than the void behind it. Architecture
   *     at infinity is made by removing light, not by adding it, and this end
   *     of the range is what puts real crushed black (§2's clip lo) into a
   *     frame that had almost none.
   *   OPEN HAZE, haze * hi with hi below 1 — the deep violet the gradient
   *     itself reaches when you look straight down, which is also the colour
   *     scene.fog and the aerial perspective terminate on.
   *
   * THAT CEILING IS THE WHOLE SAFETY ARGUMENT, and it is arithmetic rather than
   * taste. The brightest pixel this dome can produce is haze * hi, which is
   * strictly less than the brightest pixel the background could ALREADY produce
   * before the image existed. So the painting cannot raise the background's
   * ceiling by one bit, and the inversion a previous session shipped —
   * background brighter than the mass, every rock a black cutout — is not
   * reachable from here whatever is in the file. Lit rock in these frames sits
   * around p99 200; the haze anchor renders under 90.
   *
   * MAPPING. Azimuth is the obvious wrap. Elevation is mapped through sin(el) —
   * straight off d.y — rather than through the angle: d.y is what
   * scVoidGradient ramps on, so the painting's vertical structure and the
   * gradient's stay locked together under any future change to either, and it
   * costs no asin.
   *
   * NO HORIZON LINE. Outside the painted band the texture clamps and would
   * repeat its edge row forever, which is a ruled line across the frame and
   * exactly what §3 forbids. The blend ramps to zero over fade at both edges
   * — 30 degrees of dome, not a few — so there is no elevation at which this
   * function's derivative spikes. A first pass used a 22 degree fade against a
   * narrower band and the top edge was visible as an arc in midclimb; the
   * fix is angular width, because a gradient spread over a third of the visible
   * dome is not an edge no matter what is on either side of it.
   */
  vec3 scDomeSky( vec3 d, vec3 base, vec3 haze ) {
    float u = atan( d.z, d.x ) * 0.15915494 * uDomeGeo.x;
    float v = ( d.y - uDomeGeo.z ) / max( uDomeGeo.y - uDomeGeo.z, 1e-4 );
    // The texture is uploaded with NO colour space (see buildWorld), so these
    // bytes are read as the authored 0..1 factor field they are rather than
    // decoded as sRGB radiance. A flat channel average, not a luminance
    // weighting: the painting is violet, so a Rec.709 luma would read almost
    // entirely off the green channel — the one channel a violet image carries
    // least of its structure in.
    vec3 texel = texture2D( uDomeMap, vec2( u, clamp( v, 0.0, 1.0 ) ) ).rgb;
    float lum = ( texel.r + texel.g + texel.b ) * 0.3333333;
    // A LEVELS WINDOW, then a gamma — not a bare gamma, and the difference is
    // the whole legibility of this element. Measured, the painting's channel
    // average has mean 0.091 and standard deviation 0.042: every bit of its
    // architecture lives inside about a sixth of the 0..1 range. A bare gamma
    // spread that sixth across a fifth of the output and the dome came back as
    // a faintly mottled dark field — present, unreadable, worth nothing. The
    // window expands the painting's OWN range instead, so a cathedral arrives
    // as a cathedral rather than as a rounding error.
    float k = clamp( ( lum - uDomeLevels.x )
      / max( uDomeLevels.y - uDomeLevels.x, 1e-4 ), 0.0, 1.0 );
    k = pow( k, uDomeTone.z );
    vec3 painted = mix( base * uDomeTone.x, haze * uDomeTone.y, k );
    float mask = smoothstep( 0.0, uDomeTone.w, v ) * smoothstep( 1.0, 1.0 - uDomeTone.w, v );
    return mix( base, painted, mask * uDomeGeo.w );
  }

  // --- value noise / fbm, for the cloud deck --------------------------------
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + vec2(17.3, 5.1);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 sunDir = normalize(uSunDir);
    float sun = max(dot(d, sunDir), 0.0);

    // --- the void: no deck, no disc, no aureole -----------------------------
    //
    // An early return rather than a set of multipliers, because every effect
    // below this line is a statement that there is a sky and a sun, and a void
    // has neither (art-direction-void.md §3). The measured failure this fixes
    // was specific and visible in the very first void capture: the cloud deck
    // still rendered, lit, under a bright horizon band, so the theme's whole
    // background was a golden-hour sky wearing a violet coat — which is the
    // "dark version of the sunset level" §1 says is wrong, and it is where the
    // uniform violet murk and the missing black point both came from.
    //
    // The branch is on a uniform, so it is coherent across every wavefront and
    // costs nothing; it also skips five octaves of fbm per pixel over the whole
    // lower half of the frame, which is why the void dome is CHEAPER than the
    // skyline one rather than a tax on it.
    if (scSkyVoid > 0.5) {
      // The gradient FIRST, then the painting as a modulation of it. Written
      // in this order on purpose: whatever the image does, the colour in this
      // frame came out of the same scSkyGradient the fog and the aerial
      // perspective are terminating on, so a distant island can never fade
      // into a violet the background does not reach.
      vec3 v = scSkyGradient(d, uZenith, uHorizon, uGround, uSunColor, sunDir);
      // uHorizon is scVoidGradient's own haze anchor — the value the ramp
      // reaches looking straight down and the value distance terminates on.
      // Passing it here is what keeps the dome inside the sky's one evaluation
      // rather than beside it.
      if (uDomeGeo.w > 0.0) v = scDomeSky(d, v, uHorizon);
      gl_FragColor = vec4(v, 1.0);
      return;
    }

    // The shared low-frequency gradient — the SAME function the aerial
    // perspective in render/patch.js uses as its inscatter colour. Everything
    // below is detail layered on top of it, and detail is the only thing that
    // is allowed to differ between the two.
    vec3 sky = scSkyGradient(d, uZenith, uHorizon, uGround, uSunColor, sunDir);

    // --- the cloud sea ------------------------------------------------------
    // Intersect the view ray with a REAL horizontal plane at a REAL altitude.
    // The distance from the camera down to that plane is what sets the scale of
    // everything below: with the plane 230 m down, a ray 30 degrees below the
    // horizon meets it 460 m out, and one screen pixel there spans a couple of
    // metres of deck. That is the perspective compression that makes a cloud
    // sea read as a sea — near billows resolved, far ones crowding into the
    // horizon — and it is exactly what the previous version threw away by
    // assuming the deck was one metre below the eye.
    float camH = cameraPosition.y - uDeck.x;
    if (h < -0.006 && camH > 1.0) {
      float t = camH / -h;                          // metres along the ray
      vec2 world = cameraPosition.xz + d.xz * t;    // world XZ of the hit

      // Anchored in WORLD space, not to the camera. A field that slides with
      // the player is a texture on a dome, which is the thing being replaced;
      // anchoring it means flying 200 m along the route actually moves you over
      // the clouds. The drift terms are the wind, and they are slow: the deck
      // is kilometres wide, so anything faster reads as a scrolling texture.
      vec2 cp = world / uDeck.y + vec2(uTime * 0.0016, uTime * 0.0009);

      float n = fbm(cp);
      n = n * 0.62 + fbm(cp * 2.7 + n) * 0.38;  // domain warp: billows, not blobs

      // Fade detail out toward the horizon, where the deck is nearly edge-on
      // and any texture at all turns into aliasing.
      //
      // The window is 0.012..0.17 rather than 0..0.26, and it is derived rather
      // than dialled. One pixel spans dt/dh * (fov/height) metres along the
      // ray, and dt/dh is camH/h^2 — so at h = -0.05 a pixel covers ~136 m of
      // deck and at h = -0.17 it covers ~12 m. Against a 420 m billow period
      // whose finest octave is 26 m, the second of those is half a period per
      // pixel (safe under 4x MSAA on a smoothly interpolated field) and the
      // first is five (guaranteed shimmer). 0.26 was tuned for the OLD 18 m
      // field and, carried over unchanged, it was throwing away every shallow
      // angle — which is the entire lower half of every shot taken from deck
      // level, and why the void under the terrace balustrade came back as a
      // flat white sheet.
      float detail = smoothstep(0.012, 0.17, -h);

      // Tops versus crevices. Note the fade target: 0.60, the field's own mean,
      // NOT zero. Fading the coverage itself to zero — which is what the first
      // version did — hands the far deck its pure SHADE value, so the sea got
      // darker toward the horizon, which is backwards for a surface that is
      // kilometres away through golden air. Fading to the mean lets the aerial
      // term below decide what happens out there, which is its job.
      float tops = mix(0.60, smoothstep(0.20, 0.64, n), detail);

      // --- which side of a billow is this? ---------------------------------
      // The previous version lit the deck by dot(viewDir, sunDir), which is not
      // a lighting term at all: it says the clouds are bright when you happen
      // to be facing the sun and grey when you are not, so looking straight
      // down at a fully sunlit deck returned its shade value across the whole
      // near field. That is exactly the pale grey mush the frame came back as.
      //
      // A cloud is lit by which way its surface faces, so take a finite
      // difference of the SAME noise field along the sun's horizontal azimuth.
      // Stepping sunward off a sun-facing slope goes downhill, so n - nSun > 0
      // is the lit side. One extra fbm, and it is the difference between a
      // cloud sea and a fog bank.
      // Skipped entirely once detail has faded, because at that point the
      // mix below returns the constant 0.5 whatever this evaluates to. The
      // branch is coherent — detail is a function of screen height alone, so
      // a wavefront is either all inside it or all outside — which is what
      // makes skipping five octaves of noise a real saving rather than a mask.
      float sunFace = 0.5;
      if (detail > 0.002) {
        vec2 sunAz = normalize(sunDir.xz + vec2(1e-5, 0.0));
        float nSun = fbm(cp + sunAz * 0.17);
        sunFace = mix(0.5, smoothstep(-0.06, 0.10, n - nSun), detail);
      }

      // The lit/shade split is the shared pair — see skygrad.js for why it is
      // 0.55 rather than the 0.80 that made this whole shader deliver a flat
      // gradient.
      vec3 lit = scCloudLit(uGround, uSunColor);
      vec3 shade = scCloudShade(uGround);
      vec3 cloud = mix(shade, lit, tops * (0.22 + 0.78 * sunFace));

      // Silver lining along the crest nearest the sun. Above 1.0 on purpose: a
      // rim brighter than the surface it rims is what a backlit cloud edge IS,
      // and it is the one part of the deck that should reach display white and
      // bloom. Squared in sunFace so it stays a RIM rather than washing the
      // whole lit half, and the view-dependent term is kept as a bonus for
      // looking into the sun rather than as the whole effect.
      cloud += uSunColor * (0.30 + 0.85 * pow(sun, 6.0))
             * tops * sunFace * sunFace * detail * 1.15;

      // --- the second layer: distant banks ---------------------------------
      // An order of magnitude larger and an order of magnitude slower, and
      // weighted by (1 - detail) so it lives exactly where the billow layer has
      // faded out: the last few degrees above the deck's own horizon. These are
      // the silhouetted masses that give the skyline a profile. They are DARKER
      // than the deck around them, because a cloud bank tens of kilometres away
      // at golden hour is seen against the bright horizon, not lit by it.
      // Skipped where the billow layer is at full strength, for the mirror
      // image of the reason the sun-facing term above is skipped near the
      // horizon: the (1 - detail) weight is already zero there.
      if (detail < 0.998) {
        vec2 bp = world / uDeck.z + vec2(uTime * 0.00035, -uTime * 0.00022);
        float bank = fbm(bp);
        float bankMask = smoothstep(0.44, 0.74, bank) * (1.0 - detail);
        cloud = mix(cloud, shade * 0.78, bankMask * 0.8);
      }

      // --- aerial perspective ON the deck -----------------------------------
      // The cloud sea is not a backdrop, it is a surface at a real distance: at
      // 40 degrees below the horizon the hit point is 360 m away, at 6 degrees
      // it is over 2 km. Without this the deck under your feet and the deck at
      // the horizon arrive at the same value, and a sea with no depth gradient
      // in it reads as a flat card with speckle printed on it — which is
      // exactly what the first attempt measured as.
      //
      // The target colour is the sky just ABOVE the horizon in the same
      // azimuth, which is what the air along that path is actually glowing
      // with, and it costs one more gradient evaluation with no noise in it.
      // 0.00032/m puts the deck directly below the camera at ~11% haze and the
      // last few degrees before the horizon past 80%, so the sea lightens INTO
      // the sunset band rather than terminating against it. It was 0.00045,
      // which was right for the vista camera 46 m up and wrong for every shot
      // at deck level: from y = 0 the whole visible sea is 900 m out or more,
      // and at that rate all of it arrived past 33% haze as one pale void.
      vec3 deckHaze = scSkyGradient(
        normalize(vec3(d.x, 0.035, d.z)), uZenith, uHorizon, uGround, uSunColor, sunDir);
      cloud = mix(cloud, deckHaze, 1.0 - exp(-t * 0.00032));

      sky = mix(sky, cloud, smoothstep(0.0, 0.10, -h));
    }

    // The disc last, so nothing washes it out.
    sky += uSunColor * pow(sun, 900.0) * 5.0;
    sky += uSunColor * pow(sun, 60.0) * 0.35;

    gl_FragColor = vec4(sky, 1.0);
  }
`

export function buildWorld(scene, renderer, theme = getTheme()) {
  // Golden hour: the sun sits LOW. This single number does more for the look
  // than any shader in the project — a high sun flattens everything into
  // top-down midday light and no amount of grading recovers the rim-lit,
  // long-shadowed read the reference depends on. It is now per-theme (the
  // void has no sun at all, only a direction for ambient to fall from), but
  // the principle survives the move: see src/theme.js.
  const sunDir = themeSunDir(theme)
  const L = theme.light
  const SKYC = { ...SKY, ...(theme.sky || {}) }
  const horizon = new THREE.Color(SKYC.horizon)

  // --- the painted dome, if this theme has one ----------------------------
  //
  // The ONLY image the game loads (CLAUDE.md rule 1, second exception). It is
  // a URL under `public/` rather than an import, so vite never bundles it and
  // the skyline build — which sets no `dome` — never fetches a byte of it.
  //
  // The uniforms below are packed and defaulted so that a theme without a dome
  // compiles the identical program with `uDomeGeo.w = 0`: the branch in
  // SKY_FRAG is on a uniform, so it is coherent across every wavefront and the
  // skyline pays nothing for this existing.
  const dome = (theme.sky && theme.sky.dome) || null
  const domeGeo = new THREE.Vector4(1, 1, -1, 0)
  const domeTone = new THREE.Vector4(1, 1, 1, 0)
  const domeLevels = new THREE.Vector4(0, 1, 0, 0)
  let domeMap = null
  if (dome) {
    let root = './'
    try {
      if (import.meta.env && import.meta.env.BASE_URL) root = import.meta.env.BASE_URL
    } catch (_) { /* non-vite host; relative is fine */ }
    domeMap = new THREE.TextureLoader().load(root + dome.url)
    domeMap.name = 'void-sky-dome'
    // Repeat in X, clamp in Y: the asset is authored to tile horizontally
    // (measured seam: mean left/right edge delta 3.9 of 255) and emphatically
    // not vertically. The clamp is invisible because `scDomeFactor` fades the
    // whole modulation out before it is reached.
    domeMap.wrapS = THREE.RepeatWrapping
    domeMap.wrapT = THREE.ClampToEdgeWrapping
    // A FACTOR FIELD, NOT RADIANCE — the same call the impostor atlas makes and
    // for the same reason. Decoding this as sRGB would push a deliberately dark
    // painting into near-black and hand the tone curve in `scDomeFactor`
    // nothing to work with.
    domeMap.colorSpace = THREE.NoColorSpace
    domeMap.anisotropy = renderer && renderer.capabilities
      ? renderer.capabilities.getMaxAnisotropy()
      : 1
    domeMap.minFilter = THREE.LinearMipmapLinearFilter
    domeMap.magFilter = THREE.LinearFilter
    domeMap.generateMipmaps = true
    const rad = Math.PI / 180
    domeGeo.set(
      dome.repeat != null ? dome.repeat : 4,
      Math.sin((dome.elTop != null ? dome.elTop : 44) * rad),
      Math.sin((dome.elBottom != null ? dome.elBottom : -52) * rad),
      dome.amount != null ? dome.amount : 1,
    )
    // The fade is authored in DEGREES because that is how the band is read off
    // a frame, and converted here into the v units the shader masks in.
    const span = Math.max(domeGeo.y - domeGeo.z, 1e-4)
    const fadeDeg = dome.fade != null ? dome.fade : 22
    const fadeV = Math.min(
      0.49, Math.abs(Math.sin((dome.elTop - fadeDeg) * rad) - domeGeo.y) / span)
    domeTone.set(
      dome.lo != null ? dome.lo : 0.34,
      dome.hi != null ? dome.hi : 1.06,
      dome.gamma != null ? dome.gamma : 0.62,
      fadeV,
    )
    domeLevels.set(
      dome.black != null ? dome.black : 0.03,
      dome.white != null ? dome.white : 0.20,
      0, 0,
    )
  }

  // --- sky --------------------------------------------------------------
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(theme.skyRadius, 32, 20),
    new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        // Every colour here comes from render/skygrad.js, which is also what
        // the aerial perspective samples. Two files holding two copies of the
        // same sky is precisely how distant islands ended up terminating
        // against a colour the sky never reached.
        // Declared by SKY_GRADIENT_GLSL, not here — see render/skygrad.js.
        // The dome and the aerial perspective read the same flag from the same
        // include, so there is no way to put one of them in void mode and
        // leave the other painting clouds.
        scSkyVoid: { value: theme.sky && theme.sky.voidMode ? 1 : 0 },
        uZenith: { value: new THREE.Color(SKYC.zenith) },
        uHorizon: { value: horizon },
        // "Ground" is the cloud deck, so it is BRIGHT. Everything below the
        // horizon in this world is luminous cloud, never dark earth.
        uGround: { value: new THREE.Color(SKYC.deck) },
        uSunDir: { value: sunDir },
        uSunColor: { value: new THREE.Color(SKYC.sun) },
        uDomeMap: { value: domeMap },
        uDomeGeo: { value: domeGeo },
        uDomeTone: { value: domeTone },
        uDomeLevels: { value: domeLevels },
        uTime: { value: 0 },
        uDeck: {
          value: new THREE.Vector4(SKYC.deckY, SKYC.billowScale, SKYC.bankScale, 0),
        },
      },
    }),
  )
  sky.name = 'sky'
  scene.add(sky)

  // --- fog ----------------------------------------------------------------
  //
  // READ THIS BEFORE TUNING IT. In this pipeline `scene.fog` is not what makes
  // distance work. `render/patch.js` replaces `fog_fragment` on every lit
  // material with a height-integrated aerial-perspective model whose inscatter
  // is sampled from the SKY, in the view direction — so for anything the
  // patcher has seen, these two numbers are inert.
  //
  // They still have to be here and they still have to be right. Declaring a fog
  // is what makes three compile the chunk the patcher replaces, and any
  // material the patcher never reached falls through to exactly this. So it is
  // set to the horizon band rather than to its own private cream (0xffdcae was
  // a fourth opinion about the sky), and the density drops 0.0052 -> 0.0030 so
  // that a mid-distance island seen through the fallback path survives instead
  // of dissolving at 120 m.
  scene.fog = new THREE.FogExp2(
    theme.fog.color != null ? theme.fog.color : horizon.getHex(),
    theme.fog.density)

  // --- light ------------------------------------------------------------
  // Warm key against cool ambient — the split that defines the reference.
  //
  // Note the orientation, which is easy to get backwards: at golden hour the
  // *sun* carries the warmth, so the sky term (light from above, minus the
  // sun) is COOL green-blue, and the ground term is the BRIGHT WARM bounce
  // off the sunlit cloud deck below. Warm-above/cool-below is the midday
  // arrangement and it flattens the whole warm/cool read.
  //
  // Intensity is low because the render pipeline's analytic sky IBL is now
  // the primary ambient source and budgets itself to ~20% of the key. This
  // light is a floor under that, not a second full ambient system.
  const hemi = new THREE.HemisphereLight(L.hemiSky, L.hemiGround, L.hemiIntensity)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(L.keyColor, L.keyIntensity)
  sun.position.copy(sunDir).multiplyScalar(60)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.bias = -0.0008
  sun.shadow.normalBias = 0.035
  const cam = sun.shadow.camera
  // A single tight frustum that follows the player — effectively one cascade.
  // The full cascaded setup is a capability-phase item, not a slice blocker.
  //
  // Widened for the low golden-hour sun: shadows cast at ~10 degrees of
  // elevation are several times longer than at noon, and a frustum sized for
  // a high sun clips them off mid-length in a very obvious straight line.
  cam.left = -70; cam.right = 70; cam.top = 70; cam.bottom = -70
  cam.near = 1; cam.far = 320
  cam.updateProjectionMatrix()
  scene.add(sun)
  scene.add(sun.target)

  // A cool fill from the opposite side keeps shadowed faces readable, which
  // matters more than realism when the player is reading a route at speed.
  // Tinted green-cyan so shadows land on the cool side of the split.
  const fill = new THREE.DirectionalLight(L.fillColor, L.fillIntensity)
  fill.position.set(L.fillPos[0], L.fillPos[1], L.fillPos[2])
  scene.add(fill)

  // Bounce from the cloud deck below. Undersides of floating islands are lit
  // in the reference, never black — this is the light that does that.
  const bounce = new THREE.DirectionalLight(L.bounceColor, L.bounceIntensity)
  bounce.position.set(0, -40, 0)
  scene.add(bounce)

  // --- drifting motes ----------------------------------------------------
  const COUNT = theme.motes.count
  const pos = new Float32Array(COUNT * 3)
  const seed = new Float32Array(COUNT)
  /**
   * Dust is only visible where there is light to catch.
   *
   * `art-direction-void.md` §4.5 asks for motes "denser near crystals and
   * beams", and that is not decoration — a uniform dust field in a near-black
   * scene is invisible everywhere except in front of an emissive, so an even
   * spread spends 90% of its particle budget on nothing and still leaves the
   * beams under-dressed. `theme.motes.cluster` is the fraction that gets bound
   * to a light source instead.
   *
   * The sites come from fx/voidfx.js rather than being reinvented here: two
   * files with two opinions about where the light in this world is would
   * quietly put the dust beside the beams rather than in them.
   */
  const clusterFrac = theme.motes.cluster || 0
  const sites = clusterFrac > 0 ? voidBeamSites() : []
  for (let i = 0; i < COUNT; i++) {
    if (sites.length && Math.random() < clusterFrac) {
      const s = sites[(Math.random() * sites.length) | 0]
      // A loose sleeve around the column, biased tight: r^2 concentrates the
      // draw near the beam where the light actually is, and the long tail
      // keeps it from reading as a solid tube.
      const r = 2.0 + 26.0 * Math.random() * Math.random()
      const a = Math.random() * Math.PI * 2
      pos[i * 3] = s.x + Math.cos(a) * r
      // Only the part of the column the player can plausibly see. Derived
      // from the SITE rather than from a literal: the beams now run from below
      // the kill plane to well above the spire, and the old fixed -12..98 m
      // window was sized for a course that topped out at y 88. It left the
      // upper two thirds of every column — which is most of what the player
      // climbs past — with no dust on it at all.
      const lo = Math.max(s.y, -20)
      const hi = Math.min(s.y + s.height, 270)
      pos[i * 3 + 1] = lo + Math.random() * Math.max(1, hi - lo)
      pos[i * 3 + 2] = s.z + Math.sin(a) * r
    } else {
      // Spread is per-theme: the skyline's motes hug the route, the void's fill
      // a much taller column because the course climbs through them.
      pos[i * 3] = -20 + Math.random() * theme.motes.spread[0]
      pos[i * 3 + 1] = -6 + Math.random() * theme.motes.spread[1]
      pos[i * 3 + 2] = -60 + Math.random() * theme.motes.spread[2]
    }
    seed[i] = Math.random() * Math.PI * 2
  }
  const moteGeo = new THREE.BufferGeometry()
  moteGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
  const moteMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uMoteColor: { value: new THREE.Vector3(...theme.motes.color) },
      uRise: { value: theme.motes.rise },
    },
    vertexShader: /* glsl */`
      attribute float aSeed;
      uniform float uTime;
      uniform float uRise;
      varying float vFade;
      void main() {
        vec3 p = position;
        // A slow upward current, wrapped so the column never empties out.
        // art-direction-void.md: "small debris drifting upward sells 'the void
        // has a current' and reinforces the upward pull".
        p.y += mod(uTime * uRise + aSeed * 7.0, 96.0) * step(0.001, uRise);
        p.y += sin(uTime * 0.28 + aSeed) * 1.5;
        p.x += cos(uTime * 0.19 + aSeed * 1.7) * 1.1;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vFade = 0.5 + 0.5 * sin(uTime * 0.7 + aSeed * 3.1);
        // CLAMPED AND NEAR-FADED, 2026-07-26. The projection is honest — a
        // 2.4 m-wide mote really does subtend 144 px at one metre — but a dust
        // mote that fills a tenth of the frame stops being dust. The review of
        // the void frames found one at (1370,295) in midclimb and read it,
        // correctly, as A MOON, which is the one thing §3 says the void may not
        // have ("there is no sun and no sky").
        //
        // Two terms, because the clamp alone only makes the moon smaller: the
        // fade takes any mote inside ~4 m to nothing, so the field is dust the
        // player moves THROUGH rather than a swarm of discs that grow as they
        // approach the eye. 18 px is a couple of motes' worth of bloom and no
        // more.
        float dist = -mv.z;
        vFade *= smoothstep(1.5, 5.0, dist);
        gl_PointSize = min(2.4 * (60.0 / dist), 18.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uMoteColor;
      varying float vFade;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(d)) * vFade * 0.42;
        gl_FragColor = vec4(uMoteColor, a);
      }
    `,
  })
  const motes = new THREE.Points(moteGeo, moteMat)
  motes.frustumCulled = false
  motes.name = 'motes'
  scene.add(motes)

  // --- the far bands ------------------------------------------------------
  //
  // art-direction-void.md §5: "depth in three bands... if everything sits in
  // one band the space collapses." Until this, the void had one — the course,
  // and then flat fog. See `src/fx/voidbackdrop.js`. The THIRD band is no
  // longer here: it is the painted dome wired into the sky above.
  //
  // It is built HERE, beside the sky and the fog, rather than in the level,
  // and that placement is the argument: this layer carries no collider, is
  // never reachable, and is part of what is BEHIND the world in exactly the
  // sense the dome and the aerial perspective are. Building it in the level
  // would put unreachable geometry in the file whose entire job is reachable
  // geometry. Themes that do not ask for it pay nothing.
  // TWO bands now, not three. The far one used to be baked impostor cards and
  // is deleted — `public/sky/void-dome.png`, wired into the sky above, carries
  // the distance instead and carries it as architecture rather than as prisms.
  // See the block headed "THE FAR BAND IS GONE" in that file.
  const backdrop = theme.backdrop ? new VoidBackdrop(scene, theme, renderer) : null

  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  // Tone mapping belongs to the composite pass (AgX), not to the renderer.
  // Leaving ACES on here would be inert but misleading — three disables it
  // when rendering into a target anyway.
  renderer.toneMapping = THREE.NoToneMapping
  scene.background = null

  return {
    sunDir,
    /** Keep the shadow frustum and sky centred on the player. */
    /** Instances, triangles and measured clearance, for the harness to print. */
    backdrop: backdrop
      ? { instances: backdrop.instances, triangles: backdrop.triangles,
          clearance: backdrop.clearance }
      : null,
    update(time, playerPos) {
      moteMat.uniforms.uTime.value = time
      if (backdrop) backdrop.update(time)
      sky.material.uniforms.uTime.value = time
      sky.position.copy(playerPos)
      sun.target.position.copy(playerPos)
      sun.position.copy(playerPos).addScaledVector(sunDir, 70)
      sun.target.updateMatrixWorld()
    },
  }
}

export { PALETTE }
