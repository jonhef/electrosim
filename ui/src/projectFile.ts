import type { ScaleMode } from "./render"
import type { Scene } from "./types"

export const PROJECT_FILE_KIND = "electrostatic-sim/project"
export const PROJECT_FILE_VERSION = 1

export const PROJECT_LIMITS = {
  grid: { min: 32, max: 1024 },
  maxIters: { min: 1, max: 50000 },
  omega: { min: 0.1, max: 1.99 },
  sigmaCells: { min: 0.25, max: 6 },
  fieldStride: { min: 2, max: 64 },
  equipCount: { min: 0, max: 24 },
  clipPercentile: { min: 0, max: 20 },
  shadingStrength: { min: 0, max: 1 },
  zoom: { min: 1, max: 250 },
  exportResolution: { min: 128, max: 8192 }
} as const

export type ProjectSettings = {
  grid: { nx: number; ny: number }
  solver: { maxIters: number; tolerance: number; omega: number; chargeSigmaCells: number }
  render: {
    showField: boolean
    fieldStride: number
    equipCount: number
    scaleMode: ScaleMode
    clipPercentile: number
    showLegend: boolean
    showShading: boolean
    shadingStrength: number
    debugAxes: boolean
  }
  view: { centerX: number; centerY: number; zoom: number }
  ui: {
    mode: "move" | "probe"
    selectedChargeIndex: number
    selectedConductorIndex: number
  }
  exportImage: { width: number; height: number }
}

export type ProjectSolutionSnapshot = {
  nx: number
  ny: number
  phiMin: number
  phiMax: number
  iterations: number
  residual: number
  phiHash: string
}

export type ProjectFile = {
  kind: typeof PROJECT_FILE_KIND
  version: typeof PROJECT_FILE_VERSION
  savedAt: string
  scene: Scene
  settings: ProjectSettings
  solution?: ProjectSolutionSnapshot
}

type ParseOk = { ok: true; value: ProjectFile }
type ParseErr = { ok: false; error: string }
export type ParseProjectFileResult = ParseOk | ParseErr

