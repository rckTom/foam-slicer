// SPDX-License-Identifier: GPL-3.0-only
// The OpenCascade side: reading STEP / BREP / FCStd, meshing for the 3D view,
// and cutting the model into sheets. Runs in the worker (or in node for tests).
import type { OpenCascadeInstance, TopoDS_Face, TopoDS_Shape, TopoDS_Wire } from 'replicad-opencascadejs'
import { unzipSync, strFromU8 } from 'fflate'
import {
  bboxOf, bulgeThrough, circumcentre, fmt, hausdorff, labelBox, makeLabel, reverseRing, ringPoints, signedArea,
} from './geom'
import type {
  BBox, Layer, MeshData, ModelChoice, ModelInfo, Piece, Profile, Pt, Ring, SliceParams, SliceResult, Warning,
} from './types'

type OC = OpenCascadeInstance
type Deletable = { delete(): void }

const EPS = 0.01            // section offset into the sheet (mm), as slice.py
const MIN_AREA = 0.5        // section faces smaller than this are slivers (mm2)

// ---- import ------------------------------------------------------------------------

export interface Imported { choices: ModelChoice[]; shapes: Map<string, TopoDS_Shape> }

export function importFile(oc: OC, name: string, data: Uint8Array): Imported {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const shapes = new Map<string, TopoDS_Shape>()
  const choices: ModelChoice[] = []
  if (ext === 'step' || ext === 'stp') {
    oc.FS.writeFile('/import.step', data)
    const r = new oc.STEPControl_Reader()
    const st = r.ReadFile('/import.step')
    oc.FS.unlink('/import.step')
    if (st !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error(`STEP read failed (${st})`)
    r.TransferRoots(new oc.Message_ProgressRange())
    const s = r.OneShape()
    r.delete()
    if (s.IsNull()) throw new Error('no shape in the STEP file')
    shapes.set('step', s)
    choices.push({ id: 'step', label: name, type: 'STEP' })
  } else if (ext === 'brep' || ext === 'brp') {
    shapes.set('brep', readBrep(oc, strFromU8(data)))
    choices.push({ id: 'brep', label: name, type: 'BREP' })
  } else if (ext === 'fcstd') {
    const files = unzipSync(data)
    const doc = files['Document.xml']
    if (!doc) throw new Error('no Document.xml in the FCStd file')
    for (const c of fcstdChoices(strFromU8(doc), files)) {
      choices.push(c)
      shapes.set(c.id, readBrep(oc, strFromU8(files[c.id + '.Shape.brp'])))
    }
    if (!choices.length) throw new Error('no body with a stored shape in the FCStd file')
  } else {
    throw new Error(`unknown file type .${ext} (STEP, BREP or FCStd)`)
  }
  return { choices, shapes }
}

function readBrep(oc: OC, text: string): TopoDS_Shape {
  if (!text.trimStart().startsWith('CASCADE Topology')) throw new Error('not a text BREP file (binary BREP is not supported)')
  const s = oc.BRepToolsWrapper.Read(text)
  if (s.IsNull()) throw new Error('empty BREP shape')
  return s
}

/** PartDesign bodies, else the other objects that keep a solid shape. */
function fcstdChoices(xml: string, files: Record<string, Uint8Array>): ModelChoice[] {
  const objs = [...xml.matchAll(/<Object type="([^"]+)" name="([^"]+)"/g)].map(m => ({ type: m[1], name: m[2] }))
  const label = (name: string) => {
    const i = xml.indexOf(`<Object name="${name}"`)
    const m = i < 0 ? null : /<Property name="Label"[^>]*>\s*<String value="([^"]*)"/.exec(xml.slice(i, i + 4000))
    return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : name
  }
  const has = (n: string) => (files[n + '.Shape.brp']?.length ?? 0) > 200
  const bodies = objs.filter(o => o.type === 'PartDesign::Body' && has(o.name))
  const pick = bodies.length ? bodies
    : objs.filter(o => /^Part::/.test(o.type) && !/Part2DObject|Sketch/.test(o.type) && has(o.name))
  return pick.map(o => ({ id: o.name, label: label(o.name), type: o.type.split('::')[1] }))
}

