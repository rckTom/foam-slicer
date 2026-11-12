// SPDX-License-Identifier: GPL-3.0-only
// Page state and the worker client. Slice results are big and never edited, so
// they live in shallow refs (no deep reactivity).
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { DEFAULT_PARAMS } from './types'
import type { LoadedModel, ModelChoice, Piece, Profile, Request, Response, SliceParams, SliceResult } from './types'
import { cellsOf, gridStep, plan, withSheet } from './suggest'

type Pending = { resolve: (r: Response) => void; reject: (e: Error) => void }

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
const pending = new Map<number, Pending>()
let nextId = 1

export const progress = reactive({ busy: false, text: '', frac: 0 })

worker.onmessage = (ev: MessageEvent<Response>) => {
  const r = ev.data
  if (r.ok && r.op === 'progress') { progress.text = r.text; progress.frac = r.frac; return }
  const p = pending.get(r.id)
  if (!p) return
  pending.delete(r.id)
  if (r.ok) p.resolve(r)
  else p.reject(new Error(r.error))
}
worker.onerror = (e) => { error.value = `worker failed: ${e.message}` }

type NoId<R> = R extends unknown ? Omit<R, 'id'> : never

function call(q: NoId<Request>, transfer: Transferable[] = []): Promise<Response> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ ...q, id }, transfer)
  })
}

// ---- state -------------------------------------------------------------------------

export const fileName = ref('')
export const choices = ref<ModelChoice[]>([])
export const model = shallowRef<LoadedModel | null>(null)
export const result = shallowRef<SliceResult | null>(null)
export const error = ref('')
export const params = reactive<SliceParams>({ ...DEFAULT_PARAMS })

export const sel = reactive({ layer: 0, piece: '' as string })
export const hover = ref('')                // piece id under the pointer
export const view = reactive({ explode: 0, ghost: true, sheets: true, below: true })

export const layer = computed(() => result.value?.layers[sel.layer] ?? null)
export const pieceById = computed(() => {
  const m = new Map<string, Piece>()
  for (const L of result.value?.layers ?? []) for (const q of L.pieces) m.set(q.id, q)
  return m
})
export const selPiece = computed(() => pieceById.value.get(sel.piece) ?? null)

export function selectPiece(id: string) {
  const q = pieceById.value.get(id)
  if (!q) { sel.piece = ''; return }
  sel.piece = id
  sel.layer = q.layer
}

export function selectLayer(i: number) {
  const n = result.value?.layers.length ?? 0
  if (!n) return
  sel.layer = Math.max(0, Math.min(n - 1, i))
  if (selPiece.value && selPiece.value.layer !== sel.layer) sel.piece = ''
}

// ---- actions -----------------------------------------------------------------------

export async function openFile(name: string, data: ArrayBuffer) {
  error.value = ''
  progress.busy = true
  progress.text = `reading ${name}`
  progress.frac = 0
  try {
    const r = await call({ op: 'open', name, data }, [data])
    if (!r.ok || r.op !== 'open') return
    fileName.value = name
    choices.value = r.choices
    result.value = null
    model.value = null
    if (r.model) adopt(r.model)
    else progress.busy = false
  } catch (e) {
    error.value = (e as Error).message
    progress.busy = false
  }
}

export async function choose(id: string) {
  error.value = ''
  progress.busy = true
  progress.text = 'loading'
  try {
    const r = await call({ op: 'choose', choice: id })
    if (r.ok && r.op === 'choose') adopt(r.model)
  } catch (e) {
    error.value = (e as Error).message
    progress.busy = false
  }
}

function adopt(m: LoadedModel) {
  model.value = m
  profile.value = null
  planKey = ''
  // sheets start at the model's floor
  params.z0 = Math.round(m.info.bbox.min[2] * 100) / 100
  sel.layer = 0
  sel.piece = ''
  void refresh()
}

// ---- profile -> suggested stack -> slices ------------------------------------------

export const profile = shallowRef<Profile | null>(null)
let planKey = ''                // inputs of the last suggestion
let sliced = ''                 // params of the last slice started
let running = false, again = false

const plain = (): SliceParams => JSON.parse(JSON.stringify(params))

/** Bring everything up to date with the params: the height profile when the
 *  grid moved, a new suggestion when the foam or the tolerances changed, and
 *  the slices. Calls while one runs are folded into one more round. */
export async function refresh() {
  if (!model.value) return
  if (running) { again = true; return }
  running = true
  try {
    do { again = false } while (await refreshOnce() && again)
  } finally {
    running = false
    progress.busy = false
  }
}

async function refreshOnce(): Promise<boolean> {
  error.value = ''
  const ts = [...new Set(params.thicknesses.filter(t => t > 0))].sort((a, b) => a - b)
  if (!ts.length) { error.value = 'Add at least one foam thickness.'; return false }
  const step = gridStep(ts)
  const kmax = cellsOf(ts[ts.length - 1], step)
  const pr = profile.value
  if (!pr || pr.z0 !== params.z0 || pr.step !== step || pr.kmax < kmax) {
    progress.busy = true
    progress.text = 'height profile'
    progress.frac = 0
    try {
      const r = await call({ op: 'profile', z0: params.z0, step, kmax })
      if (r.ok && r.op === 'profile') profile.value = r.profile
    } catch (e) {
      error.value = (e as Error).message
      profile.value = null
      result.value = null
      return false
    }
  }
  const key = JSON.stringify([ts, params.maxOutline, params.maxPockets, params.z0, step])
  if (key !== planKey && profile.value) {
    planKey = key
    params.stack = plan(profile.value, plain())
  }
  if (JSON.stringify(params) !== sliced) await slice()
  return true
}

/** Plan the whole stack again, dropping changes made by hand. */
export function suggestStack() {
  planKey = ''
  void refresh()
}

/** Set sheet i's thickness; the sheets above it are planned again. */
export function setSheet(i: number, t: number) {
  if (!profile.value) return
  params.stack = withSheet(profile.value, plain(), params.stack, i, t)
}

let sliceSeq = 0
async function slice() {
  if (!model.value) return
  const seq = ++sliceSeq
  sliced = JSON.stringify(params)
  progress.busy = true
  progress.text = 'slicing'
  progress.frac = 0
  try {
    const r = await call({ op: 'slice', params: plain() })
    if (seq !== sliceSeq || !r.ok || r.op !== 'slice') return
    result.value = r.result
    if (sel.layer >= r.result.layers.length) sel.layer = r.result.layers.length - 1
    if (sel.piece && !pieceById.value.has(sel.piece)) sel.piece = ''
  } catch (e) {
    if (seq === sliceSeq) { error.value = (e as Error).message; result.value = null }
  }
}

let timer = 0
watch(params, () => {
  clearTimeout(timer)
  timer = window.setTimeout(() => void refresh(), 300)
}, { deep: true })

export function setHover(id: string) { if (hover.value !== id) hover.value = id }
