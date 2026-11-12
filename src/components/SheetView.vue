<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { hover, layer, result, sel, selectLayer, selectPiece, setHover, view } from '../store'
import { download, pathD, viewBoxOf } from '../draw'
import { fmt, interiorPoint } from '../geom'
import { isMixed, layerDxf, layerFileName, layerSvg } from '../export'
import type { BBox, Label } from '../types'

const svg = ref<SVGSVGElement>()
const L = layer
const below = computed(() => (result.value && L.value && L.value.index > 0) ? result.value.layers[L.value.index - 1] : null)

const frameBox = computed<BBox | null>(() => {
  const r = result.value
  if (!r) return null
  return [r.bbox.min[0] - r.params.margin, r.bbox.min[1] - r.params.margin, r.bbox.max[0] + r.params.margin, r.bbox.max[1] + r.params.margin]
})

// view box: fitted to the sheet frame, then zoomed / panned
const vb = reactive({ x: 0, y: 0, w: 100, h: 100 })
function fit() {
  const b = frameBox.value
  if (!b) return
  const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.04
  const [x, y, w, h] = viewBoxOf(b, pad)
  Object.assign(vb, { x, y, w, h })
}
watch(frameBox, (a, b) => { if (!b || !a || a.some((v, i) => Math.abs(v - b[i]) > 1e-6)) fit() }, { immediate: true })

function toModel(e: { clientX: number; clientY: number }): [number, number] {
  const el = svg.value!
  const pt = el.createSVGPoint()
  pt.x = e.clientX; pt.y = e.clientY
  const m = el.getScreenCTM()!.inverse()
  const p = pt.matrixTransform(m)
  return [p.x, p.y]
}
function onWheel(e: WheelEvent) {
  const [mx, my] = toModel(e)
  const k = Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0015))
  vb.x = mx - (mx - vb.x) * k
  vb.y = my - (my - vb.y) * k
  vb.w *= k
  vb.h *= k
}
let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; target: Element } | null = null
function onDown(e: PointerEvent) {
  if (e.button !== 0) return
  // the target is taken now: with the pointer captured, pointerup lands on the svg
  drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false, target: e.target as Element }
  ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
}
function onMove(e: PointerEvent) {
  if (!drag) return
  const el = svg.value!
  const s = vb.w / el.clientWidth
  const sy = vb.h / el.clientHeight
  const sc = Math.max(s, sy)                      // preserveAspectRatio meet
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y
  if (Math.hypot(dx, dy) > 3) drag.moved = true
  vb.x = drag.vx - dx * sc
  vb.y = drag.vy - dy * sc
}
function onUp() {
  const d = drag
  drag = null
  if (d && !d.moved) {
    const t = d.target.closest('[data-piece]')
    selectPiece(t ? t.getAttribute('data-piece')! : '')
  }
}

const pieces = computed(() => (L.value?.pieces ?? []).map(q => ({ q, d: pathD(q.rings) })))
const belowD = computed(() => below.value ? pathD(below.value.pieces.flatMap(q => q.rings)) : '')
const marks = computed(() => (L.value?.marks ?? []).map(m => ({ m, d: pathD(m.rings) })))
const labels = computed<Label[]>(() => [
  ...(L.value?.pieces ?? []).map(q => q.label),
  ...(L.value?.marks ?? []).map(m => m.label),
].filter((l): l is Label => !!l))
// ids of pieces without an engraved label, drawn as plain tags
const tags = computed(() => (L.value?.pieces ?? []).filter(q => !q.label).map(q => ({
  id: q.id, x: interiorPoint(q.poly)[0], y: -interiorPoint(q.poly)[1],
  s: Math.min(Math.max(Math.min(q.bbox[2] - q.bbox[0], q.bbox[3] - q.bbox[1]) * 0.22, 3), 14),
})))

function save(kind: 'dxf' | 'svg') {
  const r = result.value, l = L.value
  if (!r || !l) return
  const name = layerFileName(l, isMixed(r)) + '.' + kind
  download(name, kind === 'dxf' ? layerDxf(r, l) : layerSvg(r, l), kind === 'dxf' ? 'application/dxf' : 'image/svg+xml')
}
</script>