// ---- model info and mesh ---------------------------------------------------------

export function bounds(oc: OC, s: TopoDS_Shape): { min: [number, number, number]; max: [number, number, number] } {
  const b = new oc.Bnd_Box()
  oc.BRepBndLib.AddOptimal(s, b, false, false)
  const mn = b.CornerMin(), mx = b.CornerMax()
  const r = (v: number) => Math.round(v * 1e4) / 1e4
  const out = { min: [r(mn.X()), r(mn.Y()), r(mn.Z())] as [number, number, number],
                max: [r(mx.X()), r(mx.Y()), r(mx.Z())] as [number, number, number] }
  b.delete()
  return out
}

export function modelInfo(oc: OC, s: TopoDS_Shape, name: string): ModelInfo {
  let solids = 0
  for (const ex = new oc.TopExp_Explorer(s, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) solids++
  const p = new oc.GProp_GProps()
  oc.BRepGProp.VolumeProperties(s, p, false, false, false)
  const volume = Math.abs(p.Mass())
  p.delete()
  return { name, solids, bbox: bounds(oc, s), volume, floors: horizontalFaces(oc, s) }
}

/** Heights of the planar faces facing straight up or down. */
function horizontalFaces(oc: OC, s: TopoDS_Shape): number[] {
  const zs = new Set<number>()
  const ex = new oc.TopExp_Explorer(s, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE)
  for (; ex.More(); ex.Next()) {
    const a = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(ex.Current()), true)
    if (a.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
      const pl = a.Plane()
      if (Math.abs(Math.abs(pl.Axis().Direction().Z()) - 1) < 1e-9) zs.add(Math.round(pl.Location().Z() * 1000) / 1000)
    }
    a.delete()
  }
  ex.delete()
  return [...zs].sort((a, b) => a - b)
}

export function mesh(oc: OC, s: TopoDS_Shape): MeshData {
  const m = oc.ReplicadMeshExtractor.extract(s, 0.05, 0.2, false)
  const heap = () => oc.wasmMemory.buffer
  const positions = new Float32Array(heap(), m.getVerticesPtr(), m.getVerticesSize()).slice()
  const normals = new Float32Array(heap(), m.getNormalsPtr(), m.getNormalsSize()).slice()
  const index = new Uint32Array(heap(), m.getTrianglesPtr(), m.getTrianglesSize()).slice()
  m.delete()
  const e = oc.ReplicadEdgeMeshExtractor.extract(s, 0.05, 0.2)
  const lines = new Float32Array(heap(), e.getLinesPtr(), e.getLinesSize()).slice()
  const groups = new Int32Array(heap(), e.getEdgeGroupsPtr(), e.getEdgeGroupsSize()).slice()
  e.delete()
  // polylines (start, count, id) -> segment pairs
  const seg: number[] = []
  for (let g = 0; g < groups.length; g += 3) {
    const [st, n] = [groups[g], groups[g + 1]]
    for (let i = st; i < st + n - 1; i++) seg.push(...lines.subarray(3 * i, 3 * i + 6))
  }
  return { positions, normals, index, edges: new Float32Array(seg) }
}

// ---- sections ----------------------------------------------------------------------

interface Section { faces: TopoDS_Face[]; pieces: { rings: Ring[]; poly: Pt[][]; area: number }[] }

/** Cuts one model; keeps every section it made (OpenCascade objects included)
 *  until free(), so the profile and the slicing share them. */
export class Slicer {
  private trash: Deletable[] = []
  private plane: { x0: number; y0: number; x1: number; y1: number }
  private cache = new Map<string, Section>()

  constructor(private oc: OC, readonly shape: TopoDS_Shape, private tol: number,
              bb: { min: number[]; max: number[] }) {
    this.plane = { x0: bb.min[0] - 10, y0: bb.min[1] - 10, x1: bb.max[0] + 10, y1: bb.max[1] + 10 }
  }

