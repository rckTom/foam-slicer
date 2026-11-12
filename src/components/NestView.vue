<!-- SPDX-License-Identifier: GPL-3.0-only -->
<!-- Nesting: settings on the left, the best layout found so far on the right.
     The search keeps running in a worker; the drawing follows it live. -->
<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { fileName, hover, result, sel, selectPiece, setHover } from '../store'
import { activateNest, improvedAt, nestError, nestParams, nestResult, nestStats, pauseNest, resumeNest, startNest } from '../nestStore'
import { apply, shapesById, thicknessesOf } from '../nest'
import type { Blank, NestSheet } from '../nest'
import { download, pathD } from '../draw'
import { fmt, interiorPoint } from '../geom'
import { nestDxf, nestFileName, nestPlanSvg, nestReport, nestSvg, zipNest } from '../export'
import type { Piece, Pt, Ring } from '../types'

onMounted(activateNest)

const thicknesses = computed(() => result.value ? thicknessesOf(result.value.layers) : [])
const pieces = computed(() => new Map((result.value?.layers ?? []).flatMap(L => L.pieces).map(q => [q.id, q] as [string, Piece])))
const shapes = computed(() => (result.value && nestResult.value ? shapesById(result.value, nestResult.value) : new Map()))

// ---- stock editing ---------------------------------------------------------------------
function addStock() {
  nestParams.stock.push({ t: thicknesses.value[0] ?? 10, w: 1000, l: 2000, count: 1 })
}
function removeStock(i: number) { nestParams.stock.splice(i, 1) }

// ---- drawing ----------------------------------------------------------------------------
const SPACE = 80                    // between the sheets, mm
const layout = computed(() => {
  const n = nestResult.value
  if (!n) return { sheets: [], w: 0, h: 0 }
  let x = 0, h = 0
  const sheets = n.sheets.map(s => {
    const parts = s.parts.map(p => {
      const q = shapes.value.get(p.id)
      const rings: Ring[] = (q?.rings ?? []).map((r: Ring) => r.map(([u, v, b]) => { const [a, c] = apply(p.m, u, v); return [a + x, c, b] as Ring[number] }))
      const ip = q ? interiorPoint(q.poly, 16) : [0, 0]
      const [tx, ty] = apply(p.m, ip[0], ip[1])
      const size = Math.min(p.box[2] - p.box[0], p.box[3] - p.box[1])
      // the seams of a split part, along its bounding box
      const seams = (q?.seams ?? []).map((sm: { axis: 0 | 1; c: number }) => {
        const b = q!.bbox
        const ends: Pt[] = sm.axis === 0 ? [[sm.c, b[1]], [sm.c, b[3]]] : [[b[0], sm.c], [b[2], sm.c]]
        const [a, c] = ends.map(([u, v]) => apply(p.m, u, v))
        return { x1: a[0] + x, y1: -a[1], x2: c[0] + x, y2: -c[1] }
      })
      return { p, kind: pieces.value.get(p.from)?.kind ?? 'main', d: pathD(rings), tx: tx + x, ty: -ty, fs: Math.max(6, Math.min(size * 0.16, 34)), seams }
    })
    const off = s.offcut ? {
      ...s.offcut, x: s.offcut.x + x,
      line: s.offcut.line.map(([u, v], k, a) => `${k ? 'L' : 'M'}${u + x} ${-v}` + (k % 2 && k + 1 < a.length ? ` L${a[k + 1][0] + x} ${-v}` : '')).join(' '),
    } : null
    const out = { s, x, parts, off }
    x += s.w + SPACE
    h = Math.max(h, s.l)
    return out
  })
  return { sheets, w: Math.max(0, x - SPACE), h }
})

