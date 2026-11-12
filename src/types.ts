// SPDX-License-Identifier: GPL-3.0-only
// Data passed between the slicing worker and the page. Everything is in model
// coordinates (mm, x right, y up as seen from above); the export frame offset
// is applied only when files are written.

/** A ring vertex: the segment to the next vertex is a straight line for b = 0,
 *  otherwise an arc with bulge b = tan(sweep / 4), sweep > 0 counter-clockwise
 *  (the DXF convention). Rings are closed: the last vertex connects to the first. */
export type Vtx = [x: number, y: number, b: number]
export type Ring = Vtx[]
export type Pt = [x: number, y: number]
export type BBox = [x0: number, y0: number, x1: number, y1: number]

export interface SliceParams {
  thicknesses: number[]   // foam at hand
  stack: number[]         // thickness of each sheet, bottom up (empty: all the first thickness)
  maxOutline: number      // allowed wall movement within one sheet: outer outline
  maxPockets: number      //   and pockets / islands
  z0: number              // bottom of sheet 1
  at: number              // section height within a sheet, 0 bottom .. 1 top
  margin: number          // border around the part in exported files
  labels: boolean         // engrave piece ids
  marks: boolean          // engrave where loose pieces of the next sheet go
  labelHeight: number
  tolerance: number       // chord error for curves that are not arcs
}

export const DEFAULT_PARAMS: SliceParams = {
  thicknesses: [10],
  stack: [],
  maxOutline: 2,
  maxPockets: 0.5,
  z0: 0,
  at: 0,
  margin: 5,
  labels: true,
  marks: true,
  labelHeight: 5,
  tolerance: 0.01,
}

export interface Label { x: number; y: number; h: number; text: string }

export type PieceKind =
  | 'main'        // the largest piece of its sheet
  | 'loose'       // a separate piece of the same sheet; must be placed by hand
  | 'floating'    // nothing below it to rest on

export interface Piece {
  id: string              // L03, L03-a, ...
  layer: number           // 0-based sheet index
  rings: Ring[]           // outer ring first, then the pockets
  poly: Pt[][]            // the rings as polygons (arcs split), same order
  area: number
  bbox: BBox
  kind: PieceKind
  /** Area resting on the sheet below, and on which pieces. */
  support: number
  below: string[]
  above: string[]
  component: number       // pieces glued together through the stack share a number
  label?: Label           // engraved on its top face
}

export interface Mark {
  piece: string           // the loose piece of the next sheet up
  rings: Ring[]           // its outline, engraved on this sheet's top face
  label?: Label
}

export interface Layer {
  index: number
  name: string            // L01
  zb: number              // bottom
  zt: number              // top
  zs: number              // where the section was taken
  pieces: Piece[]
  marks: Mark[]
  outlineBot: [number, number]
  outlineTop: [number, number]
  pockets: number
}

export interface Warning {
  level: 'warn' | 'info'
  layer?: number
  piece?: string
  text: string
}

export interface SliceResult {
  params: SliceParams
  bbox: { min: [number, number, number]; max: [number, number, number] }
  /** Export frame: model bbox + margin; file coords = model coords + (dx, dy). */
  frame: { dx: number; dy: number; w: number; h: number }
  layers: Layer[]
  components: number
  warnings: Warning[]
  ms: number
}

/** How the model changes with height, sampled on a grid of `step` from z0:
 *  cell i is z0 + i*step .. z0 + (i+1)*step, sampled just above its bottom and
 *  just below its top. spread[i][k-1] is how far the walls move within a sheet
 *  covering cells i .. i+k-1 (the largest distance between any two samples),
 *  for the outer outline and for the pockets. Infinity: the shape changes
 *  (something appears or disappears). */
export interface Profile {
  z0: number
  step: number
  n: number               // cells
  kmax: number
  outline: number[][]     // spread[i][k-1]
  pockets: number[][]
  /** Movement across each cell boundary i (top of cell i-1 to bottom of cell i), i = 1..n-1. */
  stepOutline: number[]
  stepPockets: number[]
  ms: number
}

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  index: Uint32Array
  edges: Float32Array     // line segment pairs of the model's edges
}

export interface ModelInfo {
  name: string
  solids: number
  bbox: { min: [number, number, number]; max: [number, number, number] }
  volume: number
  floors: number[]        // heights of horizontal faces (pocket floors, steps)
}

export interface LoadedModel { choice: string; info: ModelInfo; mesh: MeshData }

/** A selectable shape inside a file (FCStd documents may hold several). */
export interface ModelChoice { id: string; label: string; type: string }

// ---- worker protocol ---------------------------------------------------------

export type Request =
  | { id: number; op: 'open'; name: string; data: ArrayBuffer }
  | { id: number; op: 'choose'; choice: string }
  | { id: number; op: 'profile'; z0: number; step: number; kmax: number }
  | { id: number; op: 'slice'; params: SliceParams }

export type Response =
  /** model is set when the file holds one shape (or after 'choose'). */
  | { id: number; ok: true; op: 'open'; choices: ModelChoice[]; model?: LoadedModel }
  | { id: number; ok: true; op: 'choose'; model: LoadedModel }
  | { id: number; ok: true; op: 'profile'; profile: Profile }
  | { id: number; ok: true; op: 'slice'; result: SliceResult }
  | { id: number; ok: false; error: string }
  | { id: -1; ok: true; op: 'progress'; text: string; frac: number }
