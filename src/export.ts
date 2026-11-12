// SPDX-License-Identifier: GPL-3.0-only
// Laser files per sheet, as slice.py writes them: every sheet in the same frame
// (model bounding box + margin, origin at its lower-left corner), so they
// register. Red / layer CUT = cut, blue / layer ENGRAVE = ids and marks.
import { zipSync, strToU8 } from 'fflate'
import { arcOf, fmt } from './geom'
import type { Label, Layer, Ring, SliceResult } from './types'
import { sheetGeometry } from './nest'
import type { Blank, NestResult, NestSheet } from './nest'

const f4 = (v: number) => v.toFixed(4)

const thick = (L: Layer) => Math.round((L.zt - L.zb) * 100) / 100

/** layer_03_z020, as slice.py names them; with mixed thicknesses _t50 is added
 *  so the right foam goes on the laser. */
export function layerFileName(L: Layer, mixed = false) {
  return `layer_${String(L.index + 1).padStart(2, '0')}_z${String(Math.round(L.zb)).padStart(3, '0')}` +
    (mixed ? `_t${thick(L)}` : '')
}

export function isMixed(res: SliceResult) {
  return new Set(res.layers.map(thick)).size > 1
}

function svgPath(rings: Ring[], dx: number, dy: number): string {
  return rings.map(r => {
    const n = r.length
    const d = [`M${f4(r[0][0] + dx)},${f4(r[0][1] + dy)}`]
    for (let i = 0; i < n; i++) {
      const [x, y, b] = r[i]
      const [x2, y2] = r[(i + 1) % n]
      if (b) {
        const a = arcOf(x, y, x2, y2, b)
        d.push(`A${f4(a.r)},${f4(a.r)} 0 ${Math.abs(a.sweep) > Math.PI ? 1 : 0} ${a.sweep > 0 ? 1 : 0} ${f4(x2 + dx)},${f4(y2 + dy)}`)
      } else d.push(`L${f4(x2 + dx)},${f4(y2 + dy)}`)
    }
    return d.join(' ') + ' Z'
  }).join(' ')
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

export function layerSvg(res: SliceResult, L: Layer): string {
  const { dx, dy, w, h } = res.frame
  const cut = L.pieces.flatMap(q => q.rings)
  const marks = L.marks.flatMap(m => m.rings)
  const labels: Label[] = [...L.pieces.map(q => q.label), ...L.marks.map(m => m.label)].filter((l): l is Label => !!l)
  const s = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w, 3)}mm" height="${fmt(h, 3)}mm" viewBox="0 0 ${fmt(w, 3)} ${fmt(h, 3)}">`,
    `<g transform="matrix(1 0 0 -1 0 ${fmt(h, 3)})">`,
    `<path d="${svgPath(cut, dx, dy)}" fill="none" stroke="#ff0000" stroke-width="0.1"/>`,
  ]
  if (marks.length) s.push(`<path d="${svgPath(marks, dx, dy)}" fill="none" stroke="#0000ff" stroke-width="0.1"/>`)
  s.push('</g>')
  for (const l of labels)
    s.push(`<text x="${fmt(l.x + dx, 2)}" y="${fmt(h - (l.y + dy), 2)}" font-family="sans-serif" font-size="${l.h}" fill="#0000ff">${esc(l.text)}</text>`)
  s.push('</svg>')
  return s.join('\n') + '\n'
}

export function layerDxf(res: SliceResult, L: Layer): string {
  const { dx, dy } = res.frame
  const o: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009',
    '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '2',
    '0', 'LAYER', '2', 'CUT', '70', '0', '62', '1', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'ENGRAVE', '70', '0', '62', '5', '6', 'CONTINUOUS',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES']
  const poly = (r: Ring, layer: string, color: string) => {
    o.push('0', 'POLYLINE', '8', layer, '62', color, '66', '1', '70', '1', '10', '0', '20', '0', '30', '0')
    for (const [x, y, b] of r) {
      o.push('0', 'VERTEX', '8', layer, '10', f4(x + dx), '20', f4(y + dy), '30', '0')
      if (b) o.push('42', b.toFixed(9))
    }
    o.push('0', 'SEQEND', '8', layer)
  }
  for (const q of L.pieces) for (const r of q.rings) poly(r, 'CUT', '1')
  for (const m of L.marks) for (const r of m.rings) poly(r, 'ENGRAVE', '5')
  const labels = [...L.pieces.map(q => q.label), ...L.marks.map(m => m.label)].filter((l): l is Label => !!l)
  for (const l of labels)
    o.push('0', 'TEXT', '8', 'ENGRAVE', '62', '5', '10', fmt(l.x + dx, 2), '20', fmt(l.y + dy, 2), '30', '0', '40', String(l.h), '1', l.text)
  o.push('0', 'ENDSEC', '0', 'EOF')
  return o.join('\n') + '\n'
}

