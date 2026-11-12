<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import sampleUrl from '../examples/transport_insert.FCStd?url'
import StackPanel from './components/StackPanel.vue'
import FoamInput from './components/FoamInput.vue'
import Inspector from './components/Inspector.vue'
import View3D from './components/View3D.vue'
import SheetView from './components/SheetView.vue'
import Assembly from './components/Assembly.vue'
import Report from './components/Report.vue'
import NestView from './components/NestView.vue'
import { choices, choose, error, fileName, model, openFile, params, progress, result, sel, selectLayer } from './store'
import { cutlist, zipAll } from './export'
import { download } from './draw'
import { fmt } from './geom'

type Mode = 'split' | '3d' | 'sheet' | 'assembly' | 'nest' | 'report'
const mode = ref<Mode>('split')
const dragging = ref(false)
const picker = ref<HTMLInputElement>()

const warnCount = computed(() => result.value?.warnings.filter(w => w.level === 'warn').length ?? 0)
const looseCount = computed(() => result.value?.layers.reduce((s, L) => s + L.pieces.filter(q => q.kind !== 'main').length, 0) ?? 0)
const baseName = computed(() => fileName.value.replace(/\.[^.]+$/, '') || 'insert')

async function readFile(f: File) {
  await openFile(f.name, await f.arrayBuffer())
}
function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) void readFile(f)
  ;(e.target as HTMLInputElement).value = ''
}
async function loadSample() {
  const r = await fetch(sampleUrl)
  await openFile('transport_insert.FCStd', await r.arrayBuffer())
}

let depth = 0
function onDragEnter(e: DragEvent) { if (e.dataTransfer?.types.includes('Files')) { depth++; dragging.value = true } }
function onDragLeave() { if (--depth <= 0) { depth = 0; dragging.value = false } }
function onDrop(e: DragEvent) {
  depth = 0
  dragging.value = false
  const f = e.dataTransfer?.files?.[0]
  if (f) void readFile(f)
}

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT') return
  if (e.key === 'ArrowUp' || e.key === 'PageUp') { selectLayer(sel.layer + 1); e.preventDefault() }
  if (e.key === 'ArrowDown' || e.key === 'PageDown') { selectLayer(sel.layer - 1); e.preventDefault() }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function saveZip() {
  if (result.value) download(`${baseName.value}-sheets.zip`, zipAll(result.value, fileName.value), 'application/zip')
}
function saveCutlist() {
  if (result.value) download('cutlist.txt', cutlist(result.value, fileName.value), 'text/plain')
}

const atPreset = computed(() => params.at === 0 ? 'bottom' : params.at === 0.5 ? 'middle' : params.at === 1 ? 'top' : '')
</script>

