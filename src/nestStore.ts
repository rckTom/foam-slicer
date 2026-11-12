// SPDX-License-Identifier: GPL-3.0-only
// Nesting state: the settings (kept in this browser), the search worker and
// the best layout it has found so far. The search starts when the Nest tab is
// first opened and restarts whenever the slices or the settings change.
import { reactive, ref, shallowRef, watch } from 'vue'
import { DEFAULT_NEST, finish, thicknessesOf } from './nest'
import type { NestParams, NestResult } from './nest'
import type { NestIn, NestOut, NestStats } from './nestWorker'
import { result } from './store'

const KEY = 'foam-slicer-nest'

function load(): NestParams {
  try {
    const s = localStorage.getItem(KEY)
    if (s) {
      const v = JSON.parse(s)
      return { ...DEFAULT_NEST, ...v, keepWhole: { ...DEFAULT_NEST.keepWhole, ...v.keepWhole }, bed: { ...DEFAULT_NEST.bed, ...v.bed } }
    }
  } catch { /* no storage */ }
  return JSON.parse(JSON.stringify(DEFAULT_NEST))
}

export const nestParams = reactive<NestParams>(load())
export const nestResult = shallowRef<NestResult | null>(null)
export const nestStats = ref<NestStats | null>(null)
export const nestError = ref('')
export const improvedAt = ref(0)
const active = ref(false)

let started = { params: '', result: null as unknown }   // what the running search was started with

const worker = new Worker(new URL('./nestWorker.ts', import.meta.url), { type: 'module' })
let run = 0

worker.onmessage = (ev: MessageEvent<NestOut>) => {
  const m = ev.data
  if (m.run !== run) return
  if (m.op === 'error') { nestError.value = m.error; return }
  nestStats.value = m.stats
  if (m.op === 'best' && result.value) {
    nestResult.value = finish(result.value, m.result)
    improvedAt.value = Date.now()
  }
}

const post = (m: NestIn) => worker.postMessage(m)

/** Stock rows / widths for thicknesses that have none yet. */
function defaults() {
  const r = result.value
  if (!r) return
  for (const t of thicknessesOf(r.layers)) {
    if (!nestParams.stock.some(s => s.t === t)) nestParams.stock.push({ t, w: 1000, l: 2000, count: 1 })
    if (!(nestParams.widths[String(t)] > 0)) nestParams.widths[String(t)] = 1000
  }
}

export function startNest() {
  const r = result.value
  if (!r) return
  active.value = true
  defaults()
  nestError.value = ''
  run++
  started = { params: JSON.stringify(nestParams), result: r }
  post({ op: 'start', layers: r.layers, params: JSON.parse(JSON.stringify(nestParams)) })
}
export const pauseNest = () => post({ op: 'pause' })
export const resumeNest = () => post({ op: 'resume' })

let timer = 0
watch([result, nestParams], () => {
  try { localStorage.setItem(KEY, JSON.stringify(nestParams)) } catch { /* no storage */ }
  if (!active.value) return
  if (started.result === result.value && started.params === JSON.stringify(nestParams)) return
  clearTimeout(timer)
  timer = window.setTimeout(startNest, 400)
}, { deep: true })

/** The Nest tab was opened: start once, keep running in the background after. */
export function activateNest() {
  if (!active.value || !nestResult.value) startNest()
}
