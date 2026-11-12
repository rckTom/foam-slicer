// SPDX-License-Identifier: GPL-3.0-only
// Nesting the pieces onto foam: the browser version of nest.py's packing, as a
// search that keeps improving (like SVGnest).
//
// Every piece goes onto foam of its sheet's thickness.
//  - Pocket drop-outs: small pieces may go into the foam that falls out of the
//    pockets of bigger ones (by bounding box). If the host piece does not make
//    it onto the foam, the guest is packed like any other piece.
//  - Splits (optional): a piece may be cut into parts by straight seams, at most
//    `splitEdges` seams on any part's outline (1: one cut, two halves). Seams
//    stay clear of pockets (a wall of WALL mm left) and of arcs in the outline.
//    The bottom and / or top sheet can be kept whole.
//  - Laser bed (optional): pieces are grouped into blanks, each at most the
//    bed's size (the search may pick a smaller size that tiles the width) and
//    cut down to what it holds, so blanks come in all sizes. The blanks are
//    then packed onto the stock, either way round, a few orders tried
//    (touching: one hand cut between neighbours; the edge margin inside each
//    blank keeps the pieces off it). Every blank is one laser job.
// Pieces are packed by their bounding boxes with MaxRects, bottom-left
// (maxrects.ts). A part may also be given the second or third best spot: plain
// bottom-left never staggers columns past each other, and on the transport
// case insert that alone cost 1.7 % in length. The search varies the order
// (which also decides what shares a blank), the turns, the splits and those
// spot ranks, and keeps the best layout. Every other step comes from a genetic
// search (crossover and mutation in a small population), the rest from a late
// acceptance hill climber (Burke & Bykov), which crosses worse layouts the
// population would drop. Two modes:
//   stock  the raw pieces at hand (thickness, width x length, count):
//          least foam left unplaced, fewest stock pieces, fewest splits,
//          fewest blanks, then the best offcut
//   roll   a width per thickness: the shortest length (each split must save
//          SPLIT_COST of the width), then fewest blanks
// The offcut (stock mode) is the largest rectangle left beyond the used area,
// worth its area less CORNER per corner beyond four (one straight cut leaves four).
import { MaxRects } from './maxrects'
import { bboxOf, findSpot, inside, interiorPoint, makeLabel, ringPoints, signedArea } from './geom'
import type { BBox, Label, Layer, Piece, Pt, Ring, SliceResult } from './types'

export interface Stock { t: number; w: number; l: number; count: number }

export interface NestParams {
  mode: 'stock' | 'roll'
  stock: Stock[]
  widths: Record<string, number>    // roll mode: width per thickness ("10": 1000)
  gap: number                       // between cut lines
  edge: number                      // from the stock's and the blanks' edges
  rotate: boolean
  holes: boolean                    // use pocket drop-outs
  splitEdges: number                // 0: no splits; else the most seams on any part
  keepWhole: { bottom: boolean; top: boolean }   // never split the bottom / top sheet
  bed: { on: boolean; w: number; h: number }
}

export const DEFAULT_NEST: NestParams = {
  mode: 'stock', stock: [], widths: {}, gap: 3, edge: 5, rotate: true, holes: true,
  splitEdges: 0, keepWhole: { bottom: false, top: false }, bed: { on: false, w: 600, h: 400 },
}

const WALL = 15           // seams keep this far from pockets
const MIN_PART = 40       // narrowest part a split may leave
const SKY_TOL = 10        // steps in the used area's edge below this count as straight
const CORNER = 0.03       // offcut worth lost per corner beyond four
const SPLIT_COST = 0.1    // roll mode: a split must save this share of the width in length
const LAHC = 50           // late acceptance: how many steps back the walker compares
const LAHC_RESTART = 5000 // steps without a gain before it starts again from the best
const KICK = 6            // random moves away from the best when it starts again
const MAX_RANK = 2        // a part may pass over this many better bottom-left spots

/** 2D affine map (x, y) -> (a x + c y + e, b x + d y + f), as in SVG. */
export type Mat = [a: number, b: number, c: number, d: number, e: number, f: number]