// view box: fit all, then zoom / pan
const svg = ref<SVGSVGElement>()
const vb = reactive({ x: 0, y: 0, w: 100, h: 100 })
let fittedFor = ''
function fit() {
  const L = layout.value
  if (!L.w) return
  const pad = Math.max(L.w, L.h) * 0.05 + 40
  Object.assign(vb, { x: -pad, y: -L.h - pad, w: L.w + 2 * pad, h: L.h + 2 * pad })
}
watch(layout, L => {
  // refit when the sheets change size, not on every better layout
  const key = L.sheets.map(s => `${s.s.w}x${s.s.l}`).join()
  if (key !== fittedFor) { fittedFor = key; fit() }
}, { immediate: true })

function onWheel(e: WheelEvent) {
  const el = svg.value!
  const pt = el.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY
  const p = pt.matrixTransform(el.getScreenCTM()!.inverse())
  const k = Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0015))
  vb.x = p.x - (p.x - vb.x) * k; vb.y = p.y - (p.y - vb.y) * k; vb.w *= k; vb.h *= k
}
let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; target: Element } | null = null
function onDown(e: PointerEvent) {
  if (e.button !== 0) return
  drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false, target: e.target as Element }
  ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
}
function onMove(e: PointerEvent) {
  if (!drag) return
  const el = svg.value!
  const sc = Math.max(vb.w / el.clientWidth, vb.h / el.clientHeight)
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y
  if (Math.hypot(dx, dy) > 3) drag.moved = true
  vb.x = drag.vx - dx * sc; vb.y = drag.vy - dy * sc
}
function onUp() {
  const d = drag
  drag = null
  if (d && !d.moved) {
    const t = d.target.closest('[data-piece]')
    selectPiece(t ? t.getAttribute('data-piece')! : '')   // a split part selects its piece
  }
}

// ---- status ---------------------------------------------------------------------------
const now = ref(Date.now())
setInterval(() => { now.value = Date.now() }, 500)
const flash = ref(false)
watch(improvedAt, () => { flash.value = true; setTimeout(() => { flash.value = false }, 600) })
const secs = (ms: number) => ms < 10000 ? `${fmt(ms / 1000, 1)} s` : `${fmt(ms / 1000, 0)} s`

function save(s: NestSheet, kind: 'dxf' | 'svg' | 'plan', b?: Blank) {
  const r = result.value, n = nestResult.value
  if (!r || !n) return
  if (kind === 'plan') return download(`${nestFileName(s)}_plan.svg`, nestPlanSvg(r, n, s), 'image/svg+xml')
  download(`${nestFileName(s, b)}.${kind}`, kind === 'dxf' ? nestDxf(r, n, s, b) : nestSvg(r, n, s, b),
    kind === 'dxf' ? 'application/dxf' : 'image/svg+xml')
}
function saveAll() {
  if (result.value && nestResult.value)
    download(`${fileName.value.replace(/\.[^.]+$/, '') || 'insert'}-nest.zip`, zipNest(result.value, nestResult.value, fileName.value), 'application/zip')
}
function saveReport() {
  if (nestResult.value) download('nest.txt', nestReport(nestResult.value, fileName.value), 'text/plain')
}
</script>