export function parseProjectFile(raw: unknown): ParseProjectFileResult {
  try {
    return { ok: true, value: decodeProjectFile(raw) }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}

export function hashPhiArray(phi: Float32Array): string {
  let h = 0x811c9dc5
  const scratch = new ArrayBuffer(4)
  const view = new DataView(scratch)

  h = fnv1aByte(h, phi.length & 0xff)
  h = fnv1aByte(h, (phi.length >>> 8) & 0xff)
  h = fnv1aByte(h, (phi.length >>> 16) & 0xff)
  h = fnv1aByte(h, (phi.length >>> 24) & 0xff)

  for (let i = 0; i < phi.length; i++) {
    view.setFloat32(0, phi[i], true)
    const bits = view.getUint32(0, true)
    h = fnv1aByte(h, bits & 0xff)
    h = fnv1aByte(h, (bits >>> 8) & 0xff)
    h = fnv1aByte(h, (bits >>> 16) & 0xff)
    h = fnv1aByte(h, (bits >>> 24) & 0xff)
  }

  return h.toString(16).padStart(8, "0")
}

function fnv1aByte(h: number, b: number) {
  return Math.imul((h ^ b) >>> 0, 0x01000193) >>> 0
}

function decodeProjectFile(raw: unknown): ProjectFile {
  const root = asRecord(raw, "project")

  const kind = asString(root.kind, "kind")
  if (kind !== PROJECT_FILE_KIND) {
    throw new Error(`unsupported project kind: expected "${PROJECT_FILE_KIND}"`)
  }

  const version = asInteger(root.version, "version")
  if (version !== PROJECT_FILE_VERSION) {
    throw new Error(`unsupported project version: ${version}`)
  }

  const savedAt = asString(root.savedAt, "savedAt")
  if (!isIsoDate(savedAt)) {
    throw new Error("savedAt must be an ISO datetime string")
  }

  const scene = decodeScene(root.scene)
  const settings = decodeSettings(root.settings)
  const solution = root.solution == null ? undefined : decodeSolution(root.solution)

  return {
    kind: PROJECT_FILE_KIND,
    version: PROJECT_FILE_VERSION,
    savedAt,
    scene,
    settings,
    solution
  }
}

function decodeScene(raw: unknown): Scene {
  const scene = asRecord(raw, "scene")
  const domain = asRecord(scene.domain, "scene.domain")
  const chargesRaw = asArray(scene.charges, "scene.charges")
  const conductorsRaw = asArray(scene.conductors, "scene.conductors")

  const xMin = asFiniteNumber(domain.xMin, "scene.domain.xMin")
  const xMax = asFiniteNumber(domain.xMax, "scene.domain.xMax")
  const yMin = asFiniteNumber(domain.yMin, "scene.domain.yMin")
  const yMax = asFiniteNumber(domain.yMax, "scene.domain.yMax")
  if (!(xMax > xMin)) throw new Error("scene.domain.xMax must be > xMin")
  if (!(yMax > yMin)) throw new Error("scene.domain.yMax must be > yMin")
  const epsilon = asFiniteNumber(domain.epsilon, "scene.domain.epsilon")
  if (!(epsilon > 0)) throw new Error("scene.domain.epsilon must be > 0")

  const charges = chargesRaw.map((item, i) => {
    const c = asRecord(item, `scene.charges[${i}]`)
    return {
      x: asFiniteNumber(c.x, `scene.charges[${i}].x`),
      y: asFiniteNumber(c.y, `scene.charges[${i}].y`),
      q: asFiniteNumber(c.q, `scene.charges[${i}].q`)
    }
  })

  const conductors = conductorsRaw.map((item, i) => {
    const c = asRecord(item, `scene.conductors[${i}]`)
    const kind = asString(c.kind, `scene.conductors[${i}].kind`)
    const potential = asFiniteNumber(c.potential, `scene.conductors[${i}].potential`)
    if (kind === "rectangle") {
      const rxMin = asFiniteNumber(c.xMin, `scene.conductors[${i}].xMin`)
      const rxMax = asFiniteNumber(c.xMax, `scene.conductors[${i}].xMax`)
      const ryMin = asFiniteNumber(c.yMin, `scene.conductors[${i}].yMin`)
      const ryMax = asFiniteNumber(c.yMax, `scene.conductors[${i}].yMax`)
      if (!(rxMax > rxMin && ryMax > ryMin)) {
        throw new Error(`scene.conductors[${i}] rectangle bounds must satisfy xMax>xMin and yMax>yMin`)
      }
      return { kind, potential, xMin: rxMin, xMax: rxMax, yMin: ryMin, yMax: ryMax } as const
    }

    if (kind === "circle") {
      const x = asFiniteNumber(c.x, `scene.conductors[${i}].x`)
      const y = asFiniteNumber(c.y, `scene.conductors[${i}].y`)
      const radius = asFiniteNumber(c.radius, `scene.conductors[${i}].radius`)
      if (!(radius > 0)) throw new Error(`scene.conductors[${i}].radius must be > 0`)
      return { kind, potential, x, y, radius } as const
    }

    throw new Error(`scene.conductors[${i}].kind must be "rectangle" or "circle"`)
  })

  return { domain: { xMin, xMax, yMin, yMax, epsilon }, charges, conductors }
}

function decodeSettings(raw: unknown): ProjectSettings {
  const settings = asRecord(raw, "settings")
  const grid = asRecord(settings.grid, "settings.grid")
  const solver = asRecord(settings.solver, "settings.solver")
  const render = asRecord(settings.render, "settings.render")
  const view = asRecord(settings.view, "settings.view")
  const ui = asRecord(settings.ui, "settings.ui")
  const exportImage = asRecord(settings.exportImage, "settings.exportImage")

  const nx = asIntegerInRange(grid.nx, "settings.grid.nx", PROJECT_LIMITS.grid.min, PROJECT_LIMITS.grid.max)
  const ny = asIntegerInRange(grid.ny, "settings.grid.ny", PROJECT_LIMITS.grid.min, PROJECT_LIMITS.grid.max)

  const maxIters = asIntegerInRange(solver.maxIters, "settings.solver.maxIters", PROJECT_LIMITS.maxIters.min, PROJECT_LIMITS.maxIters.max)
  const tolerance = asFiniteNumber(solver.tolerance, "settings.solver.tolerance")
  if (!(tolerance > 0)) throw new Error("settings.solver.tolerance must be > 0")
  const omega = asFiniteNumberInRange(solver.omega, "settings.solver.omega", PROJECT_LIMITS.omega.min, PROJECT_LIMITS.omega.max)
  const chargeSigmaCells = asFiniteNumberInRange(
    solver.chargeSigmaCells,
    "settings.solver.chargeSigmaCells",
    PROJECT_LIMITS.sigmaCells.min,
    PROJECT_LIMITS.sigmaCells.max
  )

  const showField = asBoolean(render.showField, "settings.render.showField")
  const fieldStride = asIntegerInRange(
    render.fieldStride,
    "settings.render.fieldStride",
    PROJECT_LIMITS.fieldStride.min,
    PROJECT_LIMITS.fieldStride.max
  )
  const equipCount = asIntegerInRange(
    render.equipCount,
    "settings.render.equipCount",
    PROJECT_LIMITS.equipCount.min,
    PROJECT_LIMITS.equipCount.max
  )
  const scaleMode = asScaleMode(render.scaleMode, "settings.render.scaleMode")
  const clipPercentile = asFiniteNumberInRange(
    render.clipPercentile,
    "settings.render.clipPercentile",
    PROJECT_LIMITS.clipPercentile.min,
    PROJECT_LIMITS.clipPercentile.max
  )
  const showLegend = asBoolean(render.showLegend, "settings.render.showLegend")
  const showShading = asBoolean(render.showShading, "settings.render.showShading")
  const shadingStrength = asFiniteNumberInRange(
    render.shadingStrength,
    "settings.render.shadingStrength",
    PROJECT_LIMITS.shadingStrength.min,
    PROJECT_LIMITS.shadingStrength.max
  )
  const debugAxes = asBoolean(render.debugAxes, "settings.render.debugAxes")

  const centerX = asFiniteNumber(view.centerX, "settings.view.centerX")
  const centerY = asFiniteNumber(view.centerY, "settings.view.centerY")
  const zoom = asFiniteNumberInRange(view.zoom, "settings.view.zoom", PROJECT_LIMITS.zoom.min, PROJECT_LIMITS.zoom.max)

  const mode = asMode(ui.mode, "settings.ui.mode")
  const selectedChargeIndex = asIntegerInRange(
    ui.selectedChargeIndex,
    "settings.ui.selectedChargeIndex",
    0,
    Number.MAX_SAFE_INTEGER
  )
  const selectedConductorIndex = asIntegerInRange(
    ui.selectedConductorIndex,
    "settings.ui.selectedConductorIndex",
    0,
    Number.MAX_SAFE_INTEGER
  )

  const width = asIntegerInRange(
    exportImage.width,
    "settings.exportImage.width",
    PROJECT_LIMITS.exportResolution.min,
    PROJECT_LIMITS.exportResolution.max
  )
  const height = asIntegerInRange(
    exportImage.height,
    "settings.exportImage.height",
    PROJECT_LIMITS.exportResolution.min,
    PROJECT_LIMITS.exportResolution.max
  )

  return {
    grid: { nx, ny },
    solver: { maxIters, tolerance, omega, chargeSigmaCells },
    render: {
      showField,
      fieldStride,
      equipCount,
      scaleMode,
      clipPercentile,
      showLegend,
      showShading,
      shadingStrength,
      debugAxes
    },
    view: { centerX, centerY, zoom },
    ui: { mode, selectedChargeIndex, selectedConductorIndex },
    exportImage: { width, height }
  }
}

function decodeSolution(raw: unknown): ProjectSolutionSnapshot {
  const solution = asRecord(raw, "solution")
  const nx = asIntegerInRange(solution.nx, "solution.nx", PROJECT_LIMITS.grid.min, PROJECT_LIMITS.grid.max)
  const ny = asIntegerInRange(solution.ny, "solution.ny", PROJECT_LIMITS.grid.min, PROJECT_LIMITS.grid.max)
  const phiMin = asFiniteNumber(solution.phiMin, "solution.phiMin")
  const phiMax = asFiniteNumber(solution.phiMax, "solution.phiMax")
  const iterations = asIntegerInRange(solution.iterations, "solution.iterations", 0, Number.MAX_SAFE_INTEGER)
  const residual = asFiniteNumber(solution.residual, "solution.residual")
  const phiHash = asString(solution.phiHash, "solution.phiHash")
  if (!/^[0-9a-f]{8}$/i.test(phiHash)) {
    throw new Error("solution.phiHash must be 8 hex characters")
  }
  return { nx, ny, phiMin, phiMax, iterations, residual, phiHash: phiHash.toLowerCase() }
}

function asRecord(raw: unknown, path: string): Record<string, unknown> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path} must be an object`)
  }
  return raw as Record<string, unknown>
}

function asArray(raw: unknown, path: string): unknown[] {
  if (!Array.isArray(raw)) throw new Error(`${path} must be an array`)
  return raw
}

function asString(raw: unknown, path: string): string {
  if (typeof raw !== "string") throw new Error(`${path} must be a string`)
  return raw
}

function asBoolean(raw: unknown, path: string): boolean {
  if (typeof raw !== "boolean") throw new Error(`${path} must be a boolean`)
  return raw
}

function asFiniteNumber(raw: unknown, path: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error(`${path} must be a finite number`)
  return raw
}

function asInteger(raw: unknown, path: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) throw new Error(`${path} must be an integer`)
  return raw
}

function asIntegerInRange(raw: unknown, path: string, min: number, max: number): number {
  const v = asInteger(raw, path)
  if (v < min || v > max) throw new Error(`${path} must be in range ${min}..${max}`)
  return v
}

function asFiniteNumberInRange(raw: unknown, path: string, min: number, max: number): number {
  const v = asFiniteNumber(raw, path)
  if (v < min || v > max) throw new Error(`${path} must be in range ${min}..${max}`)
  return v
}

function asScaleMode(raw: unknown, path: string): ScaleMode {
  const mode = asString(raw, path)
  if (mode !== "linear" && mode !== "symmetric" && mode !== "log") {
    throw new Error(`${path} must be "linear", "symmetric", or "log"`)
  }
  return mode
}

function asMode(raw: unknown, path: string): "move" | "probe" {
  const mode = asString(raw, path)
  if (mode !== "move" && mode !== "probe") {
    throw new Error(`${path} must be "move" or "probe"`)
  }
  return mode
}

function isIsoDate(raw: string): boolean {
  const t = Date.parse(raw)
  return Number.isFinite(t)
}