export const apply = (m: Mat, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
const mul = (m: Mat, n: Mat): Mat => [   // m after n
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
]

/** Map a model bbox to (x, y) on the sheet, optionally turned 90 degrees ccw. */
function place(b: BBox, x: number, y: number, rot: boolean): Mat {
  return rot ? [0, 1, -1, 0, b[3] + x, -b[0] + y] : [1, 0, 0, 1, x - b[0], y - b[1]]
}

function boxOf(b: BBox, m: Mat): BBox {
  const c = [apply(m, b[0], b[1]), apply(m, b[2], b[3])]
  return [Math.min(c[0][0], c[1][0]), Math.min(c[0][1], c[1][1]), Math.max(c[0][0], c[1][0]), Math.max(c[0][1], c[1][1])]
}

// ---- shapes and splits -----------------------------------------------------------------------

/** x = c (axis 0) or y = c (axis 1), model coordinates. */
export interface Seam { axis: 0 | 1; c: number }

/** A piece or a part of a split piece, in model coordinates. */
export interface Shape {
  id: string              // L05, or L05.1, L05.2 for the parts of a split
  from: string            // the piece it comes from
  layer: number
  rings: Ring[]
  poly: Pt[][]
  bbox: BBox
  area: number
  seams: Seam[]           // seams on its outline
  label?: Label
}

const shapeOf = (q: Piece): Shape => ({ id: q.id, from: q.id, layer: q.layer, rings: q.rings, poly: q.poly, bbox: q.bbox, area: q.area, seams: [], label: q.label })

/** Where a piece may be split: lines clear of its pockets and the arcs of its
 *  outline, at the middle of each free stretch, the middle of the piece, its
 *  thirds, and where a part would just fit the given sizes. */
function seamCandidates(q: Shape, fits: number[]): Seam[] {
  const out: Seam[] = []
  const outerPts = q.poly[0]
  // arcs of the outline: their extent is off limits
  const arcs: BBox[] = []
  const ring = q.rings[0]
  for (let i = 0; i < ring.length; i++) if (ring[i][2]) arcs.push(bboxOf([ringPoints([ring[i], ring[(i + 1) % ring.length]].map((v, k) => k ? [v[0], v[1], 0] : v) as Ring)]))
  for (const axis of [0, 1] as const) {
    const lo = q.bbox[axis] + MIN_PART, hi = q.bbox[axis + 2] - MIN_PART
    if (hi <= lo) continue
    const bad: [number, number][] = [
      ...q.poly.slice(1).map(h => { const b = bboxOf([h]); return [b[axis] - WALL, b[axis + 2] + WALL] as [number, number] }),
      ...arcs.map(b => [b[axis] - 1, b[axis + 2] + 1] as [number, number]),
    ].sort((a, b) => a[0] - b[0])
    const free: [number, number][] = []
    let at = lo
    for (const [a, b] of bad) {
      if (a > at) free.push([at, Math.min(a, hi)])
      at = Math.max(at, b)
      if (at >= hi) break
    }
    if (at < hi) free.push([at, hi])
    const span = q.bbox[axis + 2] - q.bbox[axis]
    const wanted = [0.5, 1 / 3, 2 / 3].map(f => q.bbox[axis] + f * span)
    for (const f of fits) if (f > MIN_PART && f < span - MIN_PART) wanted.push(q.bbox[axis] + f, q.bbox[axis + 2] - f)
    const cs: number[] = []
    for (const [a, b] of free) {
      if (b - a < 1e-6) continue
      cs.push((a + b) / 2)
      for (const w of wanted) cs.push(Math.min(b, Math.max(a, w)))
    }
    const seen: number[] = []
    for (const c of cs.sort((a, b) => Math.abs(a - (q.bbox[axis] + span / 2)) - Math.abs(b - (q.bbox[axis] + span / 2)))) {
      if (seen.some(s => Math.abs(s - c) < 5)) continue
      if (outerPts.some(p => Math.abs(p[axis] - c) < 0.5)) continue
      seen.push(c)
      out.push({ axis, c })
    }
  }
  return out
}

/** Cut a shape in two along a seam that crosses its outline exactly twice, on
 *  straight edges, and misses its pockets. */
function splitShape(s: Shape, seam: Seam): [Shape, Shape] | null {
  const ax = seam.axis, c = seam.c
  if (s.bbox[ax] + MIN_PART > c || s.bbox[ax + 2] - MIN_PART < c) return null
  const ring = s.rings[0]
  const n = ring.length
  const side = (v: { [k: number]: number }) => (v[ax] < c ? -1 : 1)
  if (ring.some(v => Math.abs(v[ax] - c) < 0.5)) return null
  const cross: { i: number; p: [number, number, number] }[] = []
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n]
    if (a[2]) {   // an arc may not reach over the seam
      const pts = ringPoints([a, [b[0], b[1], 0]])
      if (pts.some(p => side(p) !== side(a)) || side(a) !== side(b)) return null
      continue
    }
    if (side(a) !== side(b)) {
      const t = (c - a[ax]) / (b[ax] - a[ax])
      const p: [number, number, number] = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), 0]
      p[ax] = c
      cross.push({ i, p })
    }
  }
  if (cross.length !== 2) return null
  const [c1, c2] = cross
  const chain = (from: { i: number; p: Ring[number] }, to: { i: number; p: Ring[number] }): Ring => {
    const out: Ring = [[from.p[0], from.p[1], 0]]
    for (let k = (from.i + 1) % n; ; k = (k + 1) % n) {
      const v = ring[k]
      out.push(k === to.i ? [v[0], v[1], 0] : [v[0], v[1], v[2]])
      if (k === to.i) break
    }
    out.push([to.p[0], to.p[1], 0])   // then the seam back to the start
    return out
  }
  const ra = chain(c1, c2), rb = chain(c2, c1)
  const holes = s.rings.slice(1)
  const holePolys = s.poly.slice(1)
  const make = (outer: Ring, k: number): Shape => {
    const sgn = side(outer[1])
    const keep = holes.map((h, j) => ({ h, p: holePolys[j] })).filter(x => side(x.p[0]) === sgn)
    if (keep.some(x => x.p.some(pt => side(pt) !== sgn || Math.abs(pt[ax] - c) < WALL - 1e-6))) throw new Error('pocket on the seam')
    const poly = [ringPoints(outer), ...keep.map(x => x.p)]
    const bbox = bboxOf([poly[0]])
    const area = Math.abs(signedArea(poly[0])) - keep.reduce((a, x) => a + Math.abs(signedArea(x.p)), 0)
    const seams = [...s.seams.filter(o => Math.abs(bbox[o.axis] - o.c) < 1e-6 || Math.abs(bbox[o.axis + 2] - o.c) < 1e-6), seam]
    return { id: `${s.id}#${k}`, from: s.from, layer: s.layer, rings: [outer, ...keep.map(x => x.h)], poly, bbox, area, seams }
  }
  try {
    const a = make(ra, 0), b = make(rb, 1)
    if (a.bbox[ax + 2] - a.bbox[ax] < MIN_PART || b.bbox[ax + 2] - b.bbox[ax] < MIN_PART) return null
    return [a, b]
  } catch { return null }
}

export interface Partition { pieces: Shape[]; owner: Map<string, number> }   // owner: guest id -> piece holding its pocket

/** Ways to split a piece, fewest parts first, every part with at most
 *  `maxEdges` seams. */
function partitions(q: Shape, maxEdges: number, fits: number[], limit = 40): Shape[][] {
  if (maxEdges < 1) return []
  const cands = seamCandidates(q, fits)
  const out: Shape[][] = []
  const seen = new Set<string>()
  let frontier: Shape[][] = [[q]]
  while (frontier.length && out.length < limit) {
    const next: Shape[][] = []
    for (const part of frontier) {
      for (let k = 0; k < part.length && out.length < limit; k++) {
        const s = part[k]
        if (s.seams.length >= maxEdges) continue
        for (const seam of cands) {
          if (s.seams.some(o => o.axis === seam.axis && Math.abs(o.c - seam.c) < 1e-6)) continue
          const two = splitShape(s, seam)
          if (!two || two.some(t => t.seams.length > maxEdges)) continue
          const p = [...part.slice(0, k), ...two, ...part.slice(k + 1)]
          const key = p.map(t => t.bbox.map(v => v.toFixed(1)).join(',')).sort().join('|')
          if (seen.has(key)) continue
          seen.add(key)
          out.push(p)
          next.push(p)
          if (out.length >= limit) break
        }
      }
    }
    frontier = next
  }
  // name the parts in reading order
  return out.map(p => [...p].sort((a, b) => (b.bbox[1] - a.bbox[1]) || (a.bbox[0] - b.bbox[0]))
    .map((s, k) => ({ ...s, id: `${q.id}.${k + 1}` })))
}

// ---- the job --------------------------------------------------------------------------------

export interface JobPart {
  id: string; layer: number; bbox: BBox; w: number; h: number; area: number
  shape: Shape
  /** In a pocket drop-out of this piece, placed by m in the host's model
   *  coordinates (at: a point in that pocket). Packed like any other piece if
   *  the host is not on the foam. */
  host?: { id: string; m: Mat; rot: boolean; at: Pt }
  splits: Partition[]
}

/** A rectangle to pack into: a whole stock piece, or the roll. */
export interface BinDef { sheet: number; w: number; h: number }

export interface Group {
  t: number
  parts: JobPart[]
  stock: { w: number; l: number }[] // stock mode, largest first
  width: number                     // roll mode
  bins: BinDef[]                    // the stock pieces, or the roll
  blankSizes: [number, number][]    // laser bed: blank sizes the search may fill (the bed either way, and
                                    // widths that tile the roll / stock across, capped at the bed)
  skipped: { id: string; why: string }[]
}

