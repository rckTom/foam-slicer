// SPDX-License-Identifier: GPL-3.0-only
// Run the nesting search in node for a few seconds and print how it improves:
//   [OUT=dir] [SPLIT=1] [KEEP=0] [BED=600x400] npm run nestcheck -- <model> <stock|roll> <seconds> [thicknesses] [stock "10:1050x1690x1,10:470x400x1" | widths "10:1050"]
import fs from 'node:fs'
import path from 'node:path'
import init from 'replicad-opencascadejs'
import { Slicer, importFile, modelInfo, profile, sliceModel } from '../src/occ'
import { cellsOf, gridStep, plan, stackSummary } from '../src/suggest'
import { DEFAULT_NEST, Search, assemble, finish, prepare } from '../src/nest'
import type { NestParams } from '../src/nest'
import { DEFAULT_PARAMS } from '../src/types'
import { fmt } from '../src/geom'
import { nestDxf, nestFileName, nestPlanSvg, nestReport, nestSvg } from '../src/export'

const [file, mode, secs, thick, spec] = process.argv.slice(2)
const oc = await init()
const imp = importFile(oc, path.basename(file), new Uint8Array(fs.readFileSync(file)))
const shape = imp.shapes.get(imp.choices[0].id)!
const info = modelInfo(oc, shape, imp.choices[0].label)
const p = { ...DEFAULT_PARAMS, z0: info.bbox.min[2], thicknesses: (thick ?? '10').split(',').map(Number) }
const sl = new Slicer(oc, shape, p.tolerance, info.bbox)
const step = gridStep(p.thicknesses)
const pr = profile(sl, p.z0, step, Math.floor((info.bbox.max[2] - p.z0) / step + 1e-6), cellsOf(Math.max(...p.thicknesses), step))
p.stack = plan(pr, p)
const res = sliceModel(oc, sl, info, p)
console.log(`stack: ${stackSummary(p.stack)}`)

const np: NestParams = { ...DEFAULT_NEST, mode: mode as NestParams['mode'] }
for (const item of (spec ?? '').split(',').filter(Boolean)) {
  const [t, d] = item.split(':')
  if (mode === 'roll') np.widths[t] = +d
  else { const [w, l, c] = d.split('x').map(Number); np.stock.push({ t: +t, w, l, count: c ?? 1 }) }
}
if (process.env.SPLIT) np.splitEdges = +process.env.SPLIT
if (process.env.KEEP === '0') np.keepWhole = { bottom: false, top: false }
if (process.env.BED) { const [w, h] = process.env.BED.split('x').map(Number); np.bed = { on: true, w, h } }
const job = prepare(res.layers, np)
for (const g of job.groups) {
  const gu = g.parts.filter(p => p.host)
  console.log(`${g.t} mm: ${g.parts.length} pieces, ${gu.length} meant for drop-outs (${gu.map(p => `${p.id} in ${p.host!.id}`).join(', ')}), ${g.skipped.length} skipped`)
}
const ss = job.groups.map(g => new Search(job, g))
const t0 = Date.now()
let last = ''
for (let k = 0; Date.now() - t0 < +(secs ?? 5) * 1000; k++) {
  for (const s of ss) s.step()
  const now = ss.map(s => s.best.lay.score.map(v => fmt(v, 0)).join('/')).join('  ')
  if (now !== last) { console.log(`${String(Date.now() - t0).padStart(6)} ms  ${String(ss.reduce((a, s) => a + s.evals, 0)).padStart(6)} evals  score ${now}`); last = now }
}
const r = finish(res, assemble(job, ss.map(s => s.best)))
for (const s of r.sheets) console.log(`sheet ${s.name}: ${s.w} x ${s.l}, used ${s.used}, blanks ${(s.blanks ?? []).map(b => `${b.name} ${fmt(b.w, 0)}x${fmt(b.h, 0)}`).join(' ') || '-'}, offcut ${s.offcut ? `${fmt(s.offcut.w, 0)} x ${fmt(s.offcut.h, 0)} (${s.offcut.edges} edges)` : '-'}, ${s.parts.length} parts: ${s.parts.map(q => q.id + (q.host ? `(in ${q.host})` : '') + (q.rot ? '↻' : '')).join(' ')}`)
for (const t of r.totals) console.log(`${t.t} mm: ${t.sheets} sheet(s)${t.length ? `, length ${t.length} at width ${t.width}` : ''}, fill ${fmt(100 * t.fill, 0)} %`)
for (const u of r.unplaced) console.log(`not placed: ${u.id} (${u.why})`)
for (const u of r.unused) console.log(`unused stock: ${u.t} mm ${u.w} x ${u.l}`)
const out = process.env.OUT
if (out) {
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'nest.txt'), nestReport(r, path.basename(file)))
  for (const s of r.sheets) {
    for (const b of s.blanks ?? [undefined]) {
      fs.writeFileSync(path.join(out, nestFileName(s, b) + '.dxf'), nestDxf(res, r, s, b))
      fs.writeFileSync(path.join(out, nestFileName(s, b) + '.svg'), nestSvg(res, r, s, b))
    }
    if (s.blanks) fs.writeFileSync(path.join(out, nestFileName(s) + '_plan.svg'), nestPlanSvg(res, r, s))
  }
  console.log(`written to ${out}`)
}
