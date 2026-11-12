// SPDX-License-Identifier: GPL-3.0-only
// The nesting search, in its own worker so the page stays responsive. It runs
// in short slices, posts the best layout whenever it improves (at most a few
// times a second) and stops by itself once it has not improved for a while.
import { Search, assemble, prepare } from './nest'
import type { NestJob, NestParams, NestResult } from './nest'
import type { Layer } from './types'

export interface NestStats {
  evals: number
  ms: number
  sinceGain: number       // ms since the last improvement
  running: boolean
  done: boolean           // stopped by itself (converged)
  gains: number
}

export type NestIn =
  | { op: 'start'; layers: Layer[]; params: NestParams }
  | { op: 'pause' }
  | { op: 'resume' }

export type NestOut =
  | { op: 'best'; run: number; result: NestResult; stats: NestStats }
  | { op: 'stats'; run: number; stats: NestStats }
  | { op: 'error'; run: number; error: string }

const IDLE_STOP = 15000       // ms without improvement
const MAX_TIME = 180000

let run = 0
let job: NestJob | null = null
let searches: Search[] = []
let running = false
let t0 = 0, gainAt = 0, gains = 0, elapsed = 0, posted = 0, lastStats = 0, dirty = false

const post = (m: NestOut) => (self as unknown as Worker).postMessage(m)

function stats(done = false): NestStats {
  const now = Date.now()
  return {
    evals: searches.reduce((s, x) => s + x.evals, 0),
    ms: elapsed + (running ? now - t0 : 0),
    sinceGain: now - gainAt, running, done, gains,
  }
}

function postBest(done = false) {
  if (!job) return
  post({ op: 'best', run, result: assemble(job, searches.map(s => s.best)), stats: stats(done) })
  dirty = false
  posted = Date.now()
}

function loop(myRun: number) {
  if (myRun !== run || !running) return
  const end = Date.now() + 40
  while (Date.now() < end) for (const s of searches) if (s.step()) { dirty = true; gains++; gainAt = Date.now() }
  const now = Date.now()
  if (dirty && now - posted > 350) postBest()
  const total = elapsed + now - t0
  if (now - gainAt > IDLE_STOP || total > MAX_TIME || searches.every(s => s.g.parts.length < 2)) {
    elapsed = total
    running = false
    postBest(true)
    return
  }
  if (now - lastStats > 500) { post({ op: 'stats', run, stats: stats() }); lastStats = now }
  setTimeout(() => loop(myRun), 0)
}

self.onmessage = (ev: MessageEvent<NestIn>) => {
  const q = ev.data
  try {
    if (q.op === 'start') {
      run++
      job = prepare(q.layers, q.params)
      searches = job.groups.map(g => new Search(job!, g))
      t0 = Date.now(); gainAt = t0; gains = 0; elapsed = 0
      running = true
      postBest()
      loop(run)
    } else if (q.op === 'pause') {
      if (running) { elapsed += Date.now() - t0; running = false; if (dirty) postBest(); post({ op: 'stats', run, stats: stats() }) }
    } else if (q.op === 'resume') {
      if (!running && job) { running = true; t0 = Date.now(); gainAt = t0; post({ op: 'stats', run, stats: stats() }); loop(run) }
    }
  } catch (e) {
    running = false
    post({ op: 'error', run, error: e instanceof Error ? e.message : String(e) })
  }
}