export interface NestJob {
  mode: NestParams['mode']; gap: number; edge: number; rotate: boolean; bed: NestParams['bed']
  splitEdges: number
  groups: Group[]
  above: Map<number, Pt[][]>        // material of the sheet above each layer, for labels of split parts
}

export function thicknessesOf(layers: Layer[]): number[] {
  return [...new Set(layers.map(thick))].sort((a, b) => a - b)
}
const thick = (L: Layer) => Math.round((L.zt - L.zb) * 100) / 100

/** Group the pieces by thickness, fill the pocket drop-outs, work out the
 *  splits, sort out what can't go anywhere. */
export function prepare(layers: Layer[], np: NestParams): NestJob {
  const bed = np.bed.on && np.bed.w > 0 && np.bed.h > 0 ? { ...np.bed } : { on: false, w: 0, h: 0 }
  const above = new Map<number, Pt[][]>()
  for (const L of layers) above.set(L.index, layers[L.index + 1]?.pieces.flatMap(q => q.poly) ?? [])
  const top = Math.max(...layers.map(L => L.index))
  const job: NestJob = { mode: np.mode, gap: np.gap, edge: np.edge, rotate: np.rotate, bed, splitEdges: Math.max(0, Math.floor(np.splitEdges)), groups: [], above }
  for (const t of thicknessesOf(layers)) {
    const pieces = layers.filter(L => thick(L) === t).flatMap(L => L.pieces).sort((a, b) => b.area - a.area)
    const guests = np.holes ? fillHoles(pieces, np) : new Map()
    const stock = np.stock.filter(s => s.t === t && s.w > 0 && s.l > 0)
      .flatMap(s => Array.from({ length: Math.max(0, Math.floor(s.count)) }, () => ({ w: s.w, l: s.l })))
      .sort((a, b) => b.w * b.l - a.w * a.l)
    const width = np.widths[String(t)] ?? 0
    const tall = pieces.reduce((s, q) => s + Math.max(q.bbox[2] - q.bbox[0], q.bbox[3] - q.bbox[1]) + np.gap + 2 * np.edge, 0) + 1
    const bins: BinDef[] = np.mode === 'roll' ? (width > 0 ? [{ sheet: 0, w: width, h: tall }] : [])
      : stock.map((s, k) => ({ sheet: k, w: s.w, h: s.l }))
    const blankSizes: [number, number][] = []
    if (bed.on) for (const [bw, bh] of [[bed.w, bed.h], [bed.h, bed.w]] as [number, number][]) {
      if (!blankSizes.some(([w, h]) => w === bw && h === bh)) blankSizes.push([bw, bh])
      for (const W of new Set(bins.map(b => b.w))) for (let k = 2; k <= 5; k++) {
        const w = Math.floor(W / k)
        if (w < bw && w >= 100 && !blankSizes.some(([x, y]) => x === w && y === bh)) blankSizes.push([w, bh])
      }
    }
    const g: Group = { t, parts: [], stock, width, bins, blankSizes, skipped: [] }
    // the room a part has: the stock, or a blank no larger than the bed (either way round)
    const rooms: [number, number][] = bins.flatMap(b => bed.on
      ? [[Math.min(bed.w, b.w), Math.min(bed.h, b.h)], [Math.min(bed.h, b.w), Math.min(bed.w, b.h)]] as [number, number][]
      : [[b.w, b.h] as [number, number]]).map(([w, h]) => [w - 2 * np.edge, h - 2 * np.edge])
    const fits = (w: number, h: number) => rooms.some(([W, H]) => (w <= W && h <= H) || (np.rotate && h <= W && w <= H))
    const sizes = [...new Set(rooms.flat().filter(v => v > 0 && v < 1e5).map(v => Math.round(v)))]
    for (const q of pieces) {
      const gu = guests.get(q.id)
      const shape = shapeOf(q)
      const whole = (np.keepWhole.bottom && q.layer === 0) || (np.keepWhole.top && q.layer === top)
      const parts = job.splitEdges && !whole ? partitions(shape, job.splitEdges, sizes) : []
      const owner = (p: Shape[]) => {
        const m = new Map<string, number>()
        for (const [gid, x] of guests) if (x.host === q.id) m.set(gid, p.findIndex(s => inside(s.poly, x.at[0], x.at[1])))
        return m
      }
      const p: JobPart = {
        id: q.id, layer: q.layer, bbox: q.bbox, w: q.bbox[2] - q.bbox[0], h: q.bbox[3] - q.bbox[1], area: q.area, shape,
        ...(gu ? { host: { id: gu.host, m: gu.m, rot: gu.rot, at: gu.at } } : {}),
        splits: parts.filter(ps => ps.every(s => fits(s.bbox[2] - s.bbox[0], s.bbox[3] - s.bbox[1]))).map(ps => ({ pieces: ps, owner: owner(ps) })),
      }
      if (!rooms.length) g.skipped.push({ id: q.id, why: np.mode === 'roll' ? `no width given for ${t} mm` : `no ${t} mm stock given` })
      else if (!fits(p.w, p.h) && !p.splits.length)
        g.skipped.push({ id: q.id, why: (bed.on ? 'larger than the laser bed' : np.mode === 'roll' ? `wider than ${width} mm` : 'larger than every stock piece') +
          (job.splitEdges && !whole ? ', and no split fits' : whole && job.splitEdges ? ' (kept whole)' : '') })
      else g.parts.push(p)
    }
    job.groups.push(g)
  }
  return job
}

/** Put pieces into the pockets of bigger pieces of the same thickness, by their
 *  bounding box, `gap` clear of the pocket's cut. Returns guest -> placement in
 *  the host's model coordinates. */
function fillHoles(pieces: Piece[], np: NestParams) {
  const holes: { host: string; poly: Pt[]; b: BBox; taken: BBox[] }[] = []
  for (const h of pieces) for (const r of h.poly.slice(1)) holes.push({ host: h.id, poly: r, b: bboxOf([r]), taken: [] })
  holes.sort((a, b) => (a.b[2] - a.b[0]) * (a.b[3] - a.b[1]) - (b.b[2] - b.b[0]) * (b.b[3] - b.b[1]))   // small first
  const out = new Map<string, { host: string; m: Mat; rot: boolean; at: Pt }>()
  for (const g of pieces) {                                 // largest first: they need the room most
    const gw = g.bbox[2] - g.bbox[0], gh = g.bbox[3] - g.bbox[1]
    search: for (const hole of holes) {
      if (hole.host === g.id || out.get(hole.host)?.host === g.id) continue
      const hw = hole.b[2] - hole.b[0], hh = hole.b[3] - hole.b[1]
      for (const rot of np.rotate ? [false, true] : [false]) {
        const [w, h] = rot ? [gh, gw] : [gw, gh]
        if (w + 2 * np.gap > hw || h + 2 * np.gap > hh) continue
        const step = Math.max(1, Math.min(hw, hh) / 60)
        const s = findSpot([[hole.poly]], hole.b, w, h, np.gap, [hole.b[0], hole.b[1]], { lines: [], boxes: hole.taken }, step)
        if (!s) continue
        hole.taken.push([s[0], s[1], s[0] + w, s[1] + h])
        out.set(g.id, { host: hole.host, m: place(g.bbox, s[0], s[1], rot), rot, at: [s[0] + w / 2, s[1] + h / 2] })
        break search
      }
    }
  }
  return out
}