<template>
  <div class="sheet" v-if="L && result">
    <div class="bar">
      <button class="ghost" :disabled="L.index === 0" @click="selectLayer(L.index - 1)" title="Sheet below (↓)">▼</button>
      <strong class="mono">{{ L.name }}</strong>
      <button class="ghost" :disabled="L.index === result.layers.length - 1" @click="selectLayer(L.index + 1)" title="Sheet above (↑)">▲</button>
      <span class="faint num">{{ fmt(L.zt - L.zb, 0) }} mm foam · z {{ fmt(L.zb) }}–{{ fmt(L.zt) }}, cut at {{ fmt(L.zs, 2) }}</span>
      <span class="grow" />
      <label class="check"><input type="checkbox" v-model="view.below" :disabled="!below" /> sheet below</label>
      <button @click="save('dxf')">DXF</button>
      <button @click="save('svg')">SVG</button>
    </div>
    <svg ref="svg" class="canvas" :viewBox="`${vb.x} ${vb.y} ${vb.w} ${vb.h}`" preserveAspectRatio="xMidYMid meet"
         @wheel.prevent="onWheel" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @dblclick="fit">
      <rect v-if="frameBox" :x="frameBox[0]" :y="-frameBox[3]" :width="frameBox[2] - frameBox[0]" :height="frameBox[3] - frameBox[1]"
            class="frame" vector-effect="non-scaling-stroke" />
      <path v-if="view.below && belowD" :d="belowD" class="below" fill-rule="evenodd" vector-effect="non-scaling-stroke" />
      <path v-for="p in pieces" :key="p.q.id" :d="p.d" fill-rule="evenodd" :data-piece="p.q.id"
            class="piece" :class="[p.q.kind, { on: sel.piece === p.q.id, hov: hover === p.q.id }]"
            vector-effect="non-scaling-stroke" @pointerenter="setHover(p.q.id)" @pointerleave="setHover('')">
        <title>{{ p.q.id }} · {{ fmt(p.q.bbox[2] - p.q.bbox[0]) }} × {{ fmt(p.q.bbox[3] - p.q.bbox[1]) }} mm</title>
      </path>
      <path v-for="m in marks" :key="'m' + m.m.piece" :d="m.d" class="mark" vector-effect="non-scaling-stroke" />
      <text v-for="(l, i) in labels" :key="'l' + i" :x="l.x" :y="-l.y" :font-size="l.h" class="engrave">{{ l.text }}</text>
      <text v-for="t in tags" :key="'t' + t.id" :x="t.x" :y="t.y" :font-size="t.s" class="tag">{{ t.id }}</text>
    </svg>
    <div class="legend">
      <span><i class="ln cut" /> cut</span>
      <span><i class="ln engrave" /> engrave</span>
      <span><i class="sw loose" /> loose</span>
      <span><i class="sw floating" /> floating</span>
      <span v-if="view.below && below"><i class="ln below" /> {{ below.name }} below</span>
      <span class="faint grow num">{{ fmt(result.frame.w) }} × {{ fmt(result.frame.h) }} mm · scroll to zoom, drag to pan, double-click to fit</span>
    </div>
  </div>
</template>

<style scoped>
.sheet { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.bar .ghost { padding: 2px 7px; font-size: 11px; }
.bar label { display: inline-flex; gap: 5px; align-items: center; font-size: 13px; color: var(--ink-2); }
.grow { flex: 1; }
.canvas { flex: 1; min-height: 0; width: 100%; cursor: grab; touch-action: none; user-select: none; display: block; }
.canvas:active { cursor: grabbing; }

.frame { fill: none; stroke: var(--line-2); stroke-width: 1; stroke-dasharray: 5 4; }
.below { fill: none; stroke: var(--ink-3); stroke-width: 1; stroke-dasharray: 6 4; opacity: 0.8; pointer-events: none; }
.piece { fill: color-mix(in srgb, var(--sheet) 70%, transparent); stroke: var(--cut); stroke-width: 1.4; cursor: pointer; }
.piece.loose { fill: color-mix(in srgb, var(--loose) 32%, transparent); }
.piece.floating { fill: color-mix(in srgb, var(--float) 32%, transparent); }
.piece.hov { fill: color-mix(in srgb, var(--sheet) 100%, var(--ink) 10%); }
.piece.loose.hov { fill: color-mix(in srgb, var(--loose) 50%, transparent); }
.piece.floating.hov { fill: color-mix(in srgb, var(--float) 50%, transparent); }
.piece.on { stroke-width: 3; }
.mark { fill: none; stroke: var(--engrave); stroke-width: 1.2; stroke-dasharray: 4 3; pointer-events: none; }
.engrave { fill: var(--engrave); font-family: sans-serif; pointer-events: none; }
.tag { fill: var(--ink); font-family: var(--mono); font-weight: 700; text-anchor: middle; dominant-baseline: middle; pointer-events: none; }

.legend { display: flex; gap: 14px; align-items: center; padding: 6px 12px; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-2); flex-wrap: wrap; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend .grow { justify-content: flex-end; }
.ln { width: 16px; height: 0; border-top: 2px solid; display: inline-block; }
.ln.cut { border-color: var(--cut); }
.ln.engrave { border-color: var(--engrave); border-top-style: dashed; }
.ln.below { border-color: var(--ink-3); border-top-style: dashed; }
.sw { width: 11px; height: 11px; border-radius: 2px; display: inline-block; }
.sw.loose { background: color-mix(in srgb, var(--loose) 45%, transparent); border: 1px solid var(--loose); }
.sw.floating { background: color-mix(in srgb, var(--float) 45%, transparent); border: 1px solid var(--float); }
</style>
