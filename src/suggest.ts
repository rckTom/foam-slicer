// SPDX-License-Identifier: GPL-3.0-only
// Which sheet thicknesses fit where, and a suggested stack.
//
// The worker's height profile says how far the walls move inside a sheet that
// covers grid cells i .. i+k-1 (outer outline and pockets apart). A sheet is
// cut flat, so that movement is the error it makes. The suggestion is the
// stack with
//   1. the least error beyond the tolerances (summed over the sheets),
//   2. then the fewest sheets (fewer glue joints),
//   3. then the least error in total,
// found by dynamic programming over the grid.
import type { Profile, SliceParams } from './types'

const U = 100                          // thicknesses are compared in 0.01 mm

/** The grid the thicknesses share: their greatest common divisor. */
export function gridStep(thicknesses: number[]): number {
  const ints = thicknesses.filter(t => t > 0).map(t => Math.round(t * U))
  if (!ints.length) return 0
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  return ints.reduce(gcd) / U
}

export function cellsOf(t: number, step: number): number {
  return Math.round(t / step)
}

export interface SheetFit {
  t: number
  outline: number         // wall movement within the sheet
  pockets: number
  ok: boolean             // within both tolerances
  fits: boolean           // stays below the model's top
}

/** How a sheet of each thickness would do starting at grid cell `cell`. */
export function fitsAt(pr: Profile, p: SliceParams, cell: number): SheetFit[] {
  return [...p.thicknesses].sort((a, b) => a - b).map(t => {
    const k = cellsOf(t, pr.step)
    const fits = cell + k <= pr.n && k >= 1 && k <= pr.kmax
    const outline = fits ? pr.outline[cell][k - 1] : NaN
    const pockets = fits ? pr.pockets[cell][k - 1] : NaN
    return { t, outline, pockets, fits, ok: fits && outline <= p.maxOutline + 1e-9 && pockets <= p.maxPockets + 1e-9 }
  })
}

/** The error of one sheet of thickness t from cell `cell`, or null off the grid. */
export function sheetError(pr: Profile, cell: number, t: number): { outline: number; pockets: number } | null {
  const k = cellsOf(t, pr.step)
  if (k < 1 || k > pr.kmax || cell < 0 || cell + k > pr.n || Math.abs(k * pr.step - t) > 1e-6) return null
  return { outline: pr.outline[cell][k - 1], pockets: pr.pockets[cell][k - 1] }
}

/** Grid cell where a sheet starting at height z begins (null if not on the grid). */
export function cellAt(pr: Profile, z: number): number | null {
  const c = (z - pr.z0) / pr.step
  return Math.abs(c - Math.round(c)) < 1e-6 ? Math.round(c) : null
}

type Cost = [excess: number, sheets: number, total: number]
const better = (a: Cost, b: Cost) =>
  a[0] < b[0] - 1e-9 || (Math.abs(a[0] - b[0]) <= 1e-9 && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2] - 1e-9)))

const BIG = 1e3                        // stands in for "the shape changes" (Infinity)
const fin = (v: number) => (Number.isFinite(v) ? v : BIG)

/** The best stack from grid cell `from` up to the top (or as close as the
 *  thicknesses get). */
export function plan(pr: Profile, p: SliceParams, from = 0): number[] {
  const ts = [...new Set(p.thicknesses.filter(t => t > 0))]
  const best: (Cost | null)[] = Array(pr.n + 1).fill(null)
  const prev: [number, number][] = Array(pr.n + 1)
  best[from] = [0, 0, 0]
  for (let c = from; c < pr.n; c++) {
    const here = best[c]
    if (!here) continue
    for (const t of ts) {
      const e = sheetError(pr, c, t)
      if (!e) continue
      const o = fin(e.outline), q = fin(e.pockets)
      const excess = Math.max(0, o - p.maxOutline) + Math.max(0, q - p.maxPockets)
      const k = cellsOf(t, pr.step)
      const cost: Cost = [here[0] + excess, here[1] + 1, here[2] + o + q]
      if (!best[c + k] || better(cost, best[c + k]!)) { best[c + k] = cost; prev[c + k] = [c, t] }
    }
  }
  let end = pr.n
  while (end > from && !best[end]) end--
  const stack: number[] = []
  for (let c = end; c > from; c = prev[c][0]) stack.unshift(prev[c][1])
  return stack
}

/** The stack with sheet i set to thickness t: the sheets below stay, the ones
 *  above are planned again. */
export function withSheet(pr: Profile, p: SliceParams, stack: number[], i: number, t: number): number[] {
  const below = stack.slice(0, i)
  const z = p.z0 + below.reduce((s, v) => s + v, 0)
  const c = cellAt(pr, z)
  if (c === null) return [...below, t]
  return [...below, t, ...plan(pr, p, c + cellsOf(t, pr.step))]
}

/** "4 × 10 mm, 1 × 50 mm" */
export function stackSummary(stack: number[]): string {
  const m = new Map<number, number>()
  for (const t of stack) m.set(t, (m.get(t) ?? 0) + 1)
  return [...m].sort((a, b) => a[0] - b[0]).map(([t, n]) => `${n} × ${t} mm`).join(', ')
}