// ---- layouts ----------------------------------------------------------------------------------

/** blank: index into Group.blankSizes; rank: per part, which bottom-left
 *  spot it takes (0 the best, 1 the next, ... up to MAX_RANK) */
export interface Gene { order: number[]; rot: boolean[]; split: number[]; blank: number; rank: number[] }

/** A part on the foam: m maps its model coordinates to the sheet. */
export interface Spot { i: number; k: number; sheet: number; blank: number; m: Mat; rot: boolean }   // k: part of a split, -1 whole

/** A blank cut from the stock, as it lies there (w, h after any turn). */
export interface BlankDef { sheet: number; x: number; y: number; w: number; h: number; rot: boolean }

export interface Layout {
  spots: Spot[]
  blanks: BlankDef[]
  used: number[]                // stock mode: per sheet the length used; roll mode: [length]
  lost: { i: number; k: number }[]
  rem: Map<number, Remnant>     // per sheet
  score: number[]               // compared left to right, lower is better
}

/** The leftover beyond the used area of a W x H sheet. */
export interface Remnant { x: number; y: number; w: number; h: number; edges: number; value: number; sky: [x0: number, x1: number, top: number][] }

/** Skyline of the used rectangles (the far side of the used area across the
 *  sheet, steps under SKY_TOL straightened), the largest rectangle beyond it,
 *  and its worth: area, less CORNER for each corner beyond four. */
export function remnant(rects: { x: number; y: number; w: number; h: number }[], W: number, H: number): Remnant {
  const xs = [...new Set([0, W, ...rects.flatMap(r => [r.x, r.x + r.w])].map(v => Math.min(W, Math.max(0, v))))].sort((a, b) => a - b)
  const raw: [number, number, number][] = []
  for (let k = 0; k + 1 < xs.length; k++) {
    const a = xs[k], b = xs[k + 1]
    if (b - a < 1e-6) continue
    const mid = (a + b) / 2
    let top = 0
    for (const r of rects) if (r.x <= mid && mid <= r.x + r.w) top = Math.max(top, r.y + r.h)
    raw.push([a, b, Math.min(H, top)])
  }
  const sky: Remnant['sky'] = []
  let lo = Infinity
  for (const [a, b, t] of raw) {
    const last = sky[sky.length - 1]
    if (last && Math.max(last[2], t) - Math.min(lo, t) <= SKY_TOL) { last[1] = b; last[2] = Math.max(last[2], t); lo = Math.min(lo, t) }
    else { sky.push([a, b, t]); lo = t }
  }
  let best = { x: 0, y: H, w: 0, h: 0, area: 0 }
  for (let i = 0; i < sky.length; i++) {
    let top = 0
    for (let j = i; j < sky.length; j++) {
      top = Math.max(top, sky[j][2])
      const w = sky[j][1] - sky[i][0], h = H - top
      if (w * h > best.area) best = { x: sky[i][0], y: top, w, h, area: w * h }
    }
  }
  // corners: where the used area reaches the far end the leftover falls apart;
  // each piece of it has 4 corners plus 2 per step
  let edges = 0, run = 0
  for (const [, , top] of [...sky, [0, 0, H] as [number, number, number]]) {
    if (top < H - 1e-6) run++
    else if (run) { edges += 4 + 2 * (run - 1); run = 0 }
  }
  return { ...best, edges, value: best.area * Math.pow(1 - CORNER, Math.max(0, edges - 4)), sky }
}

export function better(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - 1e-6) return true
    if (a[i] > b[i] + 1e-6) return false
  }
  return false
}

const piecesOf = (p: JobPart, split: number): Shape[] => (split >= 0 && p.splits[split] ? p.splits[split].pieces : [p.shape])

/** Lay out one group by the gene. Parts are grown by the gap and bins shrunk
 *  by the edge margin (plus the gap), so the spacing comes out right without
 *  the packer knowing about it. Without a laser bed the parts go straight onto
 *  the stock, first fit; with one they first fill blanks (first fit, each at
 *  most the bed, cut down to its contents) and the blanks go onto the stock. */
