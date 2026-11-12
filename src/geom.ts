// SPDX-License-Identifier: GPL-3.0-only
// Plane geometry on rings with bulge arcs (see types.ts) and on plain polygons.
import type { BBox, Label, Pt, Ring } from './types'

export interface Arc { cx: number; cy: number; r: number; a0: number; sweep: number }

/** The arc from (x, y) to (x2, y2) with bulge b. */
export function arcOf(x: number, y: number, x2: number, y2: number, b: number): Arc {
  const sweep = 4 * Math.atan(b)
  const ch = Math.hypot(x2 - x, y2 - y)
  const r = ch / (2 * Math.abs(Math.sin(sweep / 2)))
  const mx = (x + x2) / 2, my = (y + y2) / 2
  const h = r * Math.cos(sweep / 2)            // centre distance from the chord
  const ux = (x2 - x) / ch, uy = (y2 - y) / ch
  const s = sweep > 0 ? 1 : -1                 // ccw: centre left of the chord
  const cx = mx - s * uy * h, cy = my + s * ux * h
  return { cx, cy, r, a0: Math.atan2(y - cy, x - cx), sweep }
}

/** Bulge of the arc s -> e that passes through m. */
export function bulgeThrough(s: Pt, m: Pt, e: Pt): number {
  const c = circumcentre(s, m, e)
  if (!c) return 0
  const ang = (p: Pt) => Math.atan2(p[1] - c[1], p[0] - c[0])
  const ccw = (m[0] - s[0]) * (e[1] - m[1]) - (m[1] - s[1]) * (e[0] - m[0]) > 0
  const tau = 2 * Math.PI
  let d = (((ang(e) - ang(s)) % tau) + tau) % tau      // ccw sweep s -> e
  if (d < 1e-12) d = tau
  const sweep = ccw ? d : -(tau - d)
  return Math.tan(sweep / 4)
}

export function circumcentre(a: Pt, b: Pt, c: Pt): Pt | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-12) return null
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2
  return [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
  ]
}

/** Polygon approximation of a ring, arcs split every `seg` degrees. */
export function ringPoints(ring: Ring, seg = 6): Pt[] {
  const pts: Pt[] = []
  const n = ring.length
  for (let i = 0; i < n; i++) {
    const [x, y, b] = ring[i]
    pts.push([x, y])
    if (b) {
      const [x2, y2] = ring[(i + 1) % n]
      const a = arcOf(x, y, x2, y2, b)
      const k = Math.max(2, Math.ceil(Math.abs(a.sweep) * 180 / Math.PI / seg))
      for (let j = 1; j < k; j++) {
        const t = a.a0 + a.sweep * j / k
        pts.push([a.cx + a.r * Math.cos(t), a.cy + a.r * Math.sin(t)])
      }
    }
  }
  return pts
}

/** Signed area, > 0 counter-clockwise. */
export function signedArea(p: Pt[]): number {
  let s = 0
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j][0] - p[i][0]) * (p[j][1] + p[i][1])
  return s / 2
}

export function reverseRing(r: Ring): Ring {
  // vertex i keeps its position; each segment changes direction and sign
  const n = r.length
  const out: Ring = []
  for (let i = 0; i < n; i++) {
    const v = r[(n - i) % n]
    const prev = r[(2 * n - i - 1) % n]           // segment prev -> v becomes v -> prev
    out.push([v[0], v[1], -prev[2]])
  }
  return out
}

export function bboxOf(polys: Pt[][]): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of polys) for (const [x, y] of p) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

/** Even-odd point test over a set of rings (holes and islands alike). */
export function inside(polys: Pt[][], x: number, y: number): boolean {
  let c = false
  for (const p of polys) {
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i], [xj, yj] = p[j]
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c
    }
  }
  return c
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const l = dx * dx + dy * dy
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = ax + t * dx - px, ey = ay + t * dy - py
  return ex * ex + ey * ey
}

/** Whether the box lies in the material of `polys` with `clear` mm to every edge. */
export function boxFits(polys: Pt[][], b: BBox, clear: number): boolean {
  return inside(polys, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2) && boxClear(polys, b, clear)
}

/** Whether no edge of `polys` comes within `clear` mm of the box. */
export function boxClear(polys: Pt[][], b: BBox, clear: number): boolean {
  const [x0, y0, x1, y1] = b
  // test edge vertices against the grown box, box corners against the edges,
  // and edges crossing the box without a vertex in it
  const gx0 = x0 - clear, gy0 = y0 - clear, gx1 = x1 + clear, gy1 = y1 + clear
  const c2 = clear * clear
  const corners: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  for (const p of polys) {
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [ax, ay] = p[j], [bx, by] = p[i]
      if (Math.max(ax, bx) < gx0 || Math.min(ax, bx) > gx1 || Math.max(ay, by) < gy0 || Math.min(ay, by) > gy1) continue
      if (ax >= gx0 && ax <= gx1 && ay >= gy0 && ay <= gy1) return false
      for (const [qx, qy] of corners) if (segDist2(qx, qy, ax, ay, bx, by) < c2) return false
      if (segCrossesBox(ax, ay, bx, by, gx0, gy0, gx1, gy1)) return false
    }
  }
  return true
}