export function cutlist(res: SliceResult, source: string): string {
  const p = res.params
  const n = res.layers.length
  const mixed = isMixed(res)
  const counts = new Map<number, number>()
  for (const L of res.layers) counts.set(thick(L), (counts.get(thick(L)) ?? 0) + 1)
  const summary = [...counts].sort((a, b) => a[0] - b[0]).map(([t, k]) => `${k} x ${t} mm`).join(', ')
  const top = n ? res.layers[n - 1].zt : p.z0
  const lines = [
    `Foam insert from ${source}: ${n} sheets (${summary}), z ${fmt(p.z0, 2)} .. ${fmt(top, 2)}, ` +
    `section at ${p.at} of each sheet. Layer 1 is the bottom.`,
    `Sheet size ${fmt(res.frame.w)} x ${fmt(res.frame.h)} mm (part ${fmt(res.bbox.max[0] - res.bbox.min[0])} x ${fmt(res.bbox.max[1] - res.bbox.min[1])} + ${p.margin} margin).`,
    `File coordinates = model coordinates + (${fmt(res.frame.dx, 2)}, ${fmt(res.frame.dy, 2)}).`,
    '',
    `${'file'.padEnd(mixed ? 22 : 18)}  thick  z range      section  pieces  pockets  outline bottom -> top of sheet`,
  ]
  for (const L of res.layers) {
    lines.push(`${layerFileName(L, mixed).padEnd(mixed ? 22 : 18)}  ${String(thick(L)).padStart(5)}  ${`${fmt(L.zb, 1)}-${fmt(L.zt, 1)}`.padEnd(11)}  ${fmt(L.zs, 2).padStart(7)}  ${String(L.pieces.length).padStart(6)}  ${String(L.pockets).padStart(7)}  ` +
      `${fmt(L.outlineBot[0])} x ${fmt(L.outlineBot[1])} -> ${fmt(L.outlineTop[0])} x ${fmt(L.outlineTop[1])}`)
  }
  lines.push('', 'pieces (position = lower-left corner of the bounding box in file coordinates)', '')
  for (const L of res.layers) for (const q of L.pieces) {
    const [x0, y0, x1, y1] = q.bbox
    lines.push(`${q.id.padEnd(8)} ${q.kind.padEnd(8)} ${`${fmt(x1 - x0)} x ${fmt(y1 - y0)}`.padEnd(15)} at ${fmt(x0 + res.frame.dx)}, ${fmt(y0 + res.frame.dy)}` +
      `   rests on ${q.below.length ? q.below.join(' ') : '-'}`)
  }
  lines.push('')
  if (res.warnings.length) for (const w of res.warnings) lines.push(`${w.level === 'warn' ? 'WARNING' : 'NOTE   '} ${w.text}`)
  else lines.push('no warnings')
  return lines.join('\n') + '\n'
}

export function zipAll(res: SliceResult, source: string): Uint8Array {
  const files: Record<string, Uint8Array> = { 'cutlist.txt': strToU8(cutlist(res, source)) }
  const mixed = isMixed(res)
  for (const L of res.layers) {
    const b = layerFileName(L, mixed)
    files[b + '.dxf'] = strToU8(layerDxf(res, L))
    files[b + '.svg'] = strToU8(layerSvg(res, L))
  }
  return zipSync(files, { level: 6 })
}

// ---- nest sheets ---------------------------------------------------------------------------
// One laser job per piece of stock, or per blank with a laser bed: the pieces
// as nested, pieces inside pocket drop-outs first (keep "inner shapes first"
// on), the stock / blank outline in grey on its own layer for reference. With a
// laser bed there is also a plan per stock piece: where to cut the blanks.