export function decode(job: NestJob, g: Group, gene: Gene): Layout {
  const gap = job.gap, edge = job.edge
  const index = new Map(g.parts.map((p, i) => [p.id, i]))
  const onFoam = new Set<string>()            // "i:k"
  const rides = (i: number, depth = 0): boolean => {
    const h = g.parts[i].host
    if (!h || depth > 8) return false
    const hi = index.get(h.id)
    if (hi === undefined) return false
    const sp = gene.split[hi]
    const k = sp >= 0 && g.parts[hi].splits[sp] ? g.parts[hi].splits[sp].owner.get(g.parts[i].id) ?? -1 : -1
    return onFoam.has(`${hi}:${k}`) || rides(hi, depth + 1)
  }
  // the parts in packing order: pieces of their own first, then drop-out
  // guests whose host did not make it (decided as we go), biggest first
  const pass2 = gene.order.filter(i => g.parts[i].host).sort((a, b) => g.parts[b].area - g.parts[a].area)
  const order = [...gene.order.filter(i => !g.parts[i].host), ...pass2]
  const prefs = (i: number) => (job.rotate ? [gene.rot[i], !gene.rot[i]] : [false])
  const lost: Layout['lost'] = []
  const spots: Spot[] = []
  const blanks: BlankDef[] = []
  const sheetTop = g.bins.map(() => 0)

  /** Put a w x h (grown) rectangle into one of the packers, first fit. */
  const firstFit = (packs: MaxRects[], w: number, h: number, turn: boolean[], rank: number) => {
    for (let b = 0; b < packs.length; b++) for (const rot of turn) {
      const [rw, rh] = rot ? [h, w] : [w, h]
      const r = packs[b].find(rw, rh, rank)
      if (r) { packs[b].place(r); return { b, x: r.x, y: r.y, rot, rw, rh } }
    }
    return null
  }
  const dims = (s: Shape): [number, number] => [s.bbox[2] - s.bbox[0] + gap, s.bbox[3] - s.bbox[1] + gap]

  if (!job.bed.on) {
    const packs = g.bins.map(b => new MaxRects(b.w - 2 * edge + gap, b.h - 2 * edge + gap))
    for (const i of order) {
      if (rides(i)) continue
      const ps = piecesOf(g.parts[i], gene.split[i])
      ps.forEach((s, kk) => {
        const k = ps.length > 1 ? kk : -1
        const [w, h] = dims(s)
        const r = firstFit(packs, w, h, prefs(i), gene.rank[i] ?? 0)
        if (!r) { lost.push({ i, k }); return }
        onFoam.add(`${i}:${k}`)
        sheetTop[r.b] = Math.max(sheetTop[r.b], r.y + r.rh)
        spots.push({ i, k, sheet: g.bins[r.b].sheet, blank: -1, m: place(s.bbox, edge + r.x, edge + r.y, r.rot), rot: r.rot })
      })
    }
  } else {
    // 1. blanks: first fit into the open ones; a new one has the gene's size,
    //    or the whole bed (either way) if the part needs it
    const sizes = g.blankSizes
    const tryOrder = [gene.blank % sizes.length, 0, 1].filter((v, k, a) => v < sizes.length && a.indexOf(v) === k)
    const open: { pk: MaxRects; items: { i: number; k: number; s: Shape; x: number; y: number; rot: boolean }[]; ex: number; ey: number }[] = []
    for (const i of order) {
      if (rides(i)) continue
      const ps = piecesOf(g.parts[i], gene.split[i])
      ps.forEach((s, kk) => {
        const k = ps.length > 1 ? kk : -1
        const [w, h] = dims(s)
        let r = firstFit(open.map(o => o.pk), w, h, prefs(i), gene.rank[i] ?? 0)
        if (!r) {
          for (const z of tryOrder) {
            const pk = new MaxRects(sizes[z][0] - 2 * edge + gap, sizes[z][1] - 2 * edge + gap)
            const q = firstFit([pk], w, h, prefs(i), gene.rank[i] ?? 0)
            if (q) { open.push({ pk, items: [], ex: 0, ey: 0 }); r = { ...q, b: open.length - 1 }; break }
          }
          if (!r) { lost.push({ i, k }); return }
        }
        const o = open[r.b]
        o.items.push({ i, k, s, x: r.x, y: r.y, rot: r.rot })
        o.ex = Math.max(o.ex, r.x + r.rw)
        o.ey = Math.max(o.ey, r.y + r.rh)
        onFoam.add(`${i}:${k}`)      // provisional: undone below if its blank finds no stock
      })
    }
    // 2. the blanks, cut down to what they hold, onto the stock, touching. Each
    //    goes where its far edge ends lowest, either way round; a few orders are
    //    tried and the best kept (roll: shortest; stock: fewest pieces, best offcut)
    const sized = open.map(o => ({ o, w: o.ex - gap + 2 * edge, h: o.ey - gap + 2 * edge, area: o.items.reduce((a, it) => a + it.s.area, 0) }))
    const orders = [
      [...sized].sort((p, q) => q.w * q.h - p.w * p.h),
      [...sized].sort((p, q) => Math.max(q.w, q.h) - Math.max(p.w, p.h)),
      [...sized].sort((p, q) => Math.min(q.w, q.h) - Math.min(p.w, p.h)),
      sized,
    ]
    type Put = { it: typeof sized[number]; b: number; x: number; y: number; rot: boolean; rw: number; rh: number }
    let best: { put: Put[]; out: typeof sized; key: number[] } | null = null
    for (const ord of orders) for (const pref of job.rotate ? [false, true] : [false]) {
      const packs = g.bins.map(bn => new MaxRects(bn.w, bn.h))
      const put: Put[] = [], out: typeof sized = []
      for (const it of ord) {
        let pick: (Put & { r: { x: number; y: number; w: number; h: number } }) | null = null
        for (let bi = 0; bi < packs.length && !pick; bi++) {
          for (const rot of job.rotate ? [pref, !pref] : [false]) {
            const [rw, rh] = rot ? [it.h, it.w] : [it.w, it.h]
            const r = packs[bi].find(rw, rh)
            if (r && (!pick || r.y + rh < pick.y + pick.rh - 1e-6 || (Math.abs(r.y + rh - pick.y - pick.rh) <= 1e-6 && r.x < pick.x)))
              pick = { it, b: bi, x: r.x, y: r.y, rot, rw, rh, r }
          }
        }
        if (!pick) { out.push(it); continue }
        packs[pick.b].place(pick.r)
        put.push(pick)
      }
      const lostA = out.reduce((a, it) => a + it.area, 0)
      let key: number[]
      if (job.mode === 'roll') key = [lostA, put.length ? Math.max(...put.map(q => q.y + q.rh)) : 0]
      else {
        const used = [...new Set(put.map(q => g.bins[q.b].sheet))]
        const off = Math.max(0, ...used.map(sh => remnant(put.filter(q => g.bins[q.b].sheet === sh).map(q => ({ x: q.x, y: q.y, w: q.rw, h: q.rh })), g.stock[sh].w, g.stock[sh].l).value))
        key = [lostA, used.length, -off]
      }
      if (!best || better(key, best.key)) best = { put, out, key }
    }
    for (const it of best?.out ?? [])
      for (const x of it.o.items) { onFoam.delete(`${x.i}:${x.k}`); lost.push({ i: x.i, k: x.k }) }
    for (const q of best?.put ?? []) {
      const sheet = g.bins[q.b].sheet
      sheetTop[q.b] = Math.max(sheetTop[q.b], q.y + q.rh)
      const bi = blanks.push({ sheet, x: q.x, y: q.y, w: q.rw, h: q.rh, rot: q.rot }) - 1
      // blank coordinates -> sheet: turned 90 degrees ccw about its corner if it lies turned
      const T: Mat = q.rot ? [0, 1, -1, 0, q.x + q.it.h, q.y] : [1, 0, 0, 1, q.x, q.y]
      for (const it of q.it.o.items)
        spots.push({ i: it.i, k: it.k, sheet, blank: bi, m: mul(T, place(it.s.bbox, edge + it.x, edge + it.y, it.rot)), rot: it.rot !== q.rot })
    }
  }

  const lostReal = lost.filter(l => !rides(l.i))
  const lostArea = lostReal.reduce((a, l) => a + (l.k < 0 ? g.parts[l.i].area : piecesOf(g.parts[l.i], gene.split[l.i])[l.k].area), 0)
  const extra = g.parts.reduce((a, p, i) => a + piecesOf(p, gene.split[i]).length - 1, 0)
  // the used area: the blanks, or the parts with their gap
  const usedRects = (sheet: number) => job.bed.on
    ? blanks.filter(b => b.sheet === sheet)
    : spots.filter(s => s.sheet === sheet).map(s => {
      const sh = piecesOf(g.parts[s.i], gene.split[s.i])[Math.max(0, s.k)]
      const b = boxOf(sh.bbox, s.m)
      return { x: b[0], y: b[1], w: b[2] - b[0] + gap, h: b[3] - b[1] + gap }
    })
  const ends = (rects: { y: number; h: number }[]) =>
    rects.length ? Math.ceil(Math.max(...rects.map(r => r.y + r.h)) + (job.bed.on ? 0 : edge - gap)) : 0
  const rem = new Map<number, Remnant>()
  const used: number[] = []
  if (job.mode === 'roll') {
    const rects = usedRects(0)
    // a roll: what counts is the length used (the rest of the roll is no offcut)
    const length = ends(rects)
    used.push(length)
    return { spots, blanks, used, lost: lostReal, rem, score: [lostReal.length, length + extra * SPLIT_COST * g.width, blanks.length] }
  }
  let offcut = 0, sheets = 0
  for (let s = 0; s < g.stock.length; s++) {
    const rects = usedRects(s)
    used.push(ends(rects))
    if (!rects.length) continue
    sheets++
    const r = remnant(rects, g.stock[s].w, g.stock[s].l)
    rem.set(s, r)
    offcut = Math.max(offcut, r.value)
  }
  return { spots, blanks, used, lost: lostReal, rem, score: [lostArea, sheets, extra, blanks.length, -offcut] }
}

