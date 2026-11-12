// SPDX-License-Identifier: GPL-3.0-only
// SVG paths for the page: model coordinates with y negated (screen y points down),
// so text stays upright without transforms.
import { arcOf } from './geom'
import type { BBox, Ring } from './types'

const n2 = (v: number) => (Math.round(v * 100) / 100).toString()

export function pathD(rings: Ring[]): string {
  let d = ''
  for (const r of rings) {
    const n = r.length
    d += `M${n2(r[0][0])} ${n2(-r[0][1])}`
    for (let i = 0; i < n; i++) {
      const [x, y, b] = r[i]
      const [x2, y2] = r[(i + 1) % n]
      if (b) {
        const a = arcOf(x, y, x2, y2, b)
        // mirrored: a counter-clockwise arc in the model turns clockwise on screen
        d += `A${n2(a.r)} ${n2(a.r)} 0 ${Math.abs(a.sweep) > Math.PI ? 1 : 0} ${a.sweep > 0 ? 0 : 1} ${n2(x2)} ${n2(-y2)}`
      } else d += `L${n2(x2)} ${n2(-y2)}`
    }
    d += 'Z'
  }
  return d
}

/** viewBox for a model-space box (y negated), with padding. */
export function viewBoxOf(b: BBox, pad: number): [number, number, number, number] {
  return [b[0] - pad, -b[3] - pad, b[2] - b[0] + 2 * pad, b[3] - b[1] + 2 * pad]
}

export function download(name: string, data: string | Uint8Array, type = 'application/octet-stream') {
  const blob = new Blob([data as BlobPart], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
