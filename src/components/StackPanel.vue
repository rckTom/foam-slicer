<!-- SPDX-License-Identifier: GPL-3.0-only -->
<!-- The stack to scale, top first. The strip on the left is the height profile:
     shaded where the walls move within a grid cell, a line where they jump (a
     sheet should end there). Each sheet picks its thickness from the foam at
     hand; the choices say how well each one fits there. -->
<script setup lang="ts">
import { computed } from 'vue'
import { model, params, profile, result, sel, selectLayer, setSheet, suggestStack } from '../store'
import { cellAt, fitsAt, plan, sheetError, stackSummary } from '../suggest'
import type { SheetFit } from '../suggest'
import { fmt } from '../geom'
import type { Layer } from '../types'

const zTop = computed(() => model.value?.info.bbox.max[2] ?? 0)
const scale = computed(() => {
  const tmin = Math.min(...params.thicknesses.filter(t => t > 0))
  return Math.max(2, Math.min(12, 30 / tmin))           // px per mm
})
const height = computed(() => (zTop.value - params.z0) * scale.value)
const y = (z: number) => (zTop.value - z) * scale.value

const rows = computed(() => {
  const r = result.value, pr = profile.value
  if (!r) return []
  return [...r.layers].reverse().map(L => {
    const t = Math.round((L.zt - L.zb) * 100) / 100
    const cell = pr ? cellAt(pr, L.zb) : null
    const err = pr && cell !== null ? sheetError(pr, cell, t) : null
    const fits: SheetFit[] = pr && cell !== null ? fitsAt(pr, params, cell) : []
    return {
      L, t, err, fits,
      over: !!err && (err.outline > params.maxOutline + 1e-9 || err.pockets > params.maxPockets + 1e-9),
      loose: L.pieces.filter(q => q.kind === 'loose').length,
      floating: L.pieces.filter(q => q.kind === 'floating').length,
      warn: r.warnings.filter(w => w.layer === L.index && w.level === 'warn').length,
    }
  })
})

// the profile strip
const cells = computed(() => {
  const pr = profile.value
  if (!pr) return []
  return Array.from({ length: pr.n }, (_, i) => {
    const o = pr.outline[i][0], q = pr.pockets[i][0]
    const v = Math.max(o / params.maxOutline, q / params.maxPockets)
    return { i, z: pr.z0 + i * pr.step, o, q, v }
  })
})
const breaks = computed(() => {
  const pr = profile.value
  if (!pr) return []
  return pr.stepOutline.map((o, j) => ({ z: pr.z0 + (j + 1) * pr.step, o, q: pr.stepPockets[j] }))
    .filter(b => b.o > params.maxOutline || b.q > params.maxPockets)
})
const gridTop = computed(() => profile.value ? profile.value.z0 + profile.value.n * profile.value.step : zTop.value)
const cutTop = computed(() => result.value?.layers.at(-1)?.zt ?? params.z0)

const suggested = computed(() => profile.value ? plan(profile.value, JSON.parse(JSON.stringify(params))) : [])
const isSuggested = computed(() => suggested.value.join() === params.stack.join())
const maxErr = computed(() => {
  let o = 0, q = 0
  for (const r of rows.value) if (r.err) { o = Math.max(o, r.err.outline); q = Math.max(q, r.err.pockets) }
  return { o, q }
})

const mm = (v: number) => (Number.isFinite(v) ? `${fmt(v, 1)} mm` : 'changes')
function optLabel(f: SheetFit): string {
  if (!f.fits) return `   ${f.t} mm — past the top`
  if (f.ok) return `✓ ${f.t} mm` + (f.outline > 0.05 || f.pockets > 0.05 ? ` — walls move ${fmt(Math.max(f.outline, f.pockets), 1)}` : '')
  const why: string[] = []
  if (f.pockets > params.maxPockets) why.push(Number.isFinite(f.pockets) ? `pockets move ${fmt(f.pockets, 1)}` : 'a pocket starts or ends inside')
  if (f.outline > params.maxOutline) why.push(Number.isFinite(f.outline) ? `outline moves ${fmt(f.outline, 1)}` : 'the outline changes inside')
  return `✗ ${f.t} mm — ${why.join(', ')}`
}
function errTitle(r: { err: { outline: number; pockets: number } | null }) {
  if (!r.err) return ''
  return `Within this sheet the outline moves ${mm(r.err.outline)}, the pockets ${mm(r.err.pockets)}` +
    ` (allowed ${params.maxOutline} / ${params.maxPockets} mm)`
}
function cellTitle(c: { z: number; o: number; q: number }) {
  return `z ${fmt(c.z, 1)}–${fmt(c.z + (profile.value?.step ?? 0), 1)}: outline moves ${mm(c.o)}, pockets ${mm(c.q)}`
}
function pick(L: Layer, e: Event) {
  setSheet(L.index, Number((e.target as HTMLSelectElement).value))
}
</script>