export function nestFileName(s: NestSheet, blank?: Blank) {
  return `nest_t${s.t}_${s.name.split('-')[1]}` + (blank ? `_${blank.name}` : '')
}

export function nestSvg(res: SliceResult, n: NestResult, s: NestSheet, blank?: Blank): string {
  const g = sheetGeometry(res, n, s, blank)
  const w = blank ? blank.w : s.w, l = blank ? blank.h : s.l
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w, 3)}mm" height="${fmt(l, 3)}mm" viewBox="0 0 ${fmt(w, 3)} ${fmt(l, 3)}">`,
    `<g transform="matrix(1 0 0 -1 0 ${fmt(l, 3)})">`,
    `<rect x="0" y="0" width="${fmt(w, 3)}" height="${fmt(l, 3)}" fill="none" stroke="#808080" stroke-width="0.1"/>`,
    `<path d="${svgPath(g.cut, 0, 0)}" fill="none" stroke="#ff0000" stroke-width="0.1"/>`,
  ]
  if (g.engrave.length) out.push(`<path d="${svgPath(g.engrave, 0, 0)}" fill="none" stroke="#0000ff" stroke-width="0.1"/>`)
  out.push('</g>')
  for (const t of g.labels) {
    const x = fmt(t.x, 2), y = fmt(l - t.y, 2)
    out.push(`<text x="${x}" y="${y}"${t.angle ? ` transform="rotate(${-t.angle} ${x} ${y})"` : ''} font-family="sans-serif" font-size="${t.h}" fill="#0000ff">${esc(t.text)}</text>`)
  }
  out.push('</svg>')
  return out.join('\n') + '\n'
}

export function nestDxf(res: SliceResult, n: NestResult, s: NestSheet, blank?: Blank): string {
  const g = sheetGeometry(res, n, s, blank)
  const w = blank ? blank.w : s.w, l = blank ? blank.h : s.l
  const o: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009',
    '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '3',
    '0', 'LAYER', '2', 'CUT', '70', '0', '62', '1', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'ENGRAVE', '70', '0', '62', '5', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'STOCK', '70', '0', '62', '8', '6', 'CONTINUOUS',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES']
  const poly = (r: Ring, layer: string, color: string) => {
    o.push('0', 'POLYLINE', '8', layer, '62', color, '66', '1', '70', '1', '10', '0', '20', '0', '30', '0')
    for (const [x, y, b] of r) {
      o.push('0', 'VERTEX', '8', layer, '10', f4(x), '20', f4(y), '30', '0')
      if (b) o.push('42', b.toFixed(9))
    }
    o.push('0', 'SEQEND', '8', layer)
  }
  poly([[0, 0, 0], [w, 0, 0], [w, l, 0], [0, l, 0]], 'STOCK', '8')
  for (const r of g.cut) poly(r, 'CUT', '1')
  for (const r of g.engrave) poly(r, 'ENGRAVE', '5')
  for (const t of g.labels) {
    o.push('0', 'TEXT', '8', 'ENGRAVE', '62', '5', '10', fmt(t.x, 2), '20', fmt(t.y, 2), '30', '0', '40', String(t.h), '1', t.text)
    if (t.angle) o.push('50', String(t.angle))
  }
  o.push('0', 'ENDSEC', '0', 'EOF')
  return o.join('\n') + '\n'
}

/** Where to cut the blanks from a piece of stock (by hand), with what each holds. */
export function nestPlanSvg(res: SliceResult, n: NestResult, s: NestSheet): string {
  const g = sheetGeometry(res, n, s)
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(s.w, 3)}mm" height="${fmt(s.l, 3)}mm" viewBox="0 0 ${fmt(s.w, 3)} ${fmt(s.l, 3)}">`,
    `<g transform="matrix(1 0 0 -1 0 ${fmt(s.l, 3)})">`,
    `<rect x="0" y="0" width="${fmt(s.w, 3)}" height="${fmt(s.l, 3)}" fill="none" stroke="#000" stroke-width="0.5"/>`,
    `<path d="${svgPath(g.cut, 0, 0)}" fill="none" stroke="#999" stroke-width="0.3"/>`,
    ...(s.blanks ?? []).map(b => `<rect x="${fmt(b.x, 2)}" y="${fmt(b.y, 2)}" width="${fmt(b.w, 2)}" height="${fmt(b.h, 2)}" fill="none" stroke="#000" stroke-width="1" stroke-dasharray="8 4"/>`),
    '</g>',
    ...(s.blanks ?? []).map(b => `<text x="${fmt(b.x + 6, 2)}" y="${fmt(s.l - b.y - b.h + 22, 2)}" font-family="sans-serif" font-size="18" font-weight="bold">${b.name} ${fmt(b.w, 0)} × ${fmt(b.h, 0)}</text>`),
    '</svg>',
  ]
  return out.join('\n') + '\n'
}