<template>
  <div class="app" @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop">
    <header class="top">
      <div class="brand">
        <strong>Foam Slicer</strong>
      </div>
      <div class="file" v-if="fileName">
        <span class="mono">{{ fileName }}</span>
        <select v-if="choices.length > 1" :value="model?.choice ?? ''" @change="choose(($event.target as HTMLSelectElement).value)">
          <option value="" disabled>pick a body…</option>
          <option v-for="c in choices" :key="c.id" :value="c.id">{{ c.label }} ({{ c.type }})</option>
        </select>
        <span v-if="model" class="faint num">
          {{ fmt(model.info.bbox.max[0] - model.info.bbox.min[0]) }} × {{ fmt(model.info.bbox.max[1] - model.info.bbox.min[1]) }} × {{ fmt(model.info.bbox.max[2] - model.info.bbox.min[2]) }} mm
        </span>
      </div>
      <div class="spacer" />
      <div class="status" v-if="progress.busy">
        <span class="spinner" />
        <span class="muted">{{ progress.text }}</span>
      </div>
      <button @click="picker?.click()">Open model…</button>
      <button class="primary" :disabled="!result" @click="saveZip" title="DXF + SVG per sheet and the cut list">Download sheets (.zip)</button>
      <input ref="picker" type="file" accept=".step,.stp,.brep,.brp,.fcstd,.FCStd" hidden @change="onPick" />
    </header>

    <section class="settings" v-if="model">
      <FoamInput />
      <span class="group" title="How far the walls may move inside one sheet (it is cut flat): the outer outline, and the pockets">
        Max error: outline <input type="number" v-model.number="params.maxOutline" min="0" step="0.5" />
        pockets <input type="number" v-model.number="params.maxPockets" min="0" step="0.1" /> mm
      </span>
      <label>First sheet at z <input type="number" v-model.number="params.z0" step="1" /> mm</label>
      <span class="group">
        <span>Cut at</span>
        <span class="seg">
          <button :class="{ on: atPreset === 'bottom' }" @click="params.at = 0">bottom</button>
          <button :class="{ on: atPreset === 'middle' }" @click="params.at = 0.5">middle</button>
          <button :class="{ on: atPreset === 'top' }" @click="params.at = 1">top</button>
        </span>
        <span class="faint">of each sheet</span>
      </span>
      <label>Margin <input type="number" v-model.number="params.margin" min="0" step="1" /> mm</label>
      <label class="check"><input type="checkbox" v-model="params.labels" /> Engrave ids</label>
      <label v-if="params.labels">Text <input type="number" v-model.number="params.labelHeight" min="2" max="20" step="0.5" /> mm</label>
      <label class="check" title="Engrave the outline of each loose piece on the sheet it sits on"><input type="checkbox" v-model="params.marks" /> Engrave placement outlines</label>
    </section>

    <div v-if="error" class="error">{{ error }}</div>

    <div class="body" v-if="model">
      <aside class="side">
        <StackPanel />
        <Inspector />
      </aside>
      <main class="main">
        <nav class="tabs">
          <div class="seg">
            <button :class="{ on: mode === 'split' }" @click="mode = 'split'">3D + Sheet</button>
            <button :class="{ on: mode === '3d' }" @click="mode = '3d'">3D</button>
            <button :class="{ on: mode === 'sheet' }" @click="mode = 'sheet'">Sheet</button>
            <button :class="{ on: mode === 'assembly' }" @click="mode = 'assembly'">Assembly</button>
            <button :class="{ on: mode === 'nest' }" @click="mode = 'nest'">Nest</button>
            <button :class="{ on: mode === 'report' }" @click="mode = 'report'">
              Report <span v-if="warnCount" class="chip warn">{{ warnCount }}</span>
            </button>
          </div>
          <span class="faint summary" v-if="result">
            {{ result.layers.length }} sheets · {{ result.layers.reduce((s, L) => s + L.pieces.length, 0) }} pieces
            <template v-if="looseCount"> · <span style="color: var(--loose)">{{ looseCount }} loose</span></template>
            · {{ fmt(result.ms / 1000, 1) }} s
          </span>
          <button class="ghost" v-if="mode === 'report'" :disabled="!result" @click="saveCutlist">cutlist.txt</button>
        </nav>
        <div class="views" :class="mode">
          <View3D v-show="mode === 'split' || mode === '3d'" class="pane" />
          <SheetView v-if="mode === 'split' || mode === 'sheet'" class="pane" />
          <Assembly v-if="mode === 'assembly'" class="pane scroll" />
          <NestView v-if="mode === 'nest'" class="pane" />
          <Report v-if="mode === 'report'" class="pane scroll" />
        </div>
      </main>
    </div>

    <div v-else class="empty" :class="{ busy: progress.busy }">
      <div class="drop">
        <svg viewBox="0 0 120 80" width="120" height="80" aria-hidden="true">
          <g fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M20 58 L60 72 L100 58 L60 44 Z" />
            <path d="M20 48 L60 62 L100 48" opacity="0.7" />
            <path d="M20 38 L60 52 L100 38" opacity="0.5" />
            <path d="M20 28 L60 42 L100 28 L60 14 Z" opacity="0.35" />
            <ellipse cx="52" cy="28" rx="12" ry="5" stroke="var(--cut)" />
          </g>
        </svg>
        <h1>Cut a foam insert into sheets</h1>
        <p class="muted">
          Drop a STEP, BREP or FreeCAD (.FCStd) model here. It is cut into flat sheets for the laser,
          with the cuts in 3D and per sheet, loose pieces found, and where each piece goes.
          Everything runs in this browser; nothing is uploaded.
        </p>
        <div class="row">
          <button class="primary" @click="picker?.click()" :disabled="progress.busy">Open model…</button>
          <button @click="loadSample" :disabled="progress.busy">Try the example: a transport case insert</button>
        </div>
        <p v-if="progress.busy" class="muted"><span class="spinner" /> {{ progress.text }}…
          <span class="faint">(the first load fetches the 23 MB geometry kernel)</span></p>
        <p v-if="choices.length > 1 && !model" class="pick">
          This file holds several bodies:
          <button v-for="c in choices" :key="c.id" @click="choose(c.id)">{{ c.label }}</button>
        </p>
      </div>
    </div>

    <div v-if="dragging" class="dropzone"><div>Drop the model to slice it</div></div>
  </div>