<template>
  <div class="nest">
    <aside class="ctl">
      <div class="seg mode">
        <button :class="{ on: nestParams.mode === 'stock' }" @click="nestParams.mode = 'stock'">Stock I have</button>
        <button :class="{ on: nestParams.mode === 'roll' }" @click="nestParams.mode = 'roll'">Fixed width</button>
      </div>
      <p class="faint hint" v-if="nestParams.mode === 'stock'">The raw pieces of foam at hand. They are filled largest first; whatever does not fit is listed.</p>
      <p class="faint hint" v-else>A width per thickness; the search finds the shortest length that takes every piece.</p>

      <table v-if="nestParams.mode === 'stock'" class="stock">
        <thead><tr><th>foam</th><th>width</th><th>length</th><th>count</th><th /></tr></thead>
        <tbody>
          <tr v-for="(s, i) in nestParams.stock" :key="i" :class="{ idle: !thicknesses.includes(s.t) }">
            <td><input type="number" v-model.number="s.t" min="0.5" step="0.5" /></td>
            <td><input type="number" v-model.number="s.w" min="1" step="10" /></td>
            <td><input type="number" v-model.number="s.l" min="1" step="10" /></td>
            <td><input type="number" v-model.number="s.count" min="0" step="1" class="cnt" /></td>
            <td><button class="ghost x" title="Remove" @click="removeStock(i)">×</button></td>
          </tr>
        </tbody>
      </table>
      <button v-if="nestParams.mode === 'stock'" class="ghost add" @click="addStock">+ stock</button>

      <div v-else class="widths">
        <label v-for="t in thicknesses" :key="t">
          <span class="num"><strong>{{ t }} mm</strong> foam, width</span>
          <input type="number" v-model.number="nestParams.widths[String(t)]" min="1" step="10" /> mm
        </label>
      </div>

      <div class="opts">
        <label>Gap <input type="number" v-model.number="nestParams.gap" min="0" step="0.5" /> mm</label>
        <label>Edge <input type="number" v-model.number="nestParams.edge" min="0" step="1" /> mm</label>
        <label class="check"><input type="checkbox" v-model="nestParams.rotate" /> turn pieces 90°</label>
        <label class="check" title="Small pieces go into the foam that falls out of the pockets of bigger ones"><input type="checkbox" v-model="nestParams.holes" /> use pocket drop-outs</label>
      </div>

      <div class="opts block">
        <label title="0: never split. 1: one straight cut, two halves, one new edge each. 2 and up: more cuts, at most this many new edges on any part">
          Split pieces: at most <input type="number" v-model.number="nestParams.splitEdges" min="0" max="4" step="1" /> new edges per part
        </label>
        <template v-if="nestParams.splitEdges > 0">
          <label class="check"><input type="checkbox" v-model="nestParams.keepWhole.bottom" /> keep the bottom sheet whole</label>
          <label class="check"><input type="checkbox" v-model="nestParams.keepWhole.top" /> keep the top sheet whole</label>
          <span class="faint small">Seams stay {{ 15 }} mm clear of pockets and off arcs; the search splits a piece only where it saves foam.</span>
        </template>
      </div>

      <div class="opts block">
        <label class="check" title="Group the pieces into blanks no larger than the laser's work area; cut the blanks from the stock by hand">
          <input type="checkbox" v-model="nestParams.bed.on" /> laser bed
        </label>
        <template v-if="nestParams.bed.on">
          <label><input type="number" v-model.number="nestParams.bed.w" min="50" step="10" /> × <input type="number" v-model.number="nestParams.bed.h" min="50" step="10" /> mm</label>
          <span class="faint small">Blanks are cut to what they hold, so they come in all sizes; each is one laser job.</span>
        </template>
      </div>

      <div v-if="nestResult" class="totals">
        <div v-for="t in nestResult.totals" :key="t.t" class="tot">
          <strong class="num">{{ t.t }} mm</strong>
          <span v-if="t.length" class="num">{{ t.length }} mm long at {{ t.width }} wide</span>
          <span v-else class="num">{{ t.sheets }} piece{{ t.sheets === 1 ? '' : 's' }} of stock</span>
          <span v-if="t.blanks" class="num">{{ t.blanks }} blank{{ t.blanks === 1 ? '' : 's' }}</span>
          <span v-if="t.splits" class="num">{{ t.splits }} split</span>
          <span class="faint num">{{ fmt(100 * t.fill, 0) }} % used</span>
        </div>
        <div v-if="nestResult.unplaced.length" class="miss">
          <strong>Not placed</strong>
          <span v-for="u in nestResult.unplaced" :key="u.id"><a class="mono link" @click="selectPiece(u.id)">{{ u.id }}</a> {{ u.why }}</span>
        </div>
        <div v-if="nestResult.unused.length" class="faint small">
          Left over: <span v-for="(u, i) in nestResult.unused" :key="i" class="num">{{ u.t }} mm {{ u.w }} × {{ u.l }}{{ i < nestResult.unused.length - 1 ? ', ' : '' }}</span>
        </div>
      </div>
      <div class="dl">
        <button class="primary" :disabled="!nestResult?.sheets.length" @click="saveAll">Download nesting (.zip)</button>
        <button class="ghost" :disabled="!nestResult" @click="saveReport">nest.txt</button>
      </div>
      <p class="faint hint">Parts are nested by their bounding boxes. Pieces inside pocket drop-outs are cut first: keep “inner shapes first” on in the laser software.</p>
    </aside>

    <section class="canvas">
      <div class="status">
        <span class="dot" :class="{ run: nestStats?.running, flash }" />
        <template v-if="nestError"><span class="err">{{ nestError }}</span></template>
        <template v-else-if="nestStats">
          <span v-if="nestStats.running">Searching · {{ nestStats.evals.toLocaleString() }} layouts tried · {{ secs(nestStats.ms) }}
            · best found {{ secs(Math.max(0, now - improvedAt)) }} ago</span>
          <span v-else-if="nestStats.done">Settled: no better layout in {{ secs(nestStats.sinceGain) }} · {{ nestStats.evals.toLocaleString() }} layouts tried</span>
          <span v-else>Paused · {{ nestStats.evals.toLocaleString() }} layouts tried</span>
        </template>
        <span v-else class="muted">starting…</span>
        <span class="grow" />
        <button v-if="nestStats?.running" @click="pauseNest">Pause</button>
        <button v-else-if="nestStats" @click="resumeNest">{{ nestStats.done ? 'Search more' : 'Resume' }}</button>
        <button @click="startNest" title="Start the search over">Restart</button>
      </div>
      <svg ref="svg" class="draw" :viewBox="`${vb.x} ${vb.y} ${vb.w} ${vb.h}`" preserveAspectRatio="xMidYMid meet"
           @wheel.prevent="onWheel" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @dblclick="fit">
        <g v-for="L in layout.sheets" :key="L.s.name">
          <rect :x="L.x" :y="-L.s.l" :width="L.s.w" :height="L.s.l" class="stockrect" vector-effect="non-scaling-stroke" />
          <g v-if="L.off">
            <rect :x="L.off.x" :y="-(L.off.y + L.off.h)" :width="L.off.w" :height="L.off.h" class="offcut" vector-effect="non-scaling-stroke" />
            <path :d="L.off.line" class="cutline" vector-effect="non-scaling-stroke" />
            <text :x="L.off.x + L.off.w / 2" :y="-(L.off.y + L.off.h / 2)" :font-size="Math.max(14, Math.min(Math.min(L.off.w, L.off.h) * 0.22, L.off.w / 14))" class="offtext">
              offcut {{ fmt(L.off.w, 0) }} × {{ fmt(L.off.h, 0) }} · {{ L.off.edges }} edges
            </text>
          </g>
          <g v-for="b in L.s.blanks ?? []" :key="'b' + b.name">
            <rect :x="L.x + b.x" :y="-(b.y + b.h)" :width="b.w" :height="b.h" class="blank" vector-effect="non-scaling-stroke" />
            <text :x="L.x + b.x + 6" :y="-(b.y + b.h) + Math.max(10, layout.h * 0.014)" :font-size="Math.max(10, layout.h * 0.012)" class="bname">{{ b.name }}</text>
          </g>
          <text :x="L.x" :y="-L.s.l - Math.max(12, layout.h * 0.012)" :font-size="Math.max(14, layout.h * 0.022)" class="title">
            {{ L.s.name.replace('-', ' mm #') }} · {{ L.s.w }} × {{ L.s.l }}<template v-if="L.s.used < L.s.l - 1"> · {{ L.s.l - L.s.used }} mm left</template>
          </text>
          <path v-for="P in L.parts" :key="P.p.id" :d="P.d" fill-rule="evenodd" :data-piece="P.p.from"
                class="part" :class="[P.kind, { guest: P.p.host, on: sel.piece === P.p.from, hov: hover === P.p.from }]"
                vector-effect="non-scaling-stroke" @pointerenter="setHover(P.p.from)" @pointerleave="setHover('')">
            <title>{{ P.p.id }}{{ P.p.id !== P.p.from ? ` · part of ${P.p.from}` : '' }}{{ P.p.rot ? ' · turned 90°' : '' }}{{ P.p.host ? ` · in the drop-out of ${P.p.host}` : '' }}{{ P.p.bin ? ` · blank ${P.p.bin}` : '' }}</title>
          </path>
          <template v-for="P in L.parts" :key="'s' + P.p.id">
            <line v-for="(sm, k) in P.seams" :key="k" :x1="sm.x1" :y1="sm.y1" :x2="sm.x2" :y2="sm.y2" class="seam" vector-effect="non-scaling-stroke" />
          </template>
          <text v-for="P in L.parts" :key="'t' + P.p.id" :x="P.tx" :y="P.ty" :font-size="P.fs" class="tag">{{ P.p.id }}</text>
        </g>
      </svg>
      <div class="sheets" v-if="nestResult?.sheets.length">
        <span v-for="s in nestResult.sheets" :key="s.name" class="sh">
          <span class="num">{{ s.name.replace('-', ' mm #') }}</span>
          <template v-if="s.blanks">
            <button class="ghost" @click="save(s, 'plan')" title="Where to cut the blanks">plan</button>
            <select class="bsel" @change="(e) => { const v = (e.target as HTMLSelectElement).value; if (v) { const [b, k] = v.split(':'); save(s, k as 'dxf' | 'svg', s.blanks!.find(x => x.name === b)); (e.target as HTMLSelectElement).value = '' } }">
              <option value="">blank…</option>
              <template v-for="b in s.blanks" :key="b.name">
                <option :value="`${b.name}:dxf`">{{ b.name }} DXF ({{ fmt(b.w, 0) }} × {{ fmt(b.h, 0) }})</option>
                <option :value="`${b.name}:svg`">{{ b.name }} SVG</option>
              </template>
            </select>
          </template>
          <template v-else><button class="ghost" @click="save(s, 'dxf')">DXF</button><button class="ghost" @click="save(s, 'svg')">SVG</button></template>
        </span>
        <span class="legend"><i class="lg seam" /> seam (glue) <i class="lg blank" /> blank <i class="lg off" /> offcut</span>
        <span class="faint grow">scroll to zoom, drag to pan, double-click to fit</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.nest { height: 100%; display: grid; grid-template-columns: 330px 1fr; min-height: 0; }
