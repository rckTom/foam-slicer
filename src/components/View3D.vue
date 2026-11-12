<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { hover, model, result, sel, selectPiece, view } from '../store'
import type { Piece } from '../types'

const host = ref<HTMLDivElement>()
const fadeAbove = ref(true)

let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let controls: OrbitControls
let ro: ResizeObserver
let mq: MediaQueryList
const modelGroup = new THREE.Group()
const sheetGroup = new THREE.Group()
const cutGroup = new THREE.Group()          // selected sheet: section plane + contour
type Slab = { piece: Piece; mesh: THREE.Mesh; edges: THREE.LineSegments; mat: THREE.MeshStandardMaterial; emat: THREE.LineBasicMaterial }
let slabs: Slab[] = []
let colors: Record<string, THREE.Color> = {}

function css(name: string): THREE.Color {
  const v = getComputedStyle(host.value!).getPropertyValue(name).trim()
  return new THREE.Color().setStyle(v || '#888', THREE.SRGBColorSpace)
}
function readColors() {
  colors = Object.fromEntries(['--bg', '--sheet', '--sheet-2', '--sheet-edge', '--cut', '--engrave', '--loose', '--float', '--plane', '--ink', '--ink-3']
    .map(n => [n, css(n)]))
}

let frame = 0
function render() {
  if (frame) return
  frame = requestAnimationFrame(() => { frame = 0; renderer.render(scene, camera) })
}

function disposeGroup(g: THREE.Group) {
  g.traverse(o => {
    const m = o as THREE.Mesh
    m.geometry?.dispose()
    const mat = m.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach(x => x.dispose())
    else mat?.dispose()
  })
  g.clear()
}

function buildModel() {
  disposeGroup(modelGroup)
  fitted = false
  const m = model.value
  if (!m) return
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(m.mesh.positions, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(m.mesh.normals, 3))
  g.setIndex(new THREE.BufferAttribute(m.mesh.index, 1))
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    color: colors['--sheet'], transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide,
  }))
  mesh.renderOrder = 2
  const eg = new THREE.BufferGeometry()
  eg.setAttribute('position', new THREE.BufferAttribute(m.mesh.edges, 3))
  const lines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: colors['--ink-3'], transparent: true, opacity: 0.55 }))
  modelGroup.add(mesh, lines)
  fitCamera()
}

let fitted = false
/** Look at the model from the front right, far enough that it fits either way. */
function fitCamera() {
  const m = model.value
  if (!m) return
  const { min, max } = m.info.bbox
  const c = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2
  const vfov = THREE.MathUtils.degToRad(camera.fov)
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect)
  const dist = radius / Math.sin(Math.min(vfov, hfov) / 2)
  camera.near = radius / 50
  camera.far = dist + radius * 20
  camera.position.copy(c).add(new THREE.Vector3(0.45, -0.75, 0.6).normalize().multiplyScalar(dist))
  camera.updateProjectionMatrix()
  controls.target.copy(c)
  controls.update()
  fitted = camera.aspect !== 1
  render()
}

function shapeOf(q: Piece): THREE.Shape {
  const [outer, ...holes] = q.poly
  const s = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)))
  for (const h of holes) s.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))))
  return s
}

function buildSheets() {
  disposeGroup(sheetGroup)
  slabs = []
  const r = result.value
  if (!r) return
  for (const L of r.layers) for (const q of L.pieces) {
    const geo = new THREE.ExtrudeGeometry(shapeOf(q), { depth: L.zt - L.zb, bevelEnabled: false, curveSegments: 1 })
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, transparent: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.userData.piece = q.id
    const emat = new THREE.LineBasicMaterial({ transparent: true })
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), emat)
    mesh.add(edges)
    sheetGroup.add(mesh)
    slabs.push({ piece: q, mesh, edges, mat, emat })
  }
  update()
}

function buildCut() {
  disposeGroup(cutGroup)
  const r = result.value, m = model.value
  if (!r || !m) return
  const L = r.layers[sel.layer]
  if (!L) return
  const { min, max } = m.info.bbox
  const pad = 25
  const z = L.zs + view.explode * L.index
  const pg = new THREE.PlaneGeometry(max[0] - min[0] + 2 * pad, max[1] - min[1] + 2 * pad)
  const plane = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({
    color: colors['--plane'], transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide,
  }))
  plane.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, z)
  plane.renderOrder = 3
  const border = new THREE.LineSegments(new THREE.EdgesGeometry(pg), new THREE.LineBasicMaterial({ color: colors['--plane'], transparent: true, opacity: 0.5 }))
  plane.add(border)
  cutGroup.add(plane)
  // the cut contour, drawn over everything
  const pts: number[] = []
  for (const q of L.pieces) for (const ring of q.poly) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length]
      pts.push(a[0], a[1], z, b[0], b[1], z)
    }
  }
  const cg = new THREE.BufferGeometry()
  cg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  const contour = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: colors['--cut'], depthTest: false, transparent: true }))
  contour.renderOrder = 10
  cutGroup.add(contour)
  cutGroup.visible = view.sheets || view.ghost
}

