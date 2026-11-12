<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue'
import { fileName, result, selectLayer, selectPiece } from '../store'
import { cutlist } from '../export'
import type { Warning } from '../types'

const warnings = computed(() => [...(result.value?.warnings ?? [])].sort((a, b) => (a.level === b.level ? 0 : a.level === 'warn' ? -1 : 1)))
const text = computed(() => result.value ? cutlist(result.value, fileName.value) : '')

function go(w: Warning) {
  if (w.piece) selectPiece(w.piece)
  else if (w.layer !== undefined) selectLayer(w.layer)
}
</script>

<template>
  <div class="rep" v-if="result">
    <h2>Checks</h2>
    <p v-if="!warnings.length" class="muted">Nothing to report: every sheet is one piece, with its pockets the same at the bottom and the top.</p>
    <ul class="warn">
      <li v-for="(w, i) in warnings" :key="i" :class="[w.level, { link: w.piece || w.layer !== undefined }]" @click="go(w)">
        <span class="chip" :class="w.level === 'warn' ? 'warn' : ''">{{ w.level === 'warn' ? 'warning' : 'note' }}</span>
        <span>{{ w.text }}</span>
      </li>
    </ul>
    <h2>Cut list</h2>
    <pre class="mono">{{ text }}</pre>
  </div>
</template>

<style scoped>
.rep { padding: 16px 20px 28px; max-width: 1000px; }
h2 { font-size: 16px; margin: 0 0 8px; }
h2 + p { margin-top: 0; }
.warn { list-style: none; margin: 0 0 22px; padding: 0; display: grid; gap: 5px; }
.warn li { display: flex; gap: 10px; align-items: baseline; padding: 6px 10px; border-radius: 6px; background: var(--panel); border: 1px solid var(--line); }
.warn li.link { cursor: pointer; }
.warn li.link:hover { border-color: var(--ink-3); }
.warn .chip { flex: none; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow: auto; font-size: 12px; line-height: 1.5; margin: 0; }
</style>