</template>

<style scoped>
.app { height: 100%; display: flex; flex-direction: column; min-height: 0; }

.top {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 9px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.brand { display: flex; align-items: baseline; gap: 10px; }
.brand strong { font-size: 15px; letter-spacing: 0.01em; }
.brand span { font-size: 12px; }
.file { display: flex; align-items: center; gap: 10px; min-width: 0; }
.file .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file select { width: auto; }
.spacer { flex: 1; }
.status { display: flex; align-items: center; gap: 7px; font-size: 13px; }

.settings {
  display: flex; align-items: center; gap: 8px 20px; flex-wrap: wrap;
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  font-size: 13px;
}
.settings label, .settings .group { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); }
.settings input[type="number"] { width: 64px; }

.error {
  margin: 10px 16px 0; padding: 8px 12px; border-radius: 6px;
  background: color-mix(in srgb, var(--cut) 12%, transparent); color: var(--cut);
}

.body { flex: 1; min-height: 0; display: grid; grid-template-columns: 310px 1fr; }
.side {
  min-height: 0; display: flex; flex-direction: column;
  border-right: 1px solid var(--line);
  background: var(--panel);
}
.main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.tabs { display: flex; align-items: center; gap: 14px; padding: 8px 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.tabs .seg button { display: inline-flex; align-items: center; gap: 6px; }
.summary { font-size: 12.5px; margin-left: auto; }
.views { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr; }
.views.split { grid-template-columns: 1fr 1fr; }
.views.split > .pane + .pane { border-left: 1px solid var(--line); }
.pane { min-width: 0; min-height: 0; position: relative; }
.scroll { overflow: auto; }

.empty { flex: 1; display: grid; place-items: center; padding: 24px 16px; }
.drop {
  max-width: 560px; text-align: center;
  border: 1.5px dashed var(--line-2); border-radius: 14px; padding: 36px 32px;
  background: var(--panel);
}
.drop svg { color: var(--ink-2); }
.drop h1 { font-size: 21px; margin: 12px 0 8px; font-weight: 650; }
.drop p { margin: 0 0 18px; }
.drop .row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.drop .pick { margin-top: 16px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; align-items: center; }

.dropzone {
  position: fixed; inset: 0; z-index: 50;
  display: grid; place-items: center;
  background: color-mix(in srgb, var(--bg) 70%, transparent);
  backdrop-filter: blur(2px);
  pointer-events: none;
}
.dropzone div {
  border: 2px dashed var(--ink-2); border-radius: 16px;
  padding: 40px 60px; font-size: 18px; font-weight: 600; background: var(--panel);
}

.spinner {
  width: 12px; height: 12px; border-radius: 50%; display: inline-block; vertical-align: -1px;
  border: 2px solid var(--line-2); border-top-color: var(--ink);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* narrow screens: the page scrolls, each view gets a fixed height */
@media (max-width: 900px) {
  .app { height: auto; min-height: 100%; }
  .body { display: block; }
  .side { border-right: 0; border-bottom: 1px solid var(--line); }
  .views, .views.split { display: block; }
  .pane { height: 72vh; }
  .views.split > .pane + .pane { border-left: 0; border-top: 1px solid var(--line); }
  .summary { margin-left: 0; }
}

@media print {
  .top, .settings, .side, .tabs { display: none; }
  .body { display: block; }
  .scroll { overflow: visible; }
}
</style>