// ---- search -------------------------------------------------------------------------------------

/** Steady-state genetic search over orders, turns, splits and the bed's lie for one group. */
export class Search {
  pop: { gene: Gene; lay: Layout }[] = []
  best: { gene: Gene; lay: Layout }
  evals = 0

  constructor(readonly job: NestJob, readonly g: Group, private rnd: () => number = Math.random) {
    const n = g.parts.length
    const idx = [...Array(n).keys()]
    const by = (f: (p: JobPart) => number) => [...idx].sort((a, b) => f(g.parts[b]) - f(g.parts[a]))
    // lie long side along the length: across the stock goes the short side
    const along = idx.map(i => g.parts[i].w > g.parts[i].h)
    const none = idx.map(() => -1)
    const zero = idx.map(() => 0)
    // pieces that fit nowhere whole start out split (the first split that fits)
    const must = idx.map(i => (g.parts[i].splits.length && !this.fitsWhole(g.parts[i]) ? 0 : -1))
    const nb = Math.max(1, g.blankSizes.length)
    const seeds: Gene[] = [
      { order: by(p => p.area), rot: along, split: must, blank: 0, rank: zero },
      { order: by(p => Math.max(p.w, p.h)), rot: along, split: must, blank: 1 % nb, rank: zero },
      { order: by(p => p.h), rot: idx.map(() => false), split: must, blank: 2 % nb, rank: zero },
      { order: by(p => p.w), rot: idx.map(() => true), split: must, blank: 3 % nb, rank: zero },
      { order: by(p => p.w + p.h), rot: along.map(v => !v), split: none, blank: 0, rank: zero },
    ]
    for (let z = 4; z < nb; z++) seeds.push({ ...seeds[0], blank: z })
    for (const s of seeds) this.pop.push(this.eval(s))
    while (this.pop.length < Math.min(24, 6 + 2 * n)) this.pop.push(this.eval(this.mutate(seeds[this.pop.length % 2], 0.3)))
    this.best = this.pop.reduce((a, b) => (better(b.lay.score, a.lay.score) ? b : a))
  }

  private fitsWhole(p: JobPart): boolean {
    const e = this.job.edge, bed = this.job.bed
    return this.g.bins.some(b => {
      const rooms = bed.on ? [[Math.min(bed.w, b.w), Math.min(bed.h, b.h)], [Math.min(bed.h, b.w), Math.min(bed.w, b.h)]] : [[b.w, b.h]]
      return rooms.some(([W0, H0]) => {
        const W = W0 - 2 * e, H = H0 - 2 * e
        return (p.w <= W && p.h <= H) || (this.job.rotate && p.h <= W && p.w <= H)
      })
    })
  }

  private eval(gene: Gene) {
    this.evals++
    return { gene, lay: decode(this.job, this.g, gene) }
  }

  private pick() {
    const a = this.pop[Math.floor(this.rnd() * this.pop.length)], b = this.pop[Math.floor(this.rnd() * this.pop.length)]
    return better(a.lay.score, b.lay.score) ? a : b
  }

  /** Order crossover: a slice of one parent, the rest in the other's order. */
  private cross(a: Gene, b: Gene): Gene {
    const n = a.order.length
    const mix = <T>(x: T[], y: T[]) => x.map((v, k) => (this.rnd() < 0.5 ? v : y[k]))
    const blank = this.rnd() < 0.5 ? a.blank : b.blank
    if (n < 3) return { order: [...a.order], rot: mix(a.rot, b.rot), split: mix(a.split, b.split), blank, rank: mix(a.rank, b.rank) }
    let i = Math.floor(this.rnd() * n), j = Math.floor(this.rnd() * n)
    if (i > j) [i, j] = [j, i]
    const mid = a.order.slice(i, j + 1)
    const keep = new Set(mid)
    const rest = b.order.filter(v => !keep.has(v))
    return { order: [...rest.slice(0, i), ...mid, ...rest.slice(i)], rot: mix(a.rot, b.rot), split: mix(a.split, b.split), blank, rank: mix(a.rank, b.rank) }
  }

  private mutate(g: Gene, rate = 0.08): Gene {
    const order = [...g.order], rot = [...g.rot], split = [...g.split], rank = [...g.rank]
    const n = order.length
    for (let k = 0; k < n; k++) {
      if (this.rnd() < rate) {
        const j = this.rnd() < 0.7 ? Math.min(n - 1, k + 1) : Math.floor(this.rnd() * n)
        ;[order[k], order[j]] = [order[j], order[k]]
      }
      if (this.job.rotate && this.rnd() < rate / 2) rot[k] = !rot[k]
      const ns = this.g.parts[k].splits.length
      if (ns && this.rnd() < rate / 2) split[k] = this.rnd() < 0.4 ? -1 : Math.floor(this.rnd() * ns)
      if (this.rnd() < rate / 2) rank[k] = this.rnd() < 0.5 ? 0 : 1 + Math.floor(this.rnd() * MAX_RANK)
    }
    const nb = this.g.blankSizes.length
    const blank = nb > 1 && this.rnd() < rate ? Math.floor(this.rnd() * nb) : g.blank
    return { order, rot, split, blank, rank }
  }

  // late acceptance hill climbing (Burke & Bykov): a walker that takes a
  // small move when the result is no worse than where it stood LAHC steps ago,
  // so it gets across worse layouts that the population would not keep
  private walk: { gene: Gene; lay: Layout } | null = null
  private hist: number[][] = []
  private since = 0
  private turn = 0

