<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue'
import { layer, params, profile, result, selPiece, selectPiece, setSheet } from '../store'
import { fmt } from '../geom'
import { isMixed, layerFileName } from '../export'
import { cellAt, fitsAt } from '../suggest'

const mixed = computed(() => !!result.value && isMixed(result.value))
const thick = computed(() => layer.value ? Math.round((layer.value.zt - layer.value.zb) * 100) / 100 : 0)
/** Every foam thickness, how well it would do as this sheet. */
const fits = computed(() => {
  const pr = profile.value, L = layer.value
  if (!pr || !L) return []
  const c = cellAt(pr, L.zb)
  return c === null ? [] : fitsAt(pr, params, c)
})
const mm = (v: number) => (Number.isFinite(v) ? `${fmt(v, 1)}` : '∞')

const KIND = { main: 'main piece', loose: 'loose piece', floating: 'floating' } as const

const q = selPiece
const frame = computed(() => result.value?.frame)
const notes = computed(() => result.value?.warnings.filter(w => w.piece === q.value?.id) ?? [])
const where = computed(() => {
  const p = q.value, r = result.value
  if (!p || !r) return ''
  const below = p.below.join(', ')
  if (p.kind === 'main') return p.layer === 0 ? 'The bottom sheet: it goes in first.' : `Glue it onto ${below}, outlines aligned.`
  if (p.kind === 'floating')
    return p.above.length ? `Nothing below it. Glue it under ${p.above.join(', ')} before that goes in.` : 'Nothing below or above it: it is not part of the stack.'
  const mark = r.params.marks ? ` Its outline is engraved on ${below} where it goes.` : ''
  return `Place it on ${below}.${mark}`
})
</script>

<template>
  <div class="insp">
    <template v-if="q && frame">
      <div class="title">
        <span class="mono id">{{ q.id }}</span>
        <span class="chip" :class="q.kind">{{ KIND[q.kind] }}</span>
        <button class="ghost close" title="Clear selection" @click="selectPiece('')">×</button>
      </div>
      <p class="where">{{ where }}</p>
      <dl>
        <dt>Size</dt><dd class="num">{{ fmt(q.bbox[2] - q.bbox[0]) }} × {{ fmt(q.bbox[3] - q.bbox[1]) }} mm</dd>
        <dt>Area</dt><dd class="num">{{ fmt(q.area / 100, 1) }} cm²</dd>
        <dt>In file at</dt><dd class="num">x {{ fmt(q.bbox[0] + frame.dx) }}, y {{ fmt(q.bbox[1] + frame.dy) }}</dd>
        <dt>Pockets</dt><dd class="num">{{ q.rings.length - 1 }}</dd>
        <dt>Rests on</dt>
        <dd>
          <template v-if="q.below.length">
            <a v-for="id in q.below" :key="id" class="mono link" @click="selectPiece(id)">{{ id }}</a>
            <span class="faint num">({{ fmt(100 * q.support / q.area, 0) }} % of it)</span>
          </template>
          <span v-else class="faint">—</span>
        </dd>
        <dt>Carries</dt>
        <dd>
          <a v-for="id in q.above" :key="id" class="mono link" @click="selectPiece(id)">{{ id }}</a>
          <span v-if="!q.above.length" class="faint">—</span>
        </dd>
      </dl>
      <ul v-if="notes.length" class="notes">
        <li v-for="(n, i) in notes" :key="i" :class="n.level">{{ n.text }}</li>
      </ul>
    </template>
    <template v-else-if="layer">
      <div class="title"><span class="mono id">{{ layer.name }}</span><span class="faint">{{ layerFileName(layer, mixed) }}</span></div>
      <dl>
        <dt>Foam</dt><dd class="num"><strong>{{ thick }} mm</strong></dd>
        <dt>z</dt><dd class="num">{{ fmt(layer.zb) }} – {{ fmt(layer.zt) }} mm, cut at {{ fmt(layer.zs, 2) }}</dd>
        <dt>Outline</dt><dd class="num">{{ fmt(layer.outlineBot[0]) }} × {{ fmt(layer.outlineBot[1]) }}
          <template v-if="Math.abs(layer.outlineTop[0] - layer.outlineBot[0]) > 0.05"> → {{ fmt(layer.outlineTop[0]) }} × {{ fmt(layer.outlineTop[1]) }}</template></dd>
        <dt>Pieces</dt>
        <dd><a v-for="p in layer.pieces" :key="p.id" class="mono link" :class="p.kind" @click="selectPiece(p.id)">{{ p.id }}</a></dd>
        <dt>Pockets</dt><dd class="num">{{ layer.pockets }}</dd>
      </dl>
      <template v-if="fits.length > 1">
        <div class="fh">Thickness here <span class="faint">walls move, outline / pockets (mm)</span></div>
        <div class="fits">
          <button v-for="f in fits" :key="f.t" :disabled="!f.fits" :class="{ cur: f.t === thick, ok: f.ok, bad: f.fits && !f.ok }"
                  :title="f.fits ? (f.t === thick ? 'this sheet' : 'Use this thickness; the sheets above are planned again') : 'goes past the top of the model'"
                  @click="layer && f.t !== thick && setSheet(layer.index, f.t)">
            <span class="num t">{{ f.t }}</span>
            <span class="num e">{{ f.fits ? `${mm(f.outline)} / ${mm(f.pockets)}` : 'past top' }}</span>
          </button>
        </div>
      </template>
      <p class="faint hint">Click a piece in the 3D view or on the sheet for details.</p>
    </template>
  </div>