<template>
  <div class="stack">
    <div class="head">
      <div class="h1">
        <span>Stack</span>
        <button v-if="profile && !isSuggested" class="ghost sug" title="Plan the whole stack again from the foam and the tolerances" @click="suggestStack">↺ suggest</button>
        <span v-else-if="profile" class="faint small">suggested</span>
      </div>
      <div class="faint small" v-if="result">
        {{ stackSummary(result.layers.map(L => Math.round((L.zt - L.zb) * 100) / 100)) }}
        <template v-if="profile"> · walls move ≤ {{ mm(maxErr.o) }} outline, {{ mm(maxErr.q) }} pockets</template>
      </div>
    </div>
    <div class="scroll">
      <div class="body" :style="{ height: height + 'px' }">
        <svg class="strip" :height="height" width="14">
          <rect v-for="c in cells" :key="c.i" x="0" :y="y(c.z + profile!.step)" width="14" :height="profile!.step * scale"
                :class="c.v > 1 ? 'hot' : c.v > 0.5 ? 'warm' : 'calm'"><title>{{ cellTitle(c) }}</title></rect>
          <rect v-if="zTop > gridTop + 1e-6" x="0" :y="0" width="14" :height="y(gridTop)" class="rest" />
          <line v-for="b in breaks" :key="b.z" x1="0" x2="14" :y1="y(b.z)" :y2="y(b.z)" class="brk">
            <title>z {{ fmt(b.z, 1) }}: the walls jump here (outline {{ mm(b.o) }}, pockets {{ mm(b.q) }}); a sheet should end here</title>
          </line>
        </svg>
        <div v-if="zTop > cutTop + 1e-6" class="uncut" :style="{ top: '0px', height: y(cutTop) + 'px' }">
          <span>not cut ({{ fmt(zTop - cutTop, 1) }} mm)</span>
        </div>
        <div v-for="r in rows" :key="r.L.index" class="row" :class="{ on: sel.layer === r.L.index, over: r.over }"
             :style="{ top: y(r.L.zt) + 'px', height: (r.L.zt - r.L.zb) * scale + 'px' }" @click="selectLayer(r.L.index)">
          <span class="name mono">{{ r.L.name }}</span>
          <span class="z num">{{ fmt(r.L.zb, 0) }}–{{ fmt(r.L.zt, 0) }}</span>
          <select v-if="r.fits.length > 1" :value="r.t" class="tsel" title="Thickness of this sheet; the sheets above are planned again" @click.stop @change="pick(r.L, $event)">
            <option v-for="f in r.fits" :key="f.t" :value="f.t" :disabled="!f.fits">{{ optLabel(f) }}</option>
          </select>
          <span v-else class="tfix num">{{ r.t }} mm</span>
          <span class="chips">
            <span v-if="r.over" class="chip loose" :title="errTitle(r)">±{{ fmt(Math.max(r.err!.outline > params.maxOutline ? r.err!.outline : 0, r.err!.pockets > params.maxPockets ? r.err!.pockets : 0), 1) }}</span>
            <span v-if="r.loose" class="chip loose" :title="`${r.loose} loose pieces`">{{ r.loose }} loose</span>
            <span v-if="r.floating" class="chip floating" :title="`${r.floating} pieces with nothing below`">{{ r.floating }} float</span>
            <span v-if="r.warn" class="chip warn" title="warnings">!</span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stack { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.head { padding: 10px 14px 6px; }
.h1 { display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 13px; min-height: 24px; }
.small { font-size: 11.5px; font-weight: 400; }
.sug { padding: 1px 8px; font-size: 12px; font-weight: 600; }
.scroll { overflow: auto; flex: 1; padding: 2px 8px 10px 10px; }
.body { position: relative; }
.strip { position: absolute; left: 0; top: 0; }
.strip .calm { fill: var(--panel-2); }
.strip .warm { fill: color-mix(in srgb, var(--loose) 35%, var(--panel-2)); }
.strip .hot { fill: color-mix(in srgb, var(--float) 55%, var(--panel-2)); }
.strip .rest { fill: none; }
.strip .brk { stroke: var(--ink); stroke-width: 2.5; }
.uncut {
  position: absolute; left: 20px; right: 0; border-radius: 6px;
  background: repeating-linear-gradient(135deg, transparent 0 5px, var(--line) 5px 6px);
  font-size: 11px; color: var(--ink-3); display: flex; align-items: center; justify-content: center;
}
.row {
  position: absolute; left: 20px; right: 0;
  display: flex; align-items: flex-start; gap: 6px; flex-wrap: wrap;
  padding: 3px 6px; border-radius: 6px; cursor: pointer; font-size: 13px; overflow: hidden;
  border: 1px solid var(--line); background: var(--panel); margin-bottom: -1px;
}
.row:hover { border-color: var(--ink-3); }
.row.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.row.on .z, .row.on .tfix { color: inherit; opacity: 0.75; }
.name { font-weight: 600; line-height: 22px; }
.z { font-size: 12px; color: var(--ink-3); line-height: 22px; min-width: 46px; }
.tsel { width: auto; max-width: 84px; padding: 0 4px; height: 22px; font-size: 12px; }
.row.on .tsel { background: var(--bg); color: var(--ink); }
.tfix { font-size: 12px; line-height: 22px; color: var(--ink-2); }
.chips { display: flex; gap: 4px; margin-left: auto; flex-wrap: wrap; padding-top: 1.5px; }
</style>