  private nudge(g: Gene): Gene {
    const n = g.order.length
    const order = [...g.order], rot = [...g.rot], split = [...g.split], rank = [...g.rank]
    const k = Math.floor(this.rnd() * n), u = this.rnd()
    if (u < 0.35) rank[k] = this.rnd() < 0.4 ? 0 : 1 + Math.floor(this.rnd() * MAX_RANK)
    else if (u < 0.75 && n > 1) { const j = this.rnd() < 0.5 ? (k + 1) % n : Math.floor(this.rnd() * n); [order[k], order[j]] = [order[j], order[k]] }
    else if (u < 0.9 && this.job.rotate) rot[k] = !rot[k]
    else if (this.g.parts[k].splits.length) split[k] = this.rnd() < 0.4 ? -1 : Math.floor(this.rnd() * this.g.parts[k].splits.length)
    else rot[k] = this.job.rotate ? !rot[k] : rot[k]
    const nb = this.g.blankSizes.length
    return { order, rot, split, rank, blank: nb > 1 && this.rnd() < 0.05 ? Math.floor(this.rnd() * nb) : g.blank }
  }

  private lahc(): { gene: Gene; lay: Layout } {
    if (!this.walk || this.since > LAHC_RESTART) {   // start again from the best, kicked a few moves away
      let g = this.best.gene
      if (this.walk) for (let k = 0; k < KICK; k++) g = this.nudge(g)
      this.walk = this.eval(g); this.hist = Array(LAHC).fill(this.walk.lay.score); this.since = 0
    }
    const c = this.eval(this.nudge(this.walk.gene))
    const v = this.evals % LAHC
    if (!better(this.walk.lay.score, c.lay.score) || !better(this.hist[v], c.lay.score)) {
      if (better(c.lay.score, this.walk.lay.score)) this.since = 0
      this.walk = c
    }
    this.since++
    if (better(this.walk.lay.score, this.hist[v])) this.hist[v] = this.walk.lay.score
    return c
  }

  /** One child; true if it beat the best so far. */
  step(): boolean {
    if (this.g.parts.length < 2 && !this.g.parts.some(p => p.splits.length) && this.g.blankSizes.length < 2) return false
    const child = this.turn++ % 2 ? this.lahc() : this.eval(this.mutate(this.cross(this.pick().gene, this.pick().gene)))
    let worst = 0
    for (let k = 1; k < this.pop.length; k++) if (better(this.pop[worst].lay.score, this.pop[k].lay.score)) worst = k
    if (better(child.lay.score, this.pop[worst].lay.score)) this.pop[worst] = child
    if (better(child.lay.score, this.best.lay.score)) { this.best = child; return true }
    return false
  }
}

// ---- result -------------------------------------------------------------------------------------

export interface Placed {
  id: string              // piece id, or L05.1 for part of a split piece
  from: string            // the piece it is (part of)
  layer: number
  m: Mat                  // model -> sheet coordinates
  rot: boolean
  host?: string           // in a pocket drop-out of this piece
  bin?: string            // the blank it is on (with a laser bed)
  box: BBox               // on the sheet
}

export interface Blank { name: string; x: number; y: number; w: number; h: number; used: boolean }   // as it lies on the stock

/** What is left of a piece of stock: the largest rectangle beyond the used
 *  area, the line along the used area's far side (the cut that takes the rest
 *  off) and how many corners the leftover has (4: one straight cut). */
export interface Offcut { x: number; y: number; w: number; h: number; edges: number; line: Pt[] }

export interface NestSheet {
  name: string            // 10-1, 10-2 ... (thickness - number)
  t: number
  w: number
  l: number               // stock length (roll mode: the length needed)
  used: number            // length used
  parts: Placed[]
  blanks?: Blank[]        // with a laser bed
  offcut?: Offcut
  area: number            // of the pieces
}

export interface NestResult {
  sheets: NestSheet[]
  shapes: Shape[]         // the parts of split pieces
  unplaced: { id: string; t: number; why: string }[]
  unused: Stock[]         // stock mode: pieces left over
  totals: { t: number; sheets: number; blanks: number; splits: number; length?: number; width?: number; area: number; fill: number }[]
}

/** The best layouts as sheets, with the drop-out guests riding on their hosts. */
export function assemble(job: NestJob, best: { gene: Gene; lay: Layout }[]): NestResult {
  const out: NestResult = { sheets: [], shapes: [], unplaced: [], unused: [], totals: [] }
  job.groups.forEach((g, gi) => {
    const { gene, lay } = best[gi]
    const nSheets = job.mode === 'roll' ? 1 : g.stock.length
    const sheets: (NestSheet | null)[] = Array.from({ length: nSheets }, (_, s) => {
      const spots = lay.spots.filter(x => x.sheet === s)
      if (!spots.length) return null
      const W = job.mode === 'roll' ? g.width : g.stock[s].w
      const L = job.mode === 'roll' ? lay.used[0] : g.stock[s].l
      // blanks named A, B, ... along the sheet
      const mine = lay.blanks.map((b, k) => ({ b, k })).filter(x => x.b.sheet === s)
        .sort((p, q) => (p.b.y - q.b.y) || (p.b.x - q.b.x))
      const names = new Map(mine.map((x, n) => [x.k, n < 26 ? String.fromCharCode(65 + n) : `Z${n - 25}`]))
      const sheet: NestSheet = {
        name: `${g.t}-${out.sheets.filter(x => x.t === g.t).length + 1}`, t: g.t, w: W, l: L, used: lay.used[job.mode === 'roll' ? 0 : s], area: 0,
        parts: spots.map(x => {
          const p = g.parts[x.i]
          const sh = x.k < 0 ? p.shape : piecesOf(p, gene.split[x.i])[x.k]
          if (x.k >= 0) { labelPart(job, p, sh); if (!out.shapes.includes(sh)) out.shapes.push(sh) }
          return { id: sh.id, from: p.id, layer: p.layer, m: x.m, rot: x.rot, bin: x.blank >= 0 ? names.get(x.blank) : undefined, box: boxOf(sh.bbox, x.m) }
        }),
      }
      if (job.bed.on) sheet.blanks = mine.map(x => ({ name: names.get(x.k)!, x: x.b.x, y: x.b.y, w: x.b.w, h: x.b.h, used: true }))
      const r = lay.rem.get(s)
      if (r && r.w > 0 && r.h > 0) {
        const line: Pt[] = []
        for (const [a, b, top] of r.sky) line.push([a, top], [b, top])
        sheet.offcut = { x: r.x, y: r.y, w: r.w, h: r.h, edges: r.edges, line }
      }
      out.sheets.push(sheet)
      return sheet
    })
    for (const l of lay.lost) out.unplaced.push({ id: l.k < 0 ? g.parts[l.i].id : piecesOf(g.parts[l.i], gene.split[l.i])[l.k].id, t: g.t, why: 'no room on the stock' })
    for (const s of g.skipped) out.unplaced.push({ ...s, t: g.t })
    if (job.mode === 'stock') g.stock.forEach((s, k) => { if (!sheets[k]) out.unused.push({ t: g.t, w: s.w, l: s.l, count: 1 }) })
    // drop-out guests ride on the piece (or part) holding their pocket
    const where = new Map<string, { sheet: NestSheet; m: Mat; rot: boolean; bin?: string }>()
    for (const s of sheets) if (s) for (const p of s.parts) where.set(p.id, { sheet: s, m: p.m, rot: p.rot, bin: p.bin })
    const onFoam = new Set(lay.spots.map(x => g.parts[x.i].id))
    const lost = new Set(lay.lost.map(l => g.parts[l.i].id))
    let pending = g.parts.filter(p => p.host && !onFoam.has(p.id) && !lost.has(p.id))
    for (let pass = 0; pass < 8 && pending.length; pass++) {
      pending = pending.filter(p => {
        const hi = g.parts.findIndex(x => x.id === p.host!.id)
        const sp = gene.split[hi]
        const k = sp >= 0 && g.parts[hi].splits[sp] ? g.parts[hi].splits[sp].owner.get(p.id) ?? -1 : -1
        const hostId = k < 0 ? p.host!.id : g.parts[hi].splits[sp].pieces[k].id
        const h = where.get(hostId)
        if (!h) return true
        const m = mul(h.m, p.host!.m)
        const rot = p.host!.rot !== h.rot
        h.sheet.parts.push({ id: p.id, from: p.id, layer: p.layer, m, rot, host: hostId, bin: h.bin, box: boxOf(p.bbox, m) })
        where.set(p.id, { sheet: h.sheet, m, rot, bin: h.bin })
        return false
      })
    }
    for (const p of pending) out.unplaced.push({ id: p.id, t: g.t, why: 'its host piece is not placed' })
    const mine = out.sheets.filter(s => s.t === g.t)
    out.totals.push({
      t: g.t, sheets: mine.length, blanks: mine.reduce((a, s) => a + (s.blanks?.length ?? 0), 0),
      splits: g.parts.filter((p, i) => piecesOf(p, gene.split[i]).length > 1 && onFoam.has(p.id)).length,
      area: 0, fill: 0, ...(job.mode === 'roll' ? { length: lay.used[0] ?? 0, width: g.width } : {}),
    })
  })
  return out
}