</template>

<style scoped>
.insp { border-top: 1px solid var(--line); padding: 12px 14px 14px; font-size: 13px; min-height: 200px; }
.title { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.id { font-size: 15px; font-weight: 700; }
.close { margin-left: auto; padding: 0 8px; font-size: 16px; line-height: 22px; }
.where { margin: 0 0 8px; }
dl { display: grid; grid-template-columns: 78px 1fr; gap: 3px 10px; margin: 0; }
dt { color: var(--ink-3); }
dd { margin: 0; display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: baseline; }
.link { cursor: pointer; text-decoration: underline; text-decoration-color: var(--line-2); text-underline-offset: 2px; }
.link:hover { text-decoration-color: currentColor; }
.link.loose { color: var(--loose); }
.link.floating { color: var(--float); }
.notes { margin: 10px 0 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.notes li { padding: 5px 8px; border-radius: 5px; background: var(--panel-2); font-size: 12.5px; }
.notes li.warn { background: color-mix(in srgb, var(--float) 12%, transparent); }
.hint { margin: 10px 0 0; font-size: 12px; }
.fh { margin: 12px 0 5px; font-weight: 600; font-size: 12.5px; display: flex; justify-content: space-between; gap: 8px; }
.fh .faint { font-weight: 400; font-size: 11px; }
.fits { display: flex; flex-wrap: wrap; gap: 5px; }
.fits button { display: grid; text-align: left; padding: 3px 9px; line-height: 1.25; border-radius: 6px; }
.fits .t { font-weight: 700; }
.fits .t::after { content: ' mm'; font-weight: 400; }
.fits .e { font-size: 11px; color: var(--ink-3); }
.fits button.ok { border-color: color-mix(in srgb, var(--ink-2) 60%, transparent); }
.fits button.ok .t::before { content: '✓ '; color: var(--ink-2); }
.fits button.bad { border-style: dashed; }
.fits button.bad .t::before { content: '✗ '; color: var(--float); }
.fits button.cur { background: var(--accent); color: var(--bg); border-color: var(--accent); cursor: default; }
.fits button.cur .e, .fits button.cur .t::before { color: inherit; opacity: 0.75; }
</style>