/** Colours, fading and positions from the current selection. */
function update() {
  const r = result.value
  if (!r) return
  for (const s of slabs) {
    const q = s.piece
    const above = q.layer > sel.layer
    const isSel = sel.piece === q.id
    const isHov = hover.value === q.id
    const base = q.kind === 'loose' ? colors['--loose'] : q.kind === 'floating' ? colors['--float']
      : q.layer % 2 ? colors['--sheet-2'] : colors['--sheet']
    const c = base.clone()
    if (isHov) c.lerp(colors['--ink'], 0.18)
    s.mat.color.copy(c)
    s.mat.emissive.copy(isSel ? colors['--ink'] : new THREE.Color(0))
    s.mat.emissiveIntensity = isSel ? 0.25 : 0
    const faded = fadeAbove.value && above
    s.mat.opacity = faded ? 0.07 : 1
    s.mat.depthWrite = !faded
    s.mesh.renderOrder = faded ? 5 : 0
    s.emat.color.copy(q.layer === sel.layer ? colors['--cut'] : colors['--sheet-edge'])
    s.emat.opacity = faded ? 0.12 : q.layer === sel.layer ? 1 : 0.7
    s.mesh.position.z = r.layers[q.layer].zb + view.explode * q.layer
    s.mesh.visible = view.sheets
  }
  modelGroup.visible = view.ghost
  buildCut()
  render()
}

// ---- picking ---------------------------------------------------------------------

const ray = new THREE.Raycaster()
function pick(e: PointerEvent): string {
  if (!view.sheets) return ''
  const rect = renderer.domElement.getBoundingClientRect()
  const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
  ray.setFromCamera(p, camera)
  const targets = slabs.filter(s => s.mesh.visible && !(fadeAbove.value && s.piece.layer > sel.layer)).map(s => s.mesh)
  const hit = ray.intersectObjects(targets, false)[0]
  return hit ? hit.object.userData.piece as string : ''
}
let down: { x: number; y: number } | null = null
function onDown(e: PointerEvent) { down = { x: e.clientX, y: e.clientY } }
function onUp(e: PointerEvent) {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) selectPiece(pick(e))
  down = null
}
function onMove(e: PointerEvent) {
  if (e.buttons) return
  const id = pick(e)
  if (id !== hover.value) hover.value = id
  renderer.domElement.style.cursor = id ? 'pointer' : ''
}
function onLeave() { if (hover.value) hover.value = '' }

function resize() {
  const el = host.value!
  const w = el.clientWidth, h = el.clientHeight
  if (!w || !h) return
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  if (!fitted) fitCamera()
  render()
}

function onTheme() {
  readColors()
  scene.background = colors['--bg']
  const [mesh, lines] = modelGroup.children as [THREE.Mesh, THREE.LineSegments]
  if (mesh) (mesh.material as THREE.MeshStandardMaterial).color.copy(colors['--sheet'])
  if (lines) (lines.material as THREE.LineBasicMaterial).color.copy(colors['--ink-3'])
  update()
}

onMounted(() => {
  readColors()
  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  host.value!.prepend(renderer.domElement)
  scene = new THREE.Scene()
  scene.background = colors['--bg']
  camera = new THREE.PerspectiveCamera(35, 1, 1, 10000)
  camera.up.set(0, 0, 1)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.6))
  const sun = new THREE.DirectionalLight(0xffffff, 1.6)
  sun.position.set(0.4, -0.6, 1)
  scene.add(sun)
  scene.add(modelGroup, sheetGroup, cutGroup)
  controls = new OrbitControls(camera, renderer.domElement)
  controls.addEventListener('change', render)
  const el = renderer.domElement
  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerleave', onLeave)
  ro = new ResizeObserver(resize)
  ro.observe(host.value!)
  mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', onTheme)
  buildModel()
  buildSheets()
  resize()
})

onBeforeUnmount(() => {
  ro?.disconnect()
  mq?.removeEventListener('change', onTheme)
  controls?.dispose()
  disposeGroup(modelGroup); disposeGroup(sheetGroup); disposeGroup(cutGroup)
  renderer?.dispose()
  cancelAnimationFrame(frame)
})

watch(model, buildModel)
watch(result, buildSheets)
watch([() => sel.layer, () => sel.piece, hover, () => view.explode, () => view.ghost, () => view.sheets, fadeAbove], update)

function topView() {
  const m = model.value
  if (!m) return
  const { min, max } = m.info.bbox
  const size = Math.hypot(max[0] - min[0], max[1] - min[1])
  camera.position.set(controls.target.x, controls.target.y - 0.001, controls.target.z + size * 1.5)
  controls.update()
  render()
}
</script>

<template>
  <div ref="host" class="v3d">
    <div class="tools">
      <label><input type="checkbox" v-model="view.sheets" /> sheets</label>
      <label><input type="checkbox" v-model="view.ghost" /> model</label>
      <label title="Fade the sheets above the selected one"><input type="checkbox" v-model="fadeAbove" /> fade above</label>
      <label class="range">explode <input type="range" min="0" max="40" step="1" v-model.number="view.explode" /></label>
      <button class="ghost" @click="fitCamera" title="Reset the view">⟲</button>
      <button class="ghost" @click="topView" title="View from above">top</button>
    </div>
  </div>
</template>

<style scoped>
.v3d { height: 100%; min-height: 240px; position: relative; overflow: hidden; }
.v3d :deep(canvas) { width: 100% !important; height: 100% !important; display: block; touch-action: none; }
.tools {
  position: absolute; top: 8px; left: 8px; right: 8px;
  display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center;
  padding: 5px 10px; border-radius: 8px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  border: 1px solid var(--line);
  font-size: 12.5px; color: var(--ink-2);
  width: max-content; max-width: calc(100% - 16px);
}
.tools label { display: inline-flex; align-items: center; gap: 5px; }
.tools .range input { width: 90px; }
.tools .ghost { padding: 1px 8px; }
</style>