/** Engraving already on the sheet that a new label must keep clear of. */
export interface Avoid { lines: Pt[][]; boxes: BBox[] }

function segCrossesBox(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  // Liang-Barsky clip
  let t0 = 0, t1 = 1
  const dx = bx - ax, dy = by - ay
  const p = [-dx, dx, -dy, dy], q = [ax - x0, x1 - ax, ay - y0, y1 - ay]
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue }
    const r = q[i] / p[i]
    if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r }
    else { if (r < t0) return false; if (r < t1) t1 = r }
  }
  return true
}

export function labelSize(text: string, h: number): [number, number] {
  return [0.62 * h * text.length, h]
}

/** Lower-left corner of the free spot for a label of size w x h that fits every
 *  polygon set in `regions` with `clear` around it, nearest to `origin`. */
export function findSpot(regions: Pt[][][], area: BBox, w: number, h: number, clear: number,
                         origin: Pt, avoid?: Avoid, step = 2): Pt | null {
  const [x0, y0, x1, y1] = area
  const cand: [number, number, number][] = []
  for (let y = y0 + clear; y + h + clear <= y1; y += step)
    for (let x = x0 + clear; x + w + clear <= x1; x += step)
      cand.push([Math.hypot(x - origin[0], y - origin[1]), x, y])
  cand.sort((a, b) => a[0] - b[0])
  for (const [, x, y] of cand) {
    const b: BBox = [x, y, x + w, y + h]
    if (avoid && (avoid.boxes.some(o => o[0] < b[2] + clear && b[0] < o[2] + clear && o[1] < b[3] + clear && b[1] < o[3] + clear)
                  || !boxClear(avoid.lines, b, clear))) continue
    if (regions.every(r => boxFits(r, b, clear))) return [x, y]
  }
  return null
}

export function makeLabel(regions: Pt[][][], area: BBox, text: string, h: number, origin: Pt, avoid?: Avoid): Label | undefined {
  const [w] = labelSize(text, h)
  const s = findSpot(regions, area, w, h, 2, origin, avoid)
  return s ? { x: s[0], y: s[1], h, text } : undefined
}

export function labelBox(l: Label): BBox {
  return [l.x, l.y, l.x + labelSize(l.text, l.h)[0], l.y + l.h]
}

export function fmt(v: number, d = 1): string {
  const s = v.toFixed(d)
  return s === '-' + (0).toFixed(d) ? (0).toFixed(d) : s
}

/** A point well inside the material of a piece (rings: outer first, then holes):
 *  the grid point farthest from every edge, a coarse pole of inaccessibility. */
export function interiorPoint(polys: Pt[][], grid = 28): Pt {
  const [x0, y0, x1, y1] = bboxOf([polys[0]])
  let best: Pt = [(x0 + x1) / 2, (y0 + y1) / 2], bd = -1
  for (let i = 0; i <= grid; i++) for (let j = 0; j <= grid; j++) {
    const x = x0 + (x1 - x0) * (i + 0.5) / (grid + 1), y = y0 + (y1 - y0) * (j + 0.5) / (grid + 1)
    if (!inside(polys, x, y)) continue
    let d = Infinity
    for (const p of polys) for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
      d = Math.min(d, segDist2(x, y, p[b][0], p[b][1], p[a][0], p[a][1]))
      if (d <= bd) break
    }
    if (d > bd) { bd = d; best = [x, y] }
  }
  return best
}

/** Hausdorff distance between two sets of closed rings (their boundaries):
 *  the farthest any point on one lies from the other. Edge midpoints are
 *  sampled along with the vertices. 0 for two empty sets, Infinity for one. */
export function hausdorff(a: Pt[][], b: Pt[][]): number {
  if (!a.length && !b.length) return 0
  if (!a.length || !b.length) return Infinity
  return Math.max(directed(a, b), directed(b, a))
}

function directed(a: Pt[][], b: Pt[][]): number {
  let cmax = 0
  for (const ring of a) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length]
      for (const [x, y] of [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as Pt]) {
        // early break: once this point is closer than the running max it can't raise it
        let cmin = Infinity
        outer: for (const r of b) {
          for (let k = 0, j = r.length - 1; k < r.length; j = k++) {
            const d = segDist2(x, y, r[j][0], r[j][1], r[k][0], r[k][1])
            if (d < cmin) { cmin = d; if (cmin <= cmax) break outer }
          }
        }
        if (cmin > cmax) cmax = cmin
      }
    }
  }
  return Math.sqrt(cmax)
}
