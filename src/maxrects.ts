// SPDX-License-Identifier: GPL-3.0-only
// MaxRects bin packing (J. Jylänki, "A Thousand Ways to Pack the Bin", 2010)
// with the bottom-left rule: each rectangle goes where its top edge ends
// lowest, then leftmost. Placed in a given order with a given turn, so a
// search can drive it. Coordinates: x across the bin, y along it.

export interface R { x: number; y: number; w: number; h: number }

export class MaxRects {
  free: R[]

  constructor(readonly w: number, readonly h: number) {
    this.free = [{ x: 0, y: 0, w, h }]
  }

  /** Best bottom-left spot for a w x h rectangle, or null. With rank k > 0 the
   *  (k+1)-th best distinct spot (or the last there is): a search that may
   *  pass over the best spot reaches layouts that bottom-left never builds,
   *  such as columns staggered past each other. */
  find(w: number, h: number, rank = 0): R | null {
    if (rank > 0) {
      const c: R[] = []
      for (const f of this.free)
        if (w <= f.w + 1e-9 && h <= f.h + 1e-9 && !c.some(r => Math.abs(r.x - f.x) < 1e-9 && Math.abs(r.y - f.y) < 1e-9)) c.push({ x: f.x, y: f.y, w, h })
      c.sort((a, b) => (a.y - b.y) || (a.x - b.x))
      return c.length ? c[Math.min(rank, c.length - 1)] : null
    }
    let best: R | null = null, by = Infinity, bx = Infinity
    for (const f of this.free) {
      if (w <= f.w + 1e-9 && h <= f.h + 1e-9) {
        const top = f.y + h
        if (top < by - 1e-9 || (Math.abs(top - by) <= 1e-9 && f.x < bx)) { best = { x: f.x, y: f.y, w, h }; by = top; bx = f.x }
      }
    }
    return best
  }

  place(r: R) {
    const next: R[] = []
    for (const f of this.free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.h || r.y + r.h <= f.y) { next.push(f); continue }
      // split f around r into up to four maximal rectangles
      if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h })
      if (r.x + r.w < f.x + f.w) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - (r.x + r.w), h: f.h })
      if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y })
      if (r.y + r.h < f.y + f.h) next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - (r.y + r.h) })
    }
    // drop free rectangles inside others
    this.free = next.filter((a, i) => !next.some((b, j) => j !== i &&
      a.x >= b.x - 1e-9 && a.y >= b.y - 1e-9 && a.x + a.w <= b.x + b.w + 1e-9 && a.y + a.h <= b.y + b.h + 1e-9 &&
      (j < i || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h)))
  }
}
