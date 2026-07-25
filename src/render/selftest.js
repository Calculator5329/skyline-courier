import * as THREE from 'three'
import { RenderPipeline } from './index.js'
import { detectHdrSupport } from './pass.js'

const TYPE_NAMES = {
  [THREE.UnsignedByteType]: 'UnsignedByteType',
  [THREE.HalfFloatType]: 'HalfFloatType',
  [THREE.FloatType]: 'FloatType',
}

const FORMAT_NAMES = {
  [THREE.RGBAFormat]: 'RGBAFormat',
  [THREE.RGFormat]: 'RGFormat',
  [THREE.RedFormat]: 'RedFormat',
}

function describe(name, rt) {
  return {
    name,
    width: rt.width,
    height: rt.height,
    type: TYPE_NAMES[rt.texture.type] ?? String(rt.texture.type),
    format: FORMAT_NAMES[rt.texture.format] ?? String(rt.texture.format),
    samples: rt.samples ?? 0,
    depth: !!rt.depthBuffer,
    bytes: rt.width * rt.height * 4 * (rt.texture.type === THREE.UnsignedByteType ? 1 : 2),
  }
}

/**
 * Build a pipeline, size it, and report what it actually allocated.
 *
 * Intended to be run from the browser console for a sanity check:
 *
 *     import('./src/render/selftest.js').then(m => console.table(m.selftest().targets))
 *
 * Pass an existing renderer to inspect the real context; with no arguments it
 * spins up a throwaway 320x180 renderer, a stub scene and camera, reports, and
 * disposes everything. `dispose` defaults to true — pass a renderer AND
 * `{ dispose: false }` if you want to keep the pipeline it returns.
 */
export function selftest(renderer = null, opts = {}) {
  const width = opts.width ?? 320
  const height = opts.height ?? 180
  const shouldDispose = opts.dispose ?? true

  let ownRenderer = null
  let r = renderer
  if (!r) {
    ownRenderer = new THREE.WebGLRenderer({ antialias: false })
    ownRenderer.setPixelRatio(1)
    ownRenderer.setSize(width, height)
    r = ownRenderer
  }

  const scene = opts.scene ?? new THREE.Scene()
  const camera = opts.camera ?? new THREE.PerspectiveCamera(76, width / height, 0.1, 1200)

  const pipeline = new RenderPipeline(r, scene, camera, opts.pipelineOptions)
  pipeline.setSize(width, height)

  const targets = [describe('scene(hdr)', pipeline.sceneTarget)]

  if (pipeline.exposure) {
    targets.push(describe('meter/64', pipeline.exposure.rt64))
    targets.push(describe('meter/16', pipeline.exposure.rt16))
    targets.push(describe('meter/4', pipeline.exposure.rt4))
    targets.push(describe('meter/1', pipeline.exposure.rt1))
    targets.push(describe('adapt/a', pipeline.exposure.adapt[0]))
    targets.push(describe('adapt/b', pipeline.exposure.adapt[1]))
  }

  pipeline.bloom.mips.forEach((m, i) => targets.push(describe(`bloom/${i}`, m.rt)))

  const report = {
    three: THREE.REVISION,
    hdrSupported: detectHdrSupport(r),
    floatTargetType: TYPE_NAMES[pipeline._type],
    pixelRatio: r.getPixelRatio(),
    requestedSize: [width, height],
    internalSize: pipeline.getSize().toArray(),
    msaaSamples: pipeline.samples,
    bloomLevels: pipeline.bloom.mips.length,
    bloomThreshold: pipeline.bloom.threshold,
    lut: {
      size: pipeline.lut.size,
      texels: pipeline.lut.size ** 3,
      type: TYPE_NAMES[pipeline.lut.texture.type],
      isData3DTexture: pipeline.lut.texture.isData3DTexture === true,
    },
    tunables: {
      exposureCompensation: pipeline.exposureCompensation,
      exposureScale: pipeline.exposureScale,
      bloomStrength: pipeline.bloomStrength,
      lutStrength: pipeline.lutStrength,
      sharpen: pipeline.sharpen,
      chromaticAberration: pipeline.chromaticAberration,
      vignette: pipeline.vignette,
      grain: pipeline.grain,
    },
    targets,
    totalTargetBytes: targets.reduce((a, t) => a + t.bytes, 0),
  }

  if (shouldDispose) {
    pipeline.dispose()
    if (ownRenderer) {
      ownRenderer.dispose()
      ownRenderer.forceContextLoss()
    }
  } else {
    report.pipeline = pipeline
  }

  return report
}

export default selftest
