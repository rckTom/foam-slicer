// SPDX-License-Identifier: GPL-3.0-only
// Slice a model in node, the same code the page runs, and write the laser files:
//   npm run check -- <model.step|.brep|.FCStd> [outdir] [thicknesses, e.g. 10,20,50] [max outline] [max pockets]
// With several thicknesses the stack is the page's suggestion.
import fs from 'node:fs'
import path from 'node:path'
import init from 'replicad-opencascadejs'
import { Slicer, importFile, modelInfo, profile, sliceModel } from '../src/occ'
import { cutlist, isMixed, layerDxf, layerFileName, layerSvg } from '../src/export'
import { cellsOf, gridStep, plan, sheetError, stackSummary } from '../src/suggest'
import { fmt } from '../src/geom'
import { DEFAULT_PARAMS } from '../src/types'

const [file, out, thick, maxO, maxP] = process.argv.slice(2)
if (!file) { console.error('usage: npm run check -- <model> [outdir] [thicknesses] [max outline] [max pockets]'); process.exit(2) }
const oc = await init()
const imp = importFile(oc, path.basename(file), new Uint8Array(fs.readFileSync(file)))
const c = imp.choices[0]
const shape = imp.shapes.get(c.id)!
const info = modelInfo(oc, shape, c.label)
console.log(`${c.label}: ${info.solids} solid(s), bbox ${JSON.stringify(info.bbox)}, floors ${info.floors.join(' ')}`)
const p = { ...DEFAULT_PARAMS, z0: Math.round(info.bbox.min[2] * 100) / 100 }
if (thick) p.thicknesses = thick.split(',').map(Number)
if (maxO) p.maxOutline = +maxO
if (maxP) p.maxPockets = +maxP
const sl = new Slicer(oc, shape, p.tolerance, info.bbox)

const step = gridStep(p.thicknesses)
const n = Math.floor((info.bbox.max[2] - p.z0) / step + 1e-6)
const pr = profile(sl, p.z0, step, n, cellsOf(Math.max(...p.thicknesses), step))
console.log(`profile: ${n} cells of ${step} mm in ${pr.ms} ms`)
console.log('cell  z      in-cell outline/pockets   step below outline/pockets')
for (let i = 0; i < n; i++)
  console.log(`${String(i).padStart(3)}  ${fmt(p.z0 + i * step, 1).padStart(6)}  ${fmt(pr.outline[i][0], 2).padStart(7)} ${fmt(pr.pockets[i][0], 2).padStart(7)}` +
    (i ? `      ${fmt(pr.stepOutline[i - 1], 2).padStart(7)} ${fmt(pr.stepPockets[i - 1], 2).padStart(7)}` : ''))
p.stack = plan(pr, p)
console.log(`\nsuggested (max outline ${p.maxOutline}, pockets ${p.maxPockets}): ${p.stack.join(' + ')}  =  ${stackSummary(p.stack)}`)
let z = p.z0
for (const t of p.stack) {
  const e = sheetError(pr, Math.round((z - p.z0) / step), t)!
  console.log(`  z ${fmt(z, 0).padStart(4)}  ${String(t).padStart(3)} mm   outline ${fmt(e.outline, 2)}  pockets ${fmt(e.pockets, 2)}`)
  z += t
}

const res = sliceModel(oc, sl, info, p)
const text = cutlist(res, path.basename(file))
console.log('\n' + text)
console.log(`${res.ms} ms slicing, ${res.components} component(s)`)
if (out) {
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'cutlist.txt'), text)
  for (const L of res.layers) {
    const b = layerFileName(L, isMixed(res))
    fs.writeFileSync(path.join(out, b + '.dxf'), layerDxf(res, L))
    fs.writeFileSync(path.join(out, b + '.svg'), layerSvg(res, L))
  }
}