/** Engraved id for a part of a split piece: the piece's label text with the
 *  part's id, under the sheet above, as the slicer places them. */
function labelPart(job: NestJob, p: JobPart, s: Shape) {
  if (s.label !== undefined || !p.shape.label) return
  const h = p.shape.label.h
  const text = p.shape.label.text.replace(p.id, s.id)
  const reg = [s.poly, job.above.get(s.layer) ?? []]
  const o: Pt = [s.bbox[0], s.bbox[1]]
  s.label = (reg[1].length ? makeLabel(reg, s.bbox, text, h, o) ?? makeLabel(reg, s.bbox, s.id, h, o) : undefined) ?? undefined
  if (!s.label) s.label = { x: NaN, y: NaN, h: 0, text: '' }   // tried, no room
}

/** Fill in what the worker could not know: areas and fill ratios. */
export function finish(res: SliceResult, r: NestResult): NestResult {
  const area = new Map<string, number>(res.layers.flatMap(L => L.pieces).map(q => [q.id, q.area] as [string, number]))
  for (const s of r.shapes) area.set(s.id, s.area)
  for (const s of r.sheets) s.area = s.parts.reduce((a, p) => a + (area.get(p.id) ?? 0), 0)
  for (const t of r.totals) {
    const ss = r.sheets.filter(s => s.t === t.t)
    t.area = ss.reduce((a, s) => a + s.area, 0)
    const stock = ss.reduce((a, s) => a + s.w * s.l, 0)
    t.fill = stock ? t.area / stock : 0
  }
  return r
}

// ---- drawing what goes on a sheet ------------------------------------------------------------

export interface SheetGeometry {
  cut: Ring[]             // in cut order: pieces inside drop-outs first
  engrave: Ring[]
  labels: (Label & { angle: number })[]
}

/** All shapes by id: the slicer's pieces and the parts of split ones. */
export function shapesById(res: SliceResult, n: NestResult): Map<string, Shape> {
  const m = new Map<string, Shape>(res.layers.flatMap(L => L.pieces).map(q => [q.id, shapeOf(q)] as [string, Shape]))
  for (const s of n.shapes) m.set(s.id, s)
  return m
}

/** The cut and engraved geometry of one nest sheet, or of one of its blanks
 *  (then in the blank's coordinates), in sheet coordinates. */
export function sheetGeometry(res: SliceResult, n: NestResult, s: NestSheet, blank?: Blank): SheetGeometry {
  const byId = shapesById(res, n)
  const marksOn = marksByPiece(res)
  const depth = (p: Placed): number => {
    let d = 0
    for (let h = p.host; h && d < 10; h = s.parts.find(x => x.id === h)?.host) d++
    return d
  }
  const parts = s.parts.filter(p => !blank || p.bin === blank.name)
  const order = [...parts].sort((a, b) => depth(b) - depth(a))
  const g: SheetGeometry = { cut: [], engrave: [], labels: [] }
  const angle = (m: Mat) => Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI)
  for (const p of order) {
    const q = byId.get(p.id)
    if (!q) continue
    const m: Mat = blank ? [p.m[0], p.m[1], p.m[2], p.m[3], p.m[4] - blank.x, p.m[5] - blank.y] : p.m
    for (const r of q.rings) g.cut.push(mapRing(m, r))
    if (q.label && q.label.text) g.labels.push(mapLabel(m, q.label, angle(m)))
    for (const mk of marksOn.get(q.from) ?? []) {
      if (q.id !== q.from) {     // a part of a split piece: only the marks on it
        const [x, y] = interiorPoint([ringPoints(mk.rings[0])], 8)
        if (!inside(q.poly, x, y)) continue
      }
      for (const r of mk.rings) g.engrave.push(mapRing(m, r))
      if (mk.label) g.labels.push(mapLabel(m, mk.label, angle(m)))
    }
  }
  return g
}

const mapRing = (m: Mat, r: Ring): Ring => r.map(([x, y, b]) => { const [u, v] = apply(m, x, y); return [u, v, b] })
const mapLabel = (m: Mat, l: Label, angle: number) => { const [x, y] = apply(m, l.x, l.y); return { ...l, x, y, angle } }

/** Placement outlines belong to the piece they are engraved on. */
function marksByPiece(res: SliceResult) {
  const out = new Map<string, Layer['marks']>()
  for (const L of res.layers) for (const mk of L.marks) {
    const [x, y] = interiorPoint([ringPoints(mk.rings[0])])
    const q = L.pieces.find(p => inside(p.poly, x, y)) ?? L.pieces[0]
    if (!q) continue
    if (!out.has(q.id)) out.set(q.id, [])
    out.get(q.id)!.push(mk)
  }
  return out
}