export function nestReport(n: NestResult, source: string): string {
  const lines = [`Nesting for ${source}`, '']
  for (const t of n.totals)
    lines.push(`${t.t} mm: ${t.sheets} piece${t.sheets === 1 ? '' : 's'} of stock` +
      (t.length ? `, ${t.length} mm of a ${t.width} mm wide roll` : '') +
      (t.blanks ? `, ${t.blanks} blank${t.blanks === 1 ? '' : 's'}` : '') +
      (t.splits ? `, ${t.splits} piece${t.splits === 1 ? '' : 's'} split` : '') + `, ${fmt(100 * t.fill, 0)} % used`)
  for (const s of n.sheets) {
    lines.push('', `${nestFileName(s)}  ${s.t} mm foam, ${s.w} x ${s.l} mm (${s.used} mm used)` +
      (s.offcut ? `, offcut ${fmt(s.offcut.w, 0)} x ${fmt(s.offcut.h, 0)} mm (${s.offcut.edges} edges)` : ''))
    const groups = s.blanks ? s.blanks.map(b => ({ b, parts: s.parts.filter(p => p.bin === b.name) })) : [{ b: undefined, parts: s.parts }]
    for (const { b, parts } of groups) {
      if (b) lines.push(`  blank ${b.name}: ${fmt(b.w, 0)} x ${fmt(b.h, 0)} mm at ${fmt(b.x, 0)}, ${fmt(b.y, 0)}  -> ${nestFileName(s, b)}`)
      for (const p of parts)
        lines.push(`  ${b ? '  ' : ''}${p.id.padEnd(8)} at ${fmt(p.box[0])}, ${fmt(p.box[1])}${p.rot ? ', turned 90°' : ''}` +
          (p.id !== p.from ? `, part of ${p.from}` : '') + (p.host ? `, inside the pocket drop-out of ${p.host}` : ''))
    }
  }
  if (n.shapes.length) {
    lines.push('', 'split pieces (glue the parts together along the seam):')
    const by = new Map<string, string[]>()
    for (const sh of n.shapes) by.set(sh.from, [...(by.get(sh.from) ?? []), sh.id])
    for (const [from, ids] of by) lines.push(`  ${from} -> ${ids.join(' + ')}`)
  }
  if (n.unplaced.length) { lines.push('', 'not placed:'); for (const u of n.unplaced) lines.push(`  ${u.id} (${u.t} mm): ${u.why}`) }
  if (n.unused.length) { lines.push('', 'stock left over:'); for (const u of n.unused) lines.push(`  ${u.t} mm ${u.w} x ${u.l}`) }
  lines.push('', 'Pieces inside pocket drop-outs are cut before the pocket: keep "inner shapes first" on.')
  return lines.join('\n') + '\n'
}

export function zipNest(res: SliceResult, n: NestResult, source: string): Uint8Array {
  const files: Record<string, Uint8Array> = { 'nest.txt': strToU8(nestReport(n, source)) }
  for (const s of n.sheets) {
    if (s.blanks) {
      files[nestFileName(s) + '_plan.svg'] = strToU8(nestPlanSvg(res, n, s))
      for (const b of s.blanks) {
        files[nestFileName(s, b) + '.dxf'] = strToU8(nestDxf(res, n, s, b))
        files[nestFileName(s, b) + '.svg'] = strToU8(nestSvg(res, n, s, b))
      }
    } else {
      files[nestFileName(s) + '.dxf'] = strToU8(nestDxf(res, n, s))
      files[nestFileName(s) + '.svg'] = strToU8(nestSvg(res, n, s))
    }
  }
  return zipSync(files, { level: 6 })
}
