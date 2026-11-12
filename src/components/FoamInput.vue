<!-- SPDX-License-Identifier: GPL-3.0-only -->
<!-- The foam thicknesses at hand, as removable chips plus an input to add one. -->
<script setup lang="ts">
import { ref } from 'vue'
import { params } from '../store'

const draft = ref<number | ''>('')

function add() {
  const t = Math.round(Number(draft.value) * 100) / 100
  if (!(t > 0) || params.thicknesses.includes(t)) { draft.value = ''; return }
  params.thicknesses = [...params.thicknesses, t].sort((a, b) => a - b)
  draft.value = ''
}
function remove(t: number) {
  if (params.thicknesses.length > 1) params.thicknesses = params.thicknesses.filter(v => v !== t)
}
</script>

<template>
  <span class="foam">
    <span class="lbl">Foam</span>
    <span v-for="t in params.thicknesses" :key="t" class="t num">
      {{ t }}
      <button v-if="params.thicknesses.length > 1" class="x" :title="`Remove ${t} mm`" @click="remove(t)">×</button>
    </span>
    <input type="number" v-model.number="draft" min="0.5" step="0.5" placeholder="add" title="Add a thickness (Enter)"
           @keydown.enter="add" @blur="add" />
    <span>mm</span>
  </span>
</template>

<style scoped>
.foam { display: inline-flex; align-items: center; gap: 5px; color: var(--ink-2); flex-wrap: wrap; }
.lbl { margin-right: 1px; }
.t {
  display: inline-flex; align-items: center; gap: 2px;
  height: 26px; padding: 0 4px 0 9px; border-radius: 6px;
  background: var(--panel-2); border: 1px solid var(--line-2); color: var(--ink); font-weight: 600;
}
.t:has(.x) { padding-right: 2px; }
.t:not(:has(.x)) { padding-right: 9px; }
.x { border: 0; background: transparent; padding: 0 5px; line-height: 20px; color: var(--ink-3); border-radius: 4px; }
.x:hover { color: var(--ink); background: var(--line); }
input { width: 58px !important; }
</style>