.ctl { border-right: 1px solid var(--line); padding: 12px 14px; overflow: auto; font-size: 13px; display: flex; flex-direction: column; gap: 10px; }
.mode { align-self: flex-start; }
.hint { margin: 0; font-size: 12px; }
.stock { border-collapse: collapse; width: 100%; }
.stock th { text-align: left; font-weight: 500; color: var(--ink-3); font-size: 11.5px; padding: 0 2px 3px; }
.stock td { padding: 2px; }
.stock input { width: 100%; padding: 3px 5px; }
.stock input.cnt { width: 48px; }
.stock tr.idle input { opacity: 0.5; }
.x { padding: 0 6px; }
.add { align-self: flex-start; padding: 2px 8px; }
.widths { display: grid; gap: 6px; }
.widths label { display: flex; align-items: center; gap: 6px; }
.widths label span { flex: 1; }
.opts { display: flex; flex-wrap: wrap; gap: 8px 16px; color: var(--ink-2); }
.opts label { display: inline-flex; align-items: center; gap: 5px; }
.opts input[type="number"] { width: 56px; }
.totals { display: grid; gap: 6px; border-top: 1px solid var(--line); padding-top: 10px; }
.tot { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.miss { display: grid; gap: 2px; padding: 7px 9px; border-radius: 6px; background: color-mix(in srgb, var(--float) 10%, transparent); font-size: 12.5px; }
.small { font-size: 12px; }
.link { cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.dl { display: flex; gap: 8px; align-items: center; }

.canvas { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.status { display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-bottom: 1px solid var(--line); font-size: 13px; flex-wrap: wrap; }
.status button { padding: 3px 10px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ink-3); flex: none; transition: transform 0.2s; }
.dot.run { background: var(--loose); animation: pulse 1.2s ease-in-out infinite; }
.dot.flash { transform: scale(1.8); background: var(--engrave); }
@keyframes pulse { 50% { opacity: 0.35; } }
.err { color: var(--cut); }
.grow { flex: 1; }
.draw { flex: 1; min-height: 0; width: 100%; display: block; cursor: grab; touch-action: none; user-select: none; }
.draw:active { cursor: grabbing; }
.stockrect { fill: color-mix(in srgb, var(--panel-2) 70%, transparent); stroke: var(--ink-3); stroke-width: 1; }
.offcut { fill: color-mix(in srgb, var(--engrave) 9%, transparent); stroke: none; }
.cutline { fill: none; stroke: var(--engrave); stroke-width: 1.5; stroke-dasharray: 8 5; }
.offtext { fill: var(--engrave); font-family: var(--sans); font-weight: 600; text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
.blank { fill: none; stroke: var(--ink-2); stroke-width: 1.2; stroke-dasharray: 10 4 2 4; }
.bname { fill: var(--ink-2); font-family: var(--mono); font-weight: 700; pointer-events: none; }
.seam { stroke: var(--loose); stroke-width: 3; stroke-linecap: round; pointer-events: none; }
.opts.block { flex-direction: column; flex-wrap: nowrap; gap: 6px; border-top: 1px solid var(--line); padding-top: 10px; }
.bsel { width: auto; padding: 1px 4px; font-size: 12px; }
.legend { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); }
.lg { display: inline-block; width: 16px; height: 0; border-top: 2px solid; margin-left: 6px; }
.lg.seam { border-color: var(--loose); border-top-width: 3px; }
.lg.blank { border-color: var(--ink-2); border-top-style: dashed; }
.lg.off { height: 10px; border: 1px dashed var(--engrave); background: color-mix(in srgb, var(--engrave) 12%, transparent); }
.title { fill: var(--ink-2); font-family: var(--sans); font-weight: 600; }
.part { fill: color-mix(in srgb, var(--sheet) 85%, transparent); stroke: var(--cut); stroke-width: 1; cursor: pointer; transition: d 0.25s; }
.part.loose { fill: color-mix(in srgb, var(--loose) 35%, var(--panel)); }
.part.floating { fill: color-mix(in srgb, var(--float) 35%, var(--panel)); }
.part.guest { stroke-dasharray: 4 2; }
.part.hov { fill: color-mix(in srgb, var(--sheet) 100%, var(--ink) 15%); }
.part.on { stroke-width: 3; }
.tag { fill: var(--ink); font-family: var(--mono); font-weight: 700; text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
.sheets { display: flex; gap: 6px 14px; align-items: center; padding: 6px 12px; border-top: 1px solid var(--line); flex-wrap: wrap; font-size: 12.5px; }
.sh { display: inline-flex; align-items: center; gap: 2px; }
.sh .ghost { padding: 1px 6px; font-size: 12px; }
.sheets .grow { text-align: right; }
@media (max-width: 900px) {
  .nest { grid-template-columns: 1fr; height: auto; }
  .ctl { border-right: 0; border-bottom: 1px solid var(--line); }
  .canvas { height: 75vh; }
}
</style>
