<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue'
import { fileName, hover, result, sel, selectPiece, setHover } from '../store'
import { pathD, viewBoxOf } from '../draw'
import { fmt, interiorPoint } from '../geom'
import { stackSummary } from '../suggest'
import type { Layer, Piece } from '../types'

const vb = computed(() => {
  const r = result.value
  if (!r) return '0 0 1 1'
  const m = r.params.margin
  return viewBoxOf([r.bbox.min[0] - m, r.bbox.min[1] - m, r.bbox.max[0] + m, r.bbox.max[1] + m], 4).join(' ')
})
const fontSize = computed(() => {
  const r = result.value
  return r ? Math.max(r.bbox.max[0] - r.bbox.min[0], r.bbox.max[1] - r.bbox.min[1]) / 26 : 10
})

const tagAt = computed(() => {
  const m = new Map<string, [number, number]>()
  for (const L of result.value?.layers ?? []) for (const q of L.pieces) {
    const [x, y] = interiorPoint(q.poly)
    m.set(q.id, [x, -y])
  }
  return m
})
function tagPos(q: Piece): [number, number] { return tagAt.value.get(q.id) ?? [0, 0] }

function steps(L: Layer, r: NonNullable<typeof result.value>) {
  const out: { id: string; kind: Piece['kind']; text: string }[] = []
  for (const q of L.pieces) {
    const at = `x ${fmt(q.bbox[0] + r.frame.dx, 0)}, y ${fmt(q.bbox[1] + r.frame.dy, 0)}`
    if (q.kind === 'main')
      out.push({ id: q.id, kind: q.kind, text: L.index === 0 ? 'goes in first, flat on the case floor.' : `glue onto ${q.below.join(', ')}, outlines flush.` })
    else if (q.kind === 'loose')
      out.push({ id: q.id, kind: q.kind, text: `loose piece (${fmt(q.bbox[2] - q.bbox[0], 0)} × ${fmt(q.bbox[3] - q.bbox[1], 0)} mm): glue onto ${q.below.join(', ')} at ${at}` +
        (r.params.marks ? ', inside its engraved outline.' : '.') })
    else
      out.push({ id: q.id, kind: q.kind, text: q.above.length
        ? `nothing below it: glue it under ${q.above.join(', ')} first, at ${at}.`
        : 'nothing below or above it: not part of the stack. Check the model.' })
  }
  return out
}

function printPage() { window.print() }

const stats = computed(() => {
  const r = result.value
  if (!r) return null
  const pieces = r.layers.flatMap(L => L.pieces)
  return {
    pieces: pieces.length,
    loose: pieces.filter(q => q.kind === 'loose').length,
    floating: pieces.filter(q => q.kind === 'floating').length,
    area: pieces.reduce((s, q) => s + q.area, 0) / 1e6,
  }
})
</script>

<template>
  <div class="asm" v-if="result && stats">
    <header>
      <div>
        <h2>Assembly</h2>
        <p class="muted">
          {{ fileName }} · {{ result.layers.length }} sheets ({{ stackSummary(result.layers.map(L => Math.round((L.zt - L.zb) * 100) / 100)) }}), each {{ fmt(result.frame.w) }} × {{ fmt(result.frame.h) }} mm ·
          {{ stats.pieces }} pieces<template v-if="stats.loose">, <span class="loose-t">{{ stats.loose }} loose</span></template><template v-if="stats.floating">, <span class="float-t">{{ stats.floating }} floating</span></template>
          · {{ fmt(stats.area, 2) }} m² of foam in the parts
        </p>
      </div>
      <button @click="printPage">Print</button>
    </header>
    <p class="muted intro">Bottom up. Each sheet is shown from above with the sheet below dashed; the ids match the engraving and the file names.</p>
    <ol class="steps">
      <li v-for="L in result.layers" :key="L.index" :class="{ on: sel.layer === L.index }">
        <div class="h">
          <span class="n">{{ L.index + 1 }}</span>
          <strong class="mono">{{ L.name }}</strong>
          <span class="faint num">z {{ fmt(L.zb, 0) }}–{{ fmt(L.zt, 0) }}</span>
          <span class="thick num">{{ fmt(L.zt - L.zb, 0) }} mm foam</span>
        </div>
        <svg :viewBox="vb" class="thumb">
          <path v-if="L.index > 0" :d="pathD(result.layers[L.index - 1].pieces.flatMap(q => q.rings))" class="below" vector-effect="non-scaling-stroke" />
          <path v-for="q in L.pieces" :key="q.id" :d="pathD(q.rings)" fill-rule="evenodd" class="piece" :class="[q.kind, { on: sel.piece === q.id, hov: hover === q.id }]"
                vector-effect="non-scaling-stroke" @click="selectPiece(q.id)" @pointerenter="setHover(q.id)" @pointerleave="setHover('')" />
          <text v-for="q in L.pieces" :key="'t' + q.id" :x="tagPos(q)[0]" :y="tagPos(q)[1]" :font-size="q.kind === 'main' ? fontSize : fontSize * 0.8" class="tag" :class="q.kind">{{ q.id }}</text>
        </svg>
        <ul>
          <li v-for="s in steps(L, result)" :key="s.id">
            <a class="mono id" :class="s.kind" @click="selectPiece(s.id)">{{ s.id }}</a> {{ s.text }}
          </li>
        </ul>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.asm { padding: 16px 20px 28px; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
h2 { margin: 0 0 2px; font-size: 18px; }
header p, .intro { margin: 0; font-size: 13px; }
.intro { margin: 8px 0 14px; }
.loose-t { color: var(--loose); }
.float-t { color: var(--float); }
.steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.steps > li { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px 12px; background: var(--panel); break-inside: avoid; }
.steps > li.on { border-color: var(--ink-3); }
.h { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.thick { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--ink-2); }
.n { font-size: 11px; font-weight: 700; color: var(--ink-3); min-width: 16px; }
.thumb { width: 100%; height: auto; display: block; margin: 2px 0 8px; }
.below { fill: none; stroke: var(--ink-3); stroke-width: 1; stroke-dasharray: 4 3; }
.piece { fill: color-mix(in srgb, var(--sheet) 75%, transparent); stroke: var(--sheet-edge); stroke-width: 1; cursor: pointer; }
.piece.loose { fill: color-mix(in srgb, var(--loose) 40%, transparent); stroke: var(--loose); }
.piece.floating { fill: color-mix(in srgb, var(--float) 40%, transparent); stroke: var(--float); }
.piece.hov, .piece.on { stroke: var(--ink); stroke-width: 2; }
.tag { fill: var(--ink); font-family: var(--mono); font-weight: 700; text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
ul { margin: 0; padding: 0; list-style: none; font-size: 12.5px; display: grid; gap: 3px; }
.id { font-weight: 700; cursor: pointer; }
.id.loose { color: var(--loose); }
.id.floating { color: var(--float); }

@media print {
  .asm { padding: 0; }
  header button { display: none; }
  .steps { grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .steps > li { border-color: #bbb; }
}
</style>
