// SPDX-License-Identifier: GPL-3.0-only
// OpenCascade runs here, off the page's thread.
import init from 'replicad-opencascadejs'
import wasmUrl from 'replicad-opencascadejs/wasm?url'
import type { OpenCascadeInstance, TopoDS_Shape } from 'replicad-opencascadejs'
import { Slicer, importFile, mesh, modelInfo, profile, sliceModel } from './occ'
import { DEFAULT_PARAMS } from './types'
import type { LoadedModel, ModelInfo, Request, Response } from './types'

const ocReady: Promise<OpenCascadeInstance> = init({ locateFile: () => wasmUrl })

let shapes = new Map<string, TopoDS_Shape>()
let labels = new Map<string, string>()
let current: { shape: TopoDS_Shape; info: ModelInfo; slicer: Slicer } | null = null

function post(r: Response, transfer: Transferable[] = []) {
  ;(self as unknown as Worker).postMessage(r, transfer)
}

function load(oc: OpenCascadeInstance, id: string): [LoadedModel, Transferable[]] {
  const shape = shapes.get(id)
  if (!shape) throw new Error(`no shape ${id}`)
  const info = modelInfo(oc, shape, labels.get(id) ?? id)
  current?.slicer.free()
  current = { shape, info, slicer: new Slicer(oc, shape, DEFAULT_PARAMS.tolerance, info.bbox) }
  const m = mesh(oc, shape)
  return [{ choice: id, info, mesh: m }, [m.positions.buffer, m.normals.buffer, m.index.buffer, m.edges.buffer]]
}

self.onmessage = async (ev: MessageEvent<Request>) => {
  const q = ev.data
  try {
    const oc = await ocReady
    if (q.op === 'open') {
      current?.slicer.free()
      for (const s of shapes.values()) s.delete()
      current = null
      const imp = importFile(oc, q.name, new Uint8Array(q.data))
      shapes = imp.shapes
      labels = new Map(imp.choices.map(c => [c.id, c.label]))
      if (imp.choices.length === 1) {
        const [model, tr] = load(oc, imp.choices[0].id)
        post({ id: q.id, ok: true, op: 'open', choices: imp.choices, model }, tr)
      } else post({ id: q.id, ok: true, op: 'open', choices: imp.choices })
    } else if (q.op === 'choose') {
      const [model, tr] = load(oc, q.choice)
      post({ id: q.id, ok: true, op: 'choose', model }, tr)
    } else if (q.op === 'profile') {
      if (!current) throw new Error('no model loaded')
      const n = Math.floor((current.info.bbox.max[2] - q.z0) / q.step + 1e-6)
      if (n < 1) throw new Error('the model is lower than one sheet above z0')
      if (n > 200) throw new Error(`the thicknesses only share a ${q.step} mm step: ${n} grid cells, too fine to sample`)
      const pr = profile(current.slicer, q.z0, q.step, n, q.kmax,
        (text, frac) => post({ id: -1, ok: true, op: 'progress', text, frac }))
      post({ id: q.id, ok: true, op: 'profile', profile: pr })
    } else if (q.op === 'slice') {
      if (!current) throw new Error('no model loaded')
      const result = sliceModel(oc, current.slicer, current.info, q.params,
        (text, frac) => post({ id: -1, ok: true, op: 'progress', text, frac }))
      post({ id: q.id, ok: true, op: 'slice', result })
    }
  } catch (e) {
    let msg = e instanceof Error ? e.message : String(e)
    if (typeof e === 'number') msg = `OpenCascade exception (${e})`
    post({ id: q.id, ok: false, error: msg })
  }
}