  private k<T extends Deletable>(o: T): T { this.trash.push(o); return o }

  free() {
    this.cache.clear()
    for (const o of this.trash.splice(0)) try { o.delete() } catch { /* already gone */ }
  }

  /** The model's section at height z, one face per connected piece. */
  section(z: number): Section {
    const key = z.toFixed(6)
    let s = this.cache.get(key)
    if (!s) { s = this.cut(z); this.cache.set(key, s) }
    return s
  }

  private cut(z: number): Section {
    const oc = this.oc, k = this.k.bind(this)
    const pln = k(new oc.gp_Pln(k(new oc.gp_Pnt(0, 0, z)), k(new oc.gp_Dir(0, 0, 1))))
    const { x0, y0, x1, y1 } = this.plane
    const mf = k(new oc.BRepBuilderAPI_MakeFace(pln, x0, x1, y0, y1))
    const common = k(new oc.BRepAlgoAPI_Common(this.shape, mf.Face(), k(new oc.Message_ProgressRange())))
    const res = common.Shape()
    const faces: TopoDS_Face[] = []
    const pieces: Section['pieces'] = []
    const ex = k(new oc.TopExp_Explorer(res, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
    for (; ex.More(); ex.Next()) {
      const f = oc.TopoDS.Face(ex.Current())
      const p = k(new oc.GProp_GProps())
      oc.BRepGProp.SurfaceProperties(f, p, false, false)
      const area = Math.abs(p.Mass())
      if (area < MIN_AREA) continue
      const outer = oc.BRepTools.OuterWire(f)
      const rings: Ring[] = [this.ring(outer)]
      const wx = k(new oc.TopExp_Explorer(f, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
      for (; wx.More(); wx.Next()) {
        const w = oc.TopoDS.Wire(wx.Current())
        if (!w.IsSame(outer)) rings.push(this.ring(w))
      }
      // outer ring counter-clockwise, pockets clockwise
      const poly: Pt[][] = []
      for (let i = 0; i < rings.length; i++) {
        let pts = ringPoints(rings[i])
        if ((signedArea(pts) > 0) !== (i === 0)) { rings[i] = reverseRing(rings[i]); pts = ringPoints(rings[i]) }
        poly.push(pts)
      }
      faces.push(f)
      pieces.push({ rings, poly, area })
    }
    return { faces, pieces }
  }

  /** A closed wire as a ring of lines and arcs, edges chained end to end. */
  private ring(w: TopoDS_Wire): Ring {
    const oc = this.oc
    const chunks: { pts: Pt[]; b: number[] }[] = []
    const ex = new oc.TopExp_Explorer(w, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE)
    for (; ex.More(); ex.Next()) {
      const e = oc.TopoDS.Edge(ex.Current())
      const c = new oc.BRepAdaptor_Curve(e)
      chunks.push(this.edgeChunk(c, e.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED))
      c.delete()
    }
    ex.delete()
    // chain: each chunk starts where the previous one ended (flip if needed)
    const out: Ring = []
    const rest = chunks.slice(1)
    let cur = chunks[0]
    for (;;) {
      for (let i = 0; i < cur.b.length; i++) out.push([cur.pts[i][0], cur.pts[i][1], cur.b[i]])
      if (!rest.length) break
      const end = cur.pts[cur.pts.length - 1]
      let best = 0, bestD = Infinity, flip = false
      rest.forEach((ch, i) => {
        const ds = dist(ch.pts[0], end), de = dist(ch.pts[ch.pts.length - 1], end)
        if (ds < bestD) { best = i; bestD = ds; flip = false }
        if (de < bestD) { best = i; bestD = de; flip = true }
      })
      cur = rest.splice(best, 1)[0]
      if (flip) cur = { pts: cur.pts.slice().reverse(), b: cur.b.slice().reverse().map(v => -v) }
    }
    return out
  }

  /** Points p0..pn and bulges b0..b(n-1) of one edge, in the edge's direction. */
  private edgeChunk(c: any, reversed: boolean): { pts: Pt[]; b: number[] } {
    const oc = this.oc
    let u0 = c.FirstParameter(), u1 = c.LastParameter()
    if (reversed) [u0, u1] = [u1, u0]
    const at = (u: number): Pt => { const p = c.Value(u); const r: Pt = [p.X(), p.Y()]; p.delete(); return r }
    const type = c.GetType()
    const T = oc.GeomAbs_CurveType
    if (type === T.GeomAbs_Line) return { pts: [at(u0), at(u1)], b: [0] }
    if (type === T.GeomAbs_Circle) return arcChunk(at, u0, u1)
    // B-splines and the rest: an arc or a line if they are one within tol
    const n = 24
    const us = Array.from({ length: n + 1 }, (_, i) => u0 + (u1 - u0) * i / n)
    const ps = us.map(at)
    const s = ps[0], e = ps[n], m = ps[n / 2]
    const chord = dist(s, e)
    if (chord > 1e-6 && ps.every(p => lineDist(p, s, e) <= this.tol)) return { pts: [s, e], b: [0] }
    const cc = circumcentre(s, m, e)
    if (cc) {
      const r = dist(cc, s)
      if (r < 1e5 && ps.every(p => Math.abs(dist(p, cc) - r) <= this.tol)) return arcChunk(at, u0, u1)
    }
    // polyline within tol
    const td = new oc.GCPnts_TangentialDeflection(c, Math.min(u0, u1), Math.max(u0, u1), 0.1, this.tol, 2, 1e-9, 0)
    const pu: number[] = []
    for (let i = 1; i <= td.NbPoints(); i++) pu.push(td.Parameter(i))
    td.delete()
    if (u0 > u1) pu.reverse()
    const pts = pu.map(at)
    return { pts, b: pts.slice(1).map(() => 0) }
  }
}

/** Circular edge as one or two arcs (no arc over 180 degrees, so bulges stay small). */
function arcChunk(at: (u: number) => Pt, u0: number, u1: number): { pts: Pt[]; b: number[] } {
  const pieces = Math.abs(u1 - u0) > Math.PI * 0.99 ? 2 : 1
  const pts: Pt[] = [at(u0)]
  const b: number[] = []
  for (let i = 0; i < pieces; i++) {
    const a = u0 + (u1 - u0) * i / pieces, z = u0 + (u1 - u0) * (i + 1) / pieces
    const s = pts[pts.length - 1], m = at((a + z) / 2), e = at(z)
    b.push(bulgeThrough(s, m, e))
    pts.push(e)
  }
  return { pts, b }
}

function dist(a: Pt, b: Pt) { return Math.hypot(a[0] - b[0], a[1] - b[1]) }

function lineDist(p: Pt, a: Pt, b: Pt) {
  const l = dist(a, b)
  return Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / l
}

// ---- overlaps between sheets ------------------------------------------------------

function overlapArea(oc: OC, a: TopoDS_Face, b: TopoDS_Face, dz: number): number {
  const tr = new oc.gp_Trsf()
  const v = new oc.gp_Vec(0, 0, dz)
  tr.SetTranslation(v)
  const moved = new oc.BRepBuilderAPI_Transform(b, tr, true, false)
  const pr = new oc.Message_ProgressRange()
  const c = new oc.BRepAlgoAPI_Common(a, moved.Shape(), pr)
  const p = new oc.GProp_GProps()
  oc.BRepGProp.SurfaceProperties(c.Shape(), p, false, false)
  const area = Math.abs(p.Mass())
  for (const o of [p, c, pr, moved, v, tr]) o.delete()
  return area
}

function boxesOverlap(a: BBox, b: BBox) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

// ---- slicing -----------------------------------------------------------------------

export function sliceModel(oc: OC, sl: Slicer, info: ModelInfo, p: SliceParams,
                           progress: (text: string, frac: number) => void = () => {}): SliceResult {
  const t0 = Date.now()
  const bb = info.bbox
  const stack = stackOf(p, bb.max[2])
  const n = stack.length
  if (n < 1) throw new Error(`the model is ${fmt(bb.max[2] - p.z0, 2)} mm high above z0, less than one sheet`)
  if (n > 400) throw new Error(`${n} sheets; check the thickness and z0`)
  const bounds = [p.z0]
  for (const t of stack) bounds.push(bounds[bounds.length - 1] + t)
  const zTop = bounds[n]
  const mixed = new Set(stack).size > 1
  const warnings: Warning[] = []
  if (p.z0 > bb.min[2] + 1e-3)
    warnings.push({ level: 'warn', text: `z0 = ${fmt(p.z0, 2)} is above the model's bottom (${fmt(bb.min[2], 2)}); the part below is not cut` })
  if (zTop > bb.max[2] + 1e-3)
    warnings.push({ level: 'warn', text: `the stack ends at z ${fmt(zTop, 2)}, above the model's top (${fmt(bb.max[2], 2)})` })

  const layers: Layer[] = []
  const faces: TopoDS_Face[][] = []
  for (let i = 0; i < n; i++) {
    progress(`sheet ${i + 1} of ${n}`, i / n)
    const zb = bounds[i], zt = bounds[i + 1], t = zt - zb
    const zs = zb + Math.min(Math.max(p.at * t, EPS), t - EPS)
    const sec = sl.section(zs)
    const bot = Math.abs(zs - (zb + EPS)) < 1e-9 ? sec : sl.section(zb + EPS)
    const top = Math.abs(zs - (zt - EPS)) < 1e-9 ? sec : sl.section(zt - EPS)
    const name = 'L' + String(i + 1).padStart(2, '0')
    const order = sec.pieces.map((_, j) => j).sort((a, b) => sec.pieces[b].area - sec.pieces[a].area)
    const pieces: Piece[] = order.map((j, r) => ({
      id: r === 0 ? name : `${name}-${String.fromCharCode(97 + ((r - 1) % 26))}${r > 26 ? Math.floor((r - 1) / 26) : ''}`,
      layer: i,
      rings: sec.pieces[j].rings,
      poly: sec.pieces[j].poly,
      area: sec.pieces[j].area,
      bbox: bboxOf([sec.pieces[j].poly[0]]),
      kind: r === 0 ? 'main' : 'loose',
      support: 0, below: [], above: [], component: -1,
    }))
    faces.push(order.map(j => sec.faces[j]))
    const dims = (s: Section): [number, number] => {
      if (!s.pieces.length) return [0, 0]
      const b = bboxOf(s.pieces.map(q => q.poly[0]))
      return [b[2] - b[0], b[3] - b[1]]
    }
    const L: Layer = {
      index: i, name, zb, zt, zs, pieces, marks: [],
      outlineBot: dims(bot), outlineTop: dims(top),
      pockets: pieces.reduce((s, q) => s + q.rings.length - 1, 0),
    }
    layers.push(L)
    if (!pieces.length) warnings.push({ level: 'warn', layer: i, text: `${name} is empty (no material at z ${fmt(zs, 2)})` })
    const grow = [L.outlineTop[0] - L.outlineBot[0], L.outlineTop[1] - L.outlineBot[1]]
    if (Math.max(Math.abs(grow[0]), Math.abs(grow[1])) > 2)
      warnings.push({ level: 'info', layer: i, text: `${name}: the outline changes by ${fmt(grow[0])} × ${fmt(grow[1])} mm within the sheet (fillet or draft); "cut at" picks where it is cut` })
    const pc = pocketChange(bot, top)
    if (pc) warnings.push({ level: 'warn', layer: i, text: `${name}: ${pc}` })
  }

  // what rests on what
  progress('checking supports', 0.95)
  for (let i = 1; i < n; i++) {
    const L = layers[i], B = layers[i - 1]
    L.pieces.forEach((pc, a) => B.pieces.forEach((pb, b) => {
      if (!boxesOverlap(pc.bbox, pb.bbox)) return
      const ov = overlapArea(oc, faces[i][a], faces[i - 1][b], L.zs - B.zs)
      if (ov > 1) { pc.support += ov; pc.below.push(pb.id); pb.above.push(pc.id) }
    }))
  }

  // connected components through the stack
  const all = layers.flatMap(l => l.pieces)
  const byId = new Map(all.map(q => [q.id, q]))
  let comps = 0
  const sizes: number[] = []
  for (const q of all) {
    if (q.component >= 0) continue
    const stack = [q]
    q.component = comps
    let vol = 0
    while (stack.length) {
      const c = stack.pop()!
      vol += c.area
      for (const id of [...c.below, ...c.above]) {
        const o = byId.get(id)!
        if (o.component < 0) { o.component = comps; stack.push(o) }
      }
    }
    sizes.push(vol)
    comps++
  }
  const mainComp = sizes.indexOf(Math.max(...sizes))

  for (const L of layers) for (const q of L.pieces) {
    if (L.index > 0 && q.support === 0) q.kind = 'floating'
    if (q.kind === 'loose')
      warnings.push({ level: 'info', layer: L.index, piece: q.id,
        text: `${q.id} is a loose piece (${fmt(q.bbox[2] - q.bbox[0])} × ${fmt(q.bbox[3] - q.bbox[1])} mm)` +
              (q.below.length ? `; glue it onto ${q.below.join(', ')}` : '') })
    if (q.kind === 'floating')
      warnings.push({ level: 'warn', layer: L.index, piece: q.id,
        text: `${q.id} rests on nothing` + (q.above.length ? `; it hangs from ${q.above.join(', ')} above`
          : '; nothing rests on it either, it is not glued to the insert at all') })
    else if (L.index > 0 && q.support < 0.2 * q.area)
      warnings.push({ level: 'info', layer: L.index, piece: q.id,
        text: `${q.id} rests on only ${fmt(100 * q.support / q.area, 0)} % of its area` })
  }
  if (comps > 1) for (let c = 0; c < comps; c++) {
    if (c === mainComp) continue
    const ids = all.filter(q => q.component === c).map(q => q.id)
    if (ids.length === 1 && byId.get(ids[0])!.kind === 'floating') continue    // said above
    warnings.push({ level: 'warn', piece: ids[0],
      text: `${ids.join(', ')} ${ids.length > 1 ? 'form a separate part' : 'is a separate part'}, not glued to the rest of the insert` })
  }
  if (info.solids > 1)
    warnings.push({ level: 'info', text: `the model has ${info.solids} solids; where they overlap, the sections overlap too` })

  // floors inside a sheet
  const off = info.floors.filter(z => z > p.z0 + 1e-3 && z < zTop - 1e-3 && !bounds.some(b => Math.abs(b - z) < 1e-3))
  if (off.length)
    warnings.push({ level: 'warn', text: `pocket floors or steps inside a sheet: z = ${off.map(z => fmt(z, 2)).join(', ')}` })
  const rest = bb.max[2] - zTop
  if (rest > 1e-3)
    warnings.push({ level: 'warn', text: `the top ${fmt(rest, 2)} mm of the model (z ${fmt(zTop, 2)} … ${fmt(bb.max[2], 2)}) is not cut` })

  progress('labels', 0.98)
  if (p.marks) placeMarks(layers)
  if (p.labels) placeLabels(layers, p, warnings, mixed)
  if (p.marks && p.labels) labelMarks(layers, p)

  const fx = p.margin - bb.min[0], fy = p.margin - bb.min[1]
  return {
    params: p, bbox: bb,
    frame: { dx: fx, dy: fy, w: bb.max[0] - bb.min[0] + 2 * p.margin, h: bb.max[1] - bb.min[1] + 2 * p.margin },
    layers, components: comps, warnings, ms: Date.now() - t0,
  }
}

/** The sheet thicknesses to cut: the given stack, or the first thickness repeated. */
export function stackOf(p: SliceParams, top: number): number[] {
  if (p.stack.length) return p.stack
  const t = p.thicknesses[0]
  if (!(t > 0)) throw new Error('sheet thickness must be > 0')
  return Array.from({ length: Math.floor((top - p.z0) / t + 1e-6) }, () => t)
}

/** Sample the model on a grid and measure how much its walls move between heights. */
export function profile(sl: Slicer, z0: number, step: number, n: number, kmax: number,
                        progress: (text: string, frac: number) => void = () => {}): Profile {
  const t0 = Date.now()
  // two samples per cell: just above its bottom and just below its top
  const samples: Walls[] = []
  for (let i = 0; i < n; i++) {
    progress(`height profile ${i + 1} of ${n}`, i / n)
    for (const z of [z0 + i * step + EPS, z0 + (i + 1) * step - EPS]) samples.push(walls(sl.section(z)))
  }
  const memo = new Map<number, [number, number]>()
  const dev = (a: number, b: number): [number, number] => {
    if (a > b) [a, b] = [b, a]
    const key = a * 100000 + b
    let d = memo.get(key)
    if (!d) {
      d = [hausdorff(samples[a].outline, samples[b].outline), hausdorff(samples[a].inner, samples[b].inner)]
      memo.set(key, d)
    }
    return d
  }
  const outline: number[][] = [], pockets: number[][] = []
  for (let i = 0; i < n; i++) {
    const o: number[] = [], q: number[] = []
    let mo = 0, mq = 0
    for (let k = 1; k <= kmax && i + k <= n; k++) {
      // the new cell's two samples against every sample already in the sheet
      const lo = 2 * i, hi = 2 * (i + k) - 1
      for (const s of [hi - 1, hi]) for (let r = lo; r < s; r++) {
        const [a, b] = dev(r, s)
        if (a > mo) mo = a
        if (b > mq) mq = b
      }
      o.push(mo); q.push(mq)
    }
    outline.push(o); pockets.push(q)
  }
  const stepOutline: number[] = [], stepPockets: number[] = []
  for (let i = 1; i < n; i++) {
    const [a, b] = dev(2 * i - 1, 2 * i)
    stepOutline.push(a); stepPockets.push(b)
  }
  return { z0, step, n, kmax, outline, pockets, stepOutline, stepPockets, ms: Date.now() - t0 }
}

interface Walls { outline: Pt[][]; inner: Pt[][] }

/** The rings of a section split into the outer outline (outer rings that reach
 *  the section's bounding box) and the rest: pockets and islands. */
function walls(s: Section): Walls {
  if (!s.pieces.length) return { outline: [], inner: [] }
  const b = bboxOf(s.pieces.map(q => q.poly[0]))
  const out: Walls = { outline: [], inner: [] }
  for (const q of s.pieces) {
    const [x0, y0, x1, y1] = bboxOf([q.poly[0]])
    const edge = x0 - b[0] < 1 || y0 - b[1] < 1 || b[2] - x1 < 1 || b[3] - y1 < 1
    ;(edge ? out.outline : out.inner).push(q.poly[0])
    out.inner.push(...q.poly.slice(1))
  }
  return out
}

/** Pockets that are not the same at the bottom and the top of a sheet. */
function pocketChange(bot: Section, top: Section): string | null {
  const pockets = (s: Section) => s.pieces.flatMap(q => q.poly.slice(1).map(r => ({ b: bboxOf([r]), a: Math.abs(signedArea(r)) })))
  const pb = pockets(bot), pt = pockets(top)
  let changed = 0, area = 0
  const used = new Set<number>()
  for (const x of pb) {
    let best = -1, bd = Infinity
    pt.forEach((y, j) => {
      if (used.has(j)) return
      const d = Math.max(...x.b.map((v, k) => Math.abs(v - y.b[k])))
      if (d < bd) { bd = d; best = j }
    })
    if (best < 0 || bd > 0.5) { changed++; area += x.a; continue }
    used.add(best)
    const da = Math.abs(x.a - pt[best].a)
    if (da > 2 || bd > 0.2) { changed++; area += da }
  }
  pt.forEach((y, j) => { if (!used.has(j)) { changed++; area += y.a } })
  if (!changed) return null
  return `${changed} pocket${changed > 1 ? 's' : ''} change within the sheet (${fmt(area, 0)} mm²); a pocket floor or wall step lies inside it`
}

/** Engraved outlines of the loose pieces of the next sheet up, as polygons. */
function markLines(L: Layer): Pt[][] {
  return L.marks.map(m => ringPoints(m.rings[0]))
}

/** Piece ids on each piece's top face, where the sheet above covers them and
 *  clear of the placement outlines. Main pieces share one spot if there is one,
 *  so the ids stack up neatly. */
function placeLabels(layers: Layer[], p: SliceParams, warnings: Warning[], mixed: boolean) {
  const h = p.labelHeight
  const n = layers.length
  if (n < 2) return
  const above = (i: number) => layers[i + 1].pieces.flatMap(q => q.poly)
  // main pieces: id and height, plus the thickness when the stack is mixed
  const text = (L: Layer, q: Piece) => q.kind !== 'main' ? q.id
    : `${q.id} z${fmt(L.zb, 0)}` + (mixed ? ` t${fmt(L.zt - L.zb, 0)}` : '')
  // one spot for the main pieces of sheets 1..n-1, sized for the longest id
  const mains = layers.slice(0, n - 1).filter(L => L.pieces.length)
  if (mains.length) {
    const longest = mains.map(L => text(L, L.pieces[0])).reduce((a, b) => b.length > a.length ? b : a)
    const regions = mains.flatMap(L => [L.pieces[0].poly, above(L.index)])
    const b = mains[0].pieces[0].bbox
    const shared = makeLabel(regions, b, longest, h, [b[0], b[1]], { lines: mains.flatMap(markLines), boxes: [] })
    if (shared) for (const L of mains) L.pieces[0].label = { ...shared, text: text(L, L.pieces[0]) }
  }
  let missing = 0
  for (const L of layers.slice(0, n - 1)) {
    const avoid = { lines: markLines(L), boxes: [] as BBox[] }
    for (const q of L.pieces) {
      if (q.label) continue
      const reg = [q.poly, above(L.index)], o: Pt = [q.bbox[0], q.bbox[1]]
      const lab = makeLabel(reg, q.bbox, text(L, q), h, o, avoid)
        ?? makeLabel(reg, q.bbox, q.id, h, o, avoid)
        ?? makeLabel(reg, q.bbox, q.id, Math.max(2, h * 0.6), o, avoid)
      if (lab) q.label = lab
      else missing++
    }
  }
  if (missing) warnings.push({ level: 'info', text: `${missing} piece${missing > 1 ? 's have' : ' has'} no room for an engraved id under the next sheet` })
}

/** The outline of each loose / floating piece, engraved on the sheet below it. */
function placeMarks(layers: Layer[]) {
  for (const L of layers.slice(1)) {
    const B = layers[L.index - 1]
    for (const q of L.pieces)
      if (q.kind !== 'main' && q.below.length) B.marks.push({ piece: q.id, rings: [q.rings[0]] })
  }
}

/** The id of the piece that goes there, inside each placement outline, clear of
 *  the ids and the other outlines already on that sheet. */
function labelMarks(layers: Layer[], p: SliceParams) {
  for (const B of layers) {
    if (!B.marks.length) continue
    const below = B.pieces.flatMap(q => q.poly)
    const boxes = B.pieces.filter(q => q.label).map(q => labelBox(q.label!))
    for (const m of B.marks) {
      const outline = ringPoints(m.rings[0])
      const others = B.marks.filter(o => o !== m).map(o => ringPoints(o.rings[0]))
      const lab = makeLabel([[outline], below], bboxOf([outline]), m.piece, Math.min(p.labelHeight, 4),
        [bboxOf([outline])[0], bboxOf([outline])[1]], { lines: others, boxes })
      if (lab) { m.label = lab; boxes.push(labelBox(lab)) }
    }
  }
}

