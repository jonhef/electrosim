import React, { useCallback, useEffect, useRef, useState } from "react"
import type { Conductor, PointCharge, Scene, SolveMeta, PhiField, Probe } from "./types"
import { solve, fetchPhi } from "./api"
import {
  PROJECT_FILE_KIND,
  PROJECT_FILE_VERSION,
  PROJECT_LIMITS,
  hashPhiArray,
  parseProjectFile,
  type ProjectFile,
  type ProjectSolutionSnapshot
} from "./projectFile"
import {
  getDomainViewport,
  renderFieldToCanvas,
  screenToWorld,
  worldToScreen,
  type DomainBounds,
  type ScaleMode
} from "./render"

const defaultScene: Scene = {
  domain: { xMin: -1, xMax: 1, yMin: -1, yMax: 1, epsilon: 1 },
  charges: [
    { x: -0.35, y: 0.0, q: +1.0 },
    { x: +0.35, y: 0.0, q: -1.0 }
  ],
  conductors: []
}

type ViewState = { centerX: number; centerY: number; zoom: number }
type DragMode = "none" | "pan" | "charge" | "conductorMove" | "conductorResize"
type ResizeHandle = "rect-sw" | "rect-se" | "rect-nw" | "rect-ne" | "circle-radius"
type DragState = {
  mode: DragMode
  chargeIndex: number
  conductorIndex: number
  resizeHandle: ResizeHandle | null
  lastClientX: number
  lastClientY: number
  moved: boolean
}

const MAX_ZOOM = 250
const CHARGE_HIT_RADIUS_CSS_PX = 14
const CONDUCTOR_HANDLE_HIT_RADIUS_CSS_PX = 12
const MIN_EXPORT_RES = PROJECT_LIMITS.exportResolution.min
const MAX_EXPORT_RES = PROJECT_LIMITS.exportResolution.max

function clamp(x: number, lo: number, hi: number) {
  return x < lo ? lo : x > hi ? hi : x
}

function makeDefaultView(domain: DomainBounds): ViewState {
  return {
    centerX: 0.5 * (domain.xMin + domain.xMax),
    centerY: 0.5 * (domain.yMin + domain.yMax),
    zoom: 1
  }
}

function clampView(view: ViewState, domain: DomainBounds): ViewState {
  const zoom = clamp(view.zoom, 1, MAX_ZOOM)
  const domainW = domain.xMax - domain.xMin
  const domainH = domain.yMax - domain.yMin
  const viewW = domainW / zoom
  const viewH = domainH / zoom

  return {
    zoom,
    centerX: clamp(view.centerX, domain.xMin + 0.5 * viewW, domain.xMax - 0.5 * viewW),
    centerY: clamp(view.centerY, domain.yMin + 0.5 * viewH, domain.yMax - 0.5 * viewH)
  }
}

function viewBoundsFrom(view: ViewState, domain: DomainBounds): DomainBounds {
  const clamped = clampView(view, domain)
  const domainW = domain.xMax - domain.xMin
  const domainH = domain.yMax - domain.yMin
  const viewW = domainW / clamped.zoom
  const viewH = domainH / clamped.zoom

  return {
    xMin: clamped.centerX - 0.5 * viewW,
    xMax: clamped.centerX + 0.5 * viewW,
    yMin: clamped.centerY - 0.5 * viewH,
    yMax: clamped.centerY + 0.5 * viewH
  }
}

function parseFinite(raw: string): number | null {
  const v = Number(raw.trim())
  return Number.isFinite(v) ? v : null
}

function parseIntInRange(raw: string, min: number, max: number): number | null {
  const v = parseFinite(raw)
  if (v == null || !Number.isInteger(v) || v < min || v > max) return null
  return v
}

function parseFloatInRange(raw: string, min: number, max: number): number | null {
  const v = parseFinite(raw)
  if (v == null || v < min || v > max) return null
  return v
}

type SolveParams = {
  nx: number
  ny: number
  maxIters: number
  tol: number
  omega: number
  sigmaCells: number
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const projectFileInputRef = useRef<HTMLInputElement | null>(null)
  const dragRef = useRef<DragState>({
    mode: "none",
    chargeIndex: -1,
    conductorIndex: -1,
    resizeHandle: null,
    lastClientX: 0,
    lastClientY: 0,
    moved: false
  })

  const [scene, setScene] = useState<Scene>(defaultScene)

  const [nx, setNx] = useState(256)
  const [ny, setNy] = useState(256)
  const [maxIters, setMaxIters] = useState(800)
  const [tol, setTol] = useState(1e-4)
  const [omega, setOmega] = useState(1.85)
  const [sigmaCells, setSigmaCells] = useState(1.25)

  const [nxInput, setNxInput] = useState("256")
  const [nyInput, setNyInput] = useState("256")
  const [maxItersInput, setMaxItersInput] = useState("800")
  const [tolInput, setTolInput] = useState("1e-4")
  const [omegaInput, setOmegaInput] = useState("1.85")
  const [sigmaCellsInput, setSigmaCellsInput] = useState("1.25")

  const [phiField, setPhiField] = useState<PhiField | null>(null)
  const [meta, setMeta] = useState<SolveMeta | null>(null)
  const [status, setStatus] = useState<string>("idle")
  const [inputError, setInputError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number>(0)
  const [selectedConductor, setSelectedConductor] = useState<number>(0)
  const [mode, setMode] = useState<"move" | "probe">("move")
  const [probe, setProbe] = useState<Probe | null>(null)

  const [showField, setShowField] = useState(true)
  const [fieldStride, setFieldStride] = useState(12)
  const [fieldStrideInput, setFieldStrideInput] = useState("12")

  const [equipCount, setEquipCount] = useState(8)
  const [equipCountInput, setEquipCountInput] = useState("8")

  const [scaleMode, setScaleMode] = useState<ScaleMode>("symmetric")
  const [clipPercentile, setClipPercentile] = useState(1)
  const [clipPercentileInput, setClipPercentileInput] = useState("1")

  const [showLegend, setShowLegend] = useState(true)
  const [showShading, setShowShading] = useState(false)
  const [shadingStrength, setShadingStrength] = useState(0.35)
  const [debugAxes, setDebugAxes] = useState(false)
  const [exportWidthInput, setExportWidthInput] = useState("1920")
  const [exportHeightInput, setExportHeightInput] = useState("1080")

  const [viewState, setViewState] = useState<ViewState>(() => makeDefaultView(defaultScene.domain))
  const [selectedQInput, setSelectedQInput] = useState(defaultScene.charges[0]?.q.toString() ?? "")

  const selectedCharge: PointCharge | null = scene.charges[selected] ?? null
  const selectedCond: Conductor | null = scene.conductors[selectedConductor] ?? null
  const currentDomain: DomainBounds = phiField ?? scene.domain

  useEffect(() => {
    const q = scene.charges[selected]?.q
    setSelectedQInput(q == null ? "" : String(q))
  }, [scene.charges, selected])

  useEffect(() => {
    setSelectedConductor(i => clamp(i, 0, Math.max(0, scene.conductors.length - 1)))
  }, [scene.conductors.length])

  useEffect(() => {
    setViewState(v => clampView(v, currentDomain))
  }, [currentDomain.xMin, currentDomain.xMax, currentDomain.yMin, currentDomain.yMax])

  const renderCurrent = useCallback((nextField?: PhiField | null) => {
    const c = canvasRef.current
    const field = nextField ?? phiField
    if (!c || !field) return

    const bounds = viewBoundsFrom(viewState, field)
    renderFieldToCanvas(c, field, {
      showField,
      fieldStride,
      showEquip: equipCount > 0,
      equipCount: Math.max(0, equipCount),
      scaleMode,
      clipPercentile,
      showLegend,
      units: "arb.",
      showShading,
      shadingStrength,
      debugAxes,
      viewBounds: bounds,
      probe,
      charges: scene.charges,
      conductors: scene.conductors,
      selectedConductorIndex: selectedConductor
    })
  }, [
    phiField,
    viewState,
    showField,
    fieldStride,
    equipCount,
    scaleMode,
    clipPercentile,
    showLegend,
    showShading,
    shadingStrength,
    debugAxes,
    probe,
    scene.charges,
    scene.conductors,
    selectedConductor
  ])

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return

    const resize = () => {
      const cssWidth = Math.max(360, Math.min(window.innerWidth - 340, 980))
      const cssHeight = Math.max(360, Math.min(window.innerHeight - 50, 980))
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      c.style.width = `${cssWidth}px`
      c.style.height = `${cssHeight}px`
      c.width = Math.max(1, Math.round(cssWidth * dpr))
      c.height = Math.max(1, Math.round(cssHeight * dpr))
      renderCurrent()
    }

    resize()
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [renderCurrent])

  useEffect(() => {
    renderCurrent()
  }, [renderCurrent])

  const zoomAt = useCallback((clientX: number, clientY: number, deltaY: number) => {
    const c = canvasRef.current
    const p = clientToCanvas(clientX, clientY)
    if (!c || !p) return

    const domain = currentDomain
    setViewState(prev => {
      const prevClamped = clampView(prev, domain)
      const prevBounds = viewBoundsFrom(prevClamped, domain)
      const worldBefore = screenToWorld(c, domain, p.sx, p.sy, prevBounds)
      if (!worldBefore) return prevClamped

      const zoomMul = Math.exp(-deltaY * 0.0015)
      let next = clampView({ ...prevClamped, zoom: prevClamped.zoom * zoomMul }, domain)
      const nextBounds = viewBoundsFrom(next, domain)
      const worldAfter = screenToWorld(c, domain, p.sx, p.sy, nextBounds)
      if (!worldAfter) return next

      next = clampView({
        ...next,
        centerX: next.centerX + (worldBefore.x - worldAfter.x),
        centerY: next.centerY + (worldBefore.y - worldAfter.y)
      }, domain)
      return next
    })
  }, [currentDomain])

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return

    const onWheelNative = (ev: WheelEvent) => {
      ev.preventDefault()
      ev.stopPropagation()
      zoomAt(ev.clientX, ev.clientY, ev.deltaY)
    }

    c.addEventListener("wheel", onWheelNative, { passive: false })
    return () => c.removeEventListener("wheel", onWheelNative)
  }, [zoomAt])

  function commitSelectedChargeQ(raw: string) {
    setSelectedQInput(raw)
    const q = parseFinite(raw)
    if (q == null) return
    setScene(s => {
      if (s.charges.length === 0) return s
      const idx = clamp(selected, 0, s.charges.length - 1)
      const ch = [...s.charges]
      ch[idx] = { ...ch[idx], q }
      return { ...s, charges: ch }
    })
  }

  function applyTextDraft(raw: string, setRaw: (x: string) => void, setter: (x: number) => void, parsed: number | null) {
    setRaw(raw)
    if (parsed != null) setter(parsed)
  }

  function validateInputsForSolve():
    | {
      ok: true
      values: SolveParams & {
        fieldStride: number
        equipCount: number
        clipPercentile: number
        selectedQ: number | null
      }
    }
    | { ok: false; message: string } {
    const nxV = parseIntInRange(nxInput, PROJECT_LIMITS.grid.min, PROJECT_LIMITS.grid.max)
    if (nxV == null) return { ok: false, message: `invalid nx (expected integer ${PROJECT_LIMITS.grid.min}..${PROJECT_LIMITS.grid.max})` }

    const nyV = parseIntInRange(nyInput, PROJECT_LIMITS.grid.min, PROJECT_LIMITS.grid.max)
    if (nyV == null) return { ok: false, message: `invalid ny (expected integer ${PROJECT_LIMITS.grid.min}..${PROJECT_LIMITS.grid.max})` }

    const maxItersV = parseIntInRange(maxItersInput, PROJECT_LIMITS.maxIters.min, PROJECT_LIMITS.maxIters.max)
    if (maxItersV == null) return { ok: false, message: `invalid max iters (expected integer ${PROJECT_LIMITS.maxIters.min}..${PROJECT_LIMITS.maxIters.max})` }

    const tolV = parseFinite(tolInput)
    if (tolV == null || tolV <= 0) return { ok: false, message: "invalid tolerance (expected positive number)" }

    const omegaV = parseFloatInRange(omegaInput, PROJECT_LIMITS.omega.min, PROJECT_LIMITS.omega.max)
    if (omegaV == null) return { ok: false, message: `invalid omega (expected number ${PROJECT_LIMITS.omega.min}..${PROJECT_LIMITS.omega.max})` }

    const sigmaV = parseFloatInRange(sigmaCellsInput, PROJECT_LIMITS.sigmaCells.min, PROJECT_LIMITS.sigmaCells.max)
    if (sigmaV == null) return { ok: false, message: `invalid charge sigma (expected number ${PROJECT_LIMITS.sigmaCells.min}..${PROJECT_LIMITS.sigmaCells.max})` }

    const strideV = parseIntInRange(fieldStrideInput, PROJECT_LIMITS.fieldStride.min, PROJECT_LIMITS.fieldStride.max)
    if (strideV == null) {
      return {
        ok: false,
        message: `invalid arrow stride (expected integer ${PROJECT_LIMITS.fieldStride.min}..${PROJECT_LIMITS.fieldStride.max})`
      }
    }

    const equipV = parseIntInRange(equipCountInput, PROJECT_LIMITS.equipCount.min, PROJECT_LIMITS.equipCount.max)
    if (equipV == null) {
      return {
        ok: false,
        message: `invalid equipotential count (expected integer ${PROJECT_LIMITS.equipCount.min}..${PROJECT_LIMITS.equipCount.max})`
      }
    }

    const clipV = parseFloatInRange(
      clipPercentileInput,
      PROJECT_LIMITS.clipPercentile.min,
      PROJECT_LIMITS.clipPercentile.max
    )
    if (clipV == null) {
      return {
        ok: false,
        message: `invalid percentile clip (expected number ${PROJECT_LIMITS.clipPercentile.min}..${PROJECT_LIMITS.clipPercentile.max})`
      }
    }

    for (let i = 0; i < scene.conductors.length; i++) {
      const c = scene.conductors[i]
      if (!Number.isFinite(c.potential)) return { ok: false, message: `invalid conductor #${i} potential` }
      if (c.kind === "rectangle") {
        if (
          !Number.isFinite(c.xMin) || !Number.isFinite(c.xMax) ||
          !Number.isFinite(c.yMin) || !Number.isFinite(c.yMax)
        ) return { ok: false, message: `invalid rectangle conductor #${i} bounds` }
        if (!(c.xMax > c.xMin && c.yMax > c.yMin)) {
          return { ok: false, message: `rectangle conductor #${i}: require xMax>xMin and yMax>yMin` }
        }
      } else if (c.kind === "circle") {
        if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.radius)) {
          return { ok: false, message: `invalid circle conductor #${i} params` }
        }
        if (!(c.radius > 0)) return { ok: false, message: `circle conductor #${i}: radius must be > 0` }
      } else {
        return { ok: false, message: `unsupported conductor kind on #${i}` }
      }
    }

    if (selectedCharge) {
      const qV = parseFinite(selectedQInput)
      if (qV == null) return { ok: false, message: "invalid selected charge q (expected finite number)" }
    }

    const qV = selectedCharge ? Number(selectedQInput) : null
    return {
      ok: true,
      values: {
        nx: nxV,
        ny: nyV,
        maxIters: maxItersV,
        tol: tolV,
        omega: omegaV,
        sigmaCells: sigmaV,
        fieldStride: strideV,
        equipCount: equipV,
        clipPercentile: clipV,
        selectedQ: qV
      }
    }
  }

  async function solveSceneAndStore(sceneForSolve: Scene, params: SolveParams): Promise<PhiField> {
    setStatus("solving")
    setProbe(null)

    const m = await solve(
      sceneForSolve,
      { nx: params.nx, ny: params.ny },
      {
        maxIters: params.maxIters,
        tolerance: params.tol,
        omega: params.omega,
        chargeSigmaCells: params.sigmaCells
      }
    )
    setMeta(m)

    const buf = await fetchPhi(m.resultId)
    const phi = new Float32Array(buf)
    const field: PhiField = { ...m, phi }
    setPhiField(field)
    renderCurrent(field)
    return field
  }

  async function runSolve() {
    const valid = validateInputsForSolve()
    if (!valid.ok) {
      setInputError(valid.message)
      setStatus(`input error: ${valid.message}`)
      return
    }

    setInputError(null)
    const v = valid.values
    setNx(v.nx)
    setNy(v.ny)
    setMaxIters(v.maxIters)
    setTol(v.tol)
    setOmega(v.omega)
    setSigmaCells(v.sigmaCells)
    setFieldStride(v.fieldStride)
    setEquipCount(v.equipCount)
    setClipPercentile(v.clipPercentile)

    try {
      const sceneForSolve: Scene = selectedCharge && v.selectedQ != null
        ? {
            ...scene,
            charges: scene.charges.map((c, i) => (i === selected ? { ...c, q: v.selectedQ as number } : c))
          }
        : scene

      if (selectedCharge && v.selectedQ != null) {
        setScene(sceneForSolve)
      }

      const field = await solveSceneAndStore(sceneForSolve, v)
      setStatus(`done (iters=${field.iterations}, residual=${field.residual.toExponential(2)})`)
    } catch (e: any) {
      setStatus(`error: ${e?.message ?? String(e)}`)
    }
  }

  function clientToCanvas(clientX: number, clientY: number) {
    const c = canvasRef.current
    if (!c) return null
    const r = c.getBoundingClientRect()
    const scaleX = c.width / Math.max(1e-12, r.width)
    const scaleY = c.height / Math.max(1e-12, r.height)
    return {
      sx: (clientX - r.left) * scaleX,
      sy: (clientY - r.top) * scaleY,
      scaleX,
      scaleY
    }
  }

  function clientToWorld(clientX: number, clientY: number, domain: DomainBounds, bounds: DomainBounds) {
    const p = clientToCanvas(clientX, clientY)
    if (!p) return null
    const c = canvasRef.current
    if (!c) return null
    return screenToWorld(c, domain, p.sx, p.sy, bounds)
  }

  function hitTestCharge(clientX: number, clientY: number, domain: DomainBounds, bounds: DomainBounds): number {
    const c = canvasRef.current
    const p = clientToCanvas(clientX, clientY)
    if (!c || !p) return -1

    const threshold = CHARGE_HIT_RADIUS_CSS_PX * p.scaleX
    const t2 = threshold * threshold
    let best = -1
    let bestDist = Number.POSITIVE_INFINITY

    for (let i = 0; i < scene.charges.length; i++) {
      const ch = scene.charges[i]
      const s = worldToScreen(c, domain, ch.x, ch.y, bounds)
      const dx = s.x - p.sx
      const dy = s.y - p.sy
      const d2 = dx * dx + dy * dy
      if (d2 <= t2 && d2 < bestDist) {
        best = i
        bestDist = d2
      }
    }

    return best
  }

  function hitTestSelectedConductorHandle(
    clientX: number,
    clientY: number,
    domain: DomainBounds,
    bounds: DomainBounds
  ): { index: number; handle: ResizeHandle } | null {
    const c = canvasRef.current
    const p = clientToCanvas(clientX, clientY)
    const selectedC = scene.conductors[selectedConductor]
    if (!c || !p || !selectedC) return null

    const threshold = CONDUCTOR_HANDLE_HIT_RADIUS_CSS_PX * p.scaleX
    const t2 = threshold * threshold

    const handleHit = (hx: number, hy: number, handle: ResizeHandle) => {
      const dx = hx - p.sx
      const dy = hy - p.sy
      return dx * dx + dy * dy <= t2 ? { index: selectedConductor, handle } : null
    }

    if (selectedC.kind === "rectangle") {
      const sw = worldToScreen(c, domain, selectedC.xMin, selectedC.yMin, bounds)
      const se = worldToScreen(c, domain, selectedC.xMax, selectedC.yMin, bounds)
      const nw = worldToScreen(c, domain, selectedC.xMin, selectedC.yMax, bounds)
      const ne = worldToScreen(c, domain, selectedC.xMax, selectedC.yMax, bounds)

      return (
        handleHit(sw.x, sw.y, "rect-sw") ??
        handleHit(se.x, se.y, "rect-se") ??
        handleHit(nw.x, nw.y, "rect-nw") ??
        handleHit(ne.x, ne.y, "rect-ne")
      )
    }

    const center = worldToScreen(c, domain, selectedC.x, selectedC.y, bounds)
    const edge = worldToScreen(c, domain, selectedC.x + selectedC.radius, selectedC.y, bounds)
    return handleHit(edge.x, edge.y, "circle-radius") ??
      // also allow grabbing circle border anywhere around radius
      (() => {
        const dx = p.sx - center.x
        const dy = p.sy - center.y
        const rr = Math.hypot(edge.x - center.x, edge.y - center.y)
        return Math.abs(Math.hypot(dx, dy) - rr) <= threshold ? { index: selectedConductor, handle: "circle-radius" as const } : null
      })()
  }

  function hitTestConductorBody(clientX: number, clientY: number, domain: DomainBounds, bounds: DomainBounds): number {
    const w = clientToWorld(clientX, clientY, domain, bounds)
    if (!w) return -1

    for (let i = scene.conductors.length - 1; i >= 0; i--) {
      const c = scene.conductors[i]
      if (c.kind === "rectangle") {
        if (w.x >= c.xMin && w.x <= c.xMax && w.y >= c.yMin && w.y <= c.yMax) return i
      } else {
        if (Math.hypot(w.x - c.x, w.y - c.y) <= c.radius) return i
      }
    }

    return -1
  }

  function onCanvasMouseDown(ev: React.MouseEvent) {
    const domain = currentDomain
    const bounds = viewBoundsFrom(viewState, domain)

    const isPanStart = ev.button === 1 || ev.button === 2 || (ev.button === 0 && ev.shiftKey)
    if (isPanStart) {
      ev.preventDefault()
      dragRef.current = {
        mode: "pan",
        chargeIndex: -1,
        conductorIndex: -1,
        resizeHandle: null,
        lastClientX: ev.clientX,
        lastClientY: ev.clientY,
        moved: false
      }
      return
    }

    if (ev.button !== 0) return

    const handleHit = hitTestSelectedConductorHandle(ev.clientX, ev.clientY, domain, bounds)
    if (handleHit) {
      ev.preventDefault()
      setProbe(null)
      dragRef.current = {
        mode: "conductorResize",
        chargeIndex: -1,
        conductorIndex: handleHit.index,
        resizeHandle: handleHit.handle,
        lastClientX: ev.clientX,
        lastClientY: ev.clientY,
        moved: false
      }
      return
    }

    const hit = hitTestCharge(ev.clientX, ev.clientY, domain, bounds)
    if (hit >= 0) {
      ev.preventDefault()
      setSelected(hit)
      setProbe(null)
      dragRef.current = {
        mode: "charge",
        chargeIndex: hit,
        conductorIndex: -1,
        resizeHandle: null,
        lastClientX: ev.clientX,
        lastClientY: ev.clientY,
        moved: false
      }
      return
    }

    const hitCond = hitTestConductorBody(ev.clientX, ev.clientY, domain, bounds)
    if (hitCond >= 0) {
      ev.preventDefault()
      setSelectedConductor(hitCond)
      setProbe(null)
      dragRef.current = {
        mode: "conductorMove",
        chargeIndex: -1,
        conductorIndex: hitCond,
        resizeHandle: null,
        lastClientX: ev.clientX,
        lastClientY: ev.clientY,
        moved: false
      }
      return
    }

    if (mode === "probe") {
      const w = clientToWorld(ev.clientX, ev.clientY, domain, bounds)
      if (!w) {
        setStatus("click outside render viewport")
        return
      }
      const val = samplePhi(w.x, w.y)
      if (val == null) {
        setStatus("probe: run solve first")
        return
      }
      setProbe({ x: w.x, y: w.y, phi: val })
    }
  }

  function onCanvasMouseMove(ev: React.MouseEvent) {
    const drag = dragRef.current
    if (drag.mode === "none") return

    const domain = currentDomain
    const bounds = viewBoundsFrom(viewState, domain)

    if (drag.mode === "pan") {
      const c = canvasRef.current
      if (!c) return
      const p = clientToCanvas(ev.clientX, ev.clientY)
      if (!p) return
      const prev = clientToCanvas(drag.lastClientX, drag.lastClientY)
      if (!prev) return

      const vp = getDomainViewport(c, domain)
      const worldPerPixX = (bounds.xMax - bounds.xMin) / Math.max(1e-12, vp.width)
      const worldPerPixY = (bounds.yMax - bounds.yMin) / Math.max(1e-12, vp.height)

      const dx = p.sx - prev.sx
      const dy = p.sy - prev.sy

      if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
        drag.moved = true
      }

      setViewState(v => clampView({
        ...v,
        centerX: v.centerX - dx * worldPerPixX,
        centerY: v.centerY + dy * worldPerPixY
      }, domain))

      drag.lastClientX = ev.clientX
      drag.lastClientY = ev.clientY
      return
    }

    if (drag.mode === "charge") {
      const w = clientToWorld(ev.clientX, ev.clientY, domain, bounds)
      if (!w) return

      if (Math.abs(ev.clientX - drag.lastClientX) > 0.25 || Math.abs(ev.clientY - drag.lastClientY) > 0.25) {
        drag.moved = true
      }

      drag.lastClientX = ev.clientX
      drag.lastClientY = ev.clientY

      setScene(s => {
        if (drag.chargeIndex < 0 || drag.chargeIndex >= s.charges.length) return s
        const ch = [...s.charges]
        ch[drag.chargeIndex] = { ...ch[drag.chargeIndex], x: w.x, y: w.y }
        return { ...s, charges: ch }
      })
      return
    }

    if (drag.mode === "conductorMove") {
      const c = canvasRef.current
      if (!c) return
      const p = clientToCanvas(ev.clientX, ev.clientY)
      const prev = clientToCanvas(drag.lastClientX, drag.lastClientY)
      if (!p || !prev) return
      const vp = getDomainViewport(c, domain)
      const worldPerPixX = (bounds.xMax - bounds.xMin) / Math.max(1e-12, vp.width)
      const worldPerPixY = (bounds.yMax - bounds.yMin) / Math.max(1e-12, vp.height)
      const dxWorld = (p.sx - prev.sx) * worldPerPixX
      const dyWorld = -(p.sy - prev.sy) * worldPerPixY

      if (Math.abs(dxWorld) > 0 || Math.abs(dyWorld) > 0) {
        drag.moved = true
      }

      drag.lastClientX = ev.clientX
      drag.lastClientY = ev.clientY

      setScene(s => {
        if (drag.conductorIndex < 0 || drag.conductorIndex >= s.conductors.length) return s
        const next = [...s.conductors]
        const cond = next[drag.conductorIndex]
        next[drag.conductorIndex] = cond.kind === "rectangle"
          ? {
              ...cond,
              xMin: cond.xMin + dxWorld,
              xMax: cond.xMax + dxWorld,
              yMin: cond.yMin + dyWorld,
              yMax: cond.yMax + dyWorld
            }
          : {
              ...cond,
              x: cond.x + dxWorld,
              y: cond.y + dyWorld
            }
        return { ...s, conductors: next }
      })
      return
    }

    if (drag.mode === "conductorResize") {
      const w = clientToWorld(ev.clientX, ev.clientY, domain, bounds)
      if (!w) return
      const minSize = 1e-4 * Math.max(domain.xMax - domain.xMin, domain.yMax - domain.yMin)

      if (Math.abs(ev.clientX - drag.lastClientX) > 0.25 || Math.abs(ev.clientY - drag.lastClientY) > 0.25) {
        drag.moved = true
      }
      drag.lastClientX = ev.clientX
      drag.lastClientY = ev.clientY

      setScene(s => {
        if (drag.conductorIndex < 0 || drag.conductorIndex >= s.conductors.length) return s
        const next = [...s.conductors]
        const cond = next[drag.conductorIndex]
        const handle = drag.resizeHandle
        if (!handle) return s

        if (cond.kind === "circle" && handle === "circle-radius") {
          next[drag.conductorIndex] = {
            ...cond,
            radius: Math.max(minSize, Math.hypot(w.x - cond.x, w.y - cond.y))
          }
          return { ...s, conductors: next }
        }

        if (cond.kind === "rectangle") {
          let xMin = cond.xMin
          let xMax = cond.xMax
          let yMin = cond.yMin
          let yMax = cond.yMax

          if (handle === "rect-sw") {
            xMin = Math.min(w.x, xMax - minSize)
            yMin = Math.min(w.y, yMax - minSize)
          } else if (handle === "rect-se") {
            xMax = Math.max(w.x, xMin + minSize)
            yMin = Math.min(w.y, yMax - minSize)
          } else if (handle === "rect-nw") {
            xMin = Math.min(w.x, xMax - minSize)
            yMax = Math.max(w.y, yMin + minSize)
          } else if (handle === "rect-ne") {
            xMax = Math.max(w.x, xMin + minSize)
            yMax = Math.max(w.y, yMin + minSize)
          }

          next[drag.conductorIndex] = { ...cond, xMin, xMax, yMin, yMax }
          return { ...s, conductors: next }
        }

        return s
      })
    }
  }

  function finishDrag() {
    const drag = dragRef.current
    if (drag.mode === "none") return

    const movedPhysicsObject =
      (drag.mode === "charge" || drag.mode === "conductorMove" || drag.mode === "conductorResize") && drag.moved
    dragRef.current = {
      mode: "none",
      chargeIndex: -1,
      conductorIndex: -1,
      resizeHandle: null,
      lastClientX: 0,
      lastClientY: 0,
      moved: false
    }

    if (movedPhysicsObject) {
      void runSolve()
    }
  }

  function samplePhi(x: number, y: number): number | null {
    if (!phiField) return null
    const { xMin, xMax, yMin, yMax, nx, ny, phi } = phiField
    if (x < xMin || x > xMax || y < yMin || y > yMax) return null

    const fx = ((x - xMin) / (xMax - xMin)) * (nx - 1)
    const fy = ((y - yMin) / (yMax - yMin)) * (ny - 1)

    const i0 = Math.floor(fx)
    const j0 = Math.floor(fy)
    const i1 = Math.min(nx - 1, i0 + 1)
    const j1 = Math.min(ny - 1, j0 + 1)
    const sx = fx - i0
    const sy = fy - j0

    const k00 = j0 * nx + i0
    const k10 = j0 * nx + i1
    const k01 = j1 * nx + i0
    const k11 = j1 * nx + i1

    const v00 = phi[k00]
    const v10 = phi[k10]
    const v01 = phi[k01]
    const v11 = phi[k11]

    return (
      v00 * (1 - sx) * (1 - sy) +
      v10 * sx * (1 - sy) +
      v01 * (1 - sx) * sy +
      v11 * sx * sy
    )
  }

  function addCharge(sign: 1 | -1) {
    setScene(s => {
      const charges = [...s.charges, { x: 0, y: 0, q: sign }]
      setSelected(charges.length - 1)
      return { ...s, charges }
    })
  }

  function removeSelected() {
    setScene(s => {
      if (s.charges.length === 0) return s
      const ch = s.charges.filter((_, i) => i !== selected)
      return { ...s, charges: ch }
    })
    setSelected(idx => Math.max(0, Math.min(idx, scene.charges.length - 2)))
  }

  function addRectangleConductor() {
    setScene(s => {
      const c: Conductor = {
        kind: "rectangle",
        potential: 0,
        xMin: -0.3,
        xMax: 0.3,
        yMin: -0.2,
        yMax: 0.2
      }
      const next = [...s.conductors, c]
      setSelectedConductor(next.length - 1)
      return { ...s, conductors: next }
    })
  }

  function addCircleConductor() {
    setScene(s => {
      const c: Conductor = {
        kind: "circle",
        potential: 0,
        x: 0,
        y: 0,
        radius: 0.25
      }
      const next = [...s.conductors, c]
      setSelectedConductor(next.length - 1)
      return { ...s, conductors: next }
    })
  }

  function removeSelectedConductor() {
    setScene(s => {
      if (s.conductors.length === 0) return s
      const next = s.conductors.filter((_, i) => i !== selectedConductor)
      return { ...s, conductors: next }
    })
    setSelectedConductor(i => Math.max(0, Math.min(i, scene.conductors.length - 2)))
  }

  function patchSelectedConductor(mut: (c: Conductor) => Conductor) {
    setScene(s => {
      if (s.conductors.length === 0) return s
      const idx = clamp(selectedConductor, 0, s.conductors.length - 1)
      const next = [...s.conductors]
      next[idx] = mut(next[idx])
      return { ...s, conductors: next }
    })
  }

  function buildProjectSolutionSnapshot(field: PhiField | null): ProjectSolutionSnapshot | undefined {
    if (!field) return undefined
    return {
      nx: field.nx,
      ny: field.ny,
      phiMin: field.phiMin,
      phiMax: field.phiMax,
      iterations: field.iterations,
      residual: field.residual,
      phiHash: hashPhiArray(field.phi)
    }
  }

  function buildProjectFilePayload(): ProjectFile {
    const selectedChargeIndex = clamp(selected, 0, Math.max(0, scene.charges.length - 1))
    const selectedConductorIndex = clamp(selectedConductor, 0, Math.max(0, scene.conductors.length - 1))

    const project: ProjectFile = {
      kind: PROJECT_FILE_KIND,
      version: PROJECT_FILE_VERSION,
      savedAt: new Date().toISOString(),
      scene,
      settings: {
        grid: { nx, ny },
        solver: {
          maxIters,
          tolerance: tol,
          omega,
          chargeSigmaCells: sigmaCells
        },
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
        view: viewState,
        ui: {
          mode,
          selectedChargeIndex,
          selectedConductorIndex
        },
        exportImage: {
          width: parseIntInRange(exportWidthInput, MIN_EXPORT_RES, MAX_EXPORT_RES) ?? 1920,
          height: parseIntInRange(exportHeightInput, MIN_EXPORT_RES, MAX_EXPORT_RES) ?? 1080
        }
      }
    }

    const solution = buildProjectSolutionSnapshot(phiField)
    if (solution) project.solution = solution
    return project
  }

  function saveProjectToDisk() {
    const project = buildProjectFilePayload()
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const filename = `electro-project-${stamp}.json`
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    setStatus(`saved ${filename}`)
  }

  function openProjectFilePicker() {
    projectFileInputRef.current?.click()
  }

  function applyLoadedProject(project: ProjectFile) {
    const loadedScene = project.scene
    const settings = project.settings
    const selectedChargeIndex = clamp(settings.ui.selectedChargeIndex, 0, Math.max(0, loadedScene.charges.length - 1))
    const selectedConductorIndex = clamp(
      settings.ui.selectedConductorIndex,
      0,
      Math.max(0, loadedScene.conductors.length - 1)
    )

    setScene(loadedScene)
    setSelected(selectedChargeIndex)
    setSelectedConductor(selectedConductorIndex)
    setMode(settings.ui.mode)

    setNx(settings.grid.nx)
    setNy(settings.grid.ny)
    setMaxIters(settings.solver.maxIters)
    setTol(settings.solver.tolerance)
    setOmega(settings.solver.omega)
    setSigmaCells(settings.solver.chargeSigmaCells)

    setNxInput(String(settings.grid.nx))
    setNyInput(String(settings.grid.ny))
    setMaxItersInput(String(settings.solver.maxIters))
    setTolInput(String(settings.solver.tolerance))
    setOmegaInput(String(settings.solver.omega))
    setSigmaCellsInput(String(settings.solver.chargeSigmaCells))

    setShowField(settings.render.showField)
    setFieldStride(settings.render.fieldStride)
    setFieldStrideInput(String(settings.render.fieldStride))
    setEquipCount(settings.render.equipCount)
    setEquipCountInput(String(settings.render.equipCount))
    setScaleMode(settings.render.scaleMode)
    setClipPercentile(settings.render.clipPercentile)
    setClipPercentileInput(String(settings.render.clipPercentile))
    setShowLegend(settings.render.showLegend)
    setShowShading(settings.render.showShading)
    setShadingStrength(settings.render.shadingStrength)
    setDebugAxes(settings.render.debugAxes)

    setViewState(clampView(settings.view, loadedScene.domain))
    setSelectedQInput(loadedScene.charges[selectedChargeIndex]?.q == null ? "" : String(loadedScene.charges[selectedChargeIndex].q))
    setExportWidthInput(String(settings.exportImage.width))
    setExportHeightInput(String(settings.exportImage.height))

    setProbe(null)
    setPhiField(null)
    setMeta(null)
    setInputError(null)
  }

  function isSameSolution(saved: ProjectSolutionSnapshot, field: PhiField): boolean {
    if (saved.nx !== field.nx || saved.ny !== field.ny) return false
    if (saved.iterations !== field.iterations) return false
    return saved.phiHash.toLowerCase() === hashPhiArray(field.phi)
  }

  async function onProjectFileChange(ev: React.ChangeEvent<HTMLInputElement>) {
    const input = ev.currentTarget
    const file = input.files?.[0]
    input.value = ""
    if (!file) return

    try {
      const text = await file.text()
      const parsedRaw = JSON.parse(text)
      const parsed = parseProjectFile(parsedRaw)
      if (!parsed.ok) {
        setStatus(`load error: ${parsed.error}`)
        return
      }

      const project = parsed.value
      applyLoadedProject(project)
      setStatus(`loaded ${file.name}; solving`)

      const field = await solveSceneAndStore(project.scene, {
        nx: project.settings.grid.nx,
        ny: project.settings.grid.ny,
        maxIters: project.settings.solver.maxIters,
        tol: project.settings.solver.tolerance,
        omega: project.settings.solver.omega,
        sigmaCells: project.settings.solver.chargeSigmaCells
      })

      if (project.solution) {
        const same = isSameSolution(project.solution, field)
        setStatus(
          same
            ? `loaded ${file.name}; solution reproduced identically`
            : `loaded ${file.name}; solved but differs from saved solution snapshot`
        )
      } else {
        setStatus(`loaded ${file.name}; solved`)
      }
    } catch (e: any) {
      setStatus(`load error: ${e?.message ?? String(e)}`)
    }
  }

  function useViewportResolutionForExport() {
    const c = canvasRef.current
    if (!c) return
    setExportWidthInput(String(Math.max(1, Math.round(c.width))))
    setExportHeightInput(String(Math.max(1, Math.round(c.height))))
  }

  async function exportPng() {
    if (!phiField) {
      setStatus("export: run solve first")
      return
    }

    const exportWidth = parseIntInRange(exportWidthInput, MIN_EXPORT_RES, MAX_EXPORT_RES)
    if (exportWidth == null) {
      setStatus(`export: invalid width (expected integer ${MIN_EXPORT_RES}..${MAX_EXPORT_RES})`)
      return
    }

    const exportHeight = parseIntInRange(exportHeightInput, MIN_EXPORT_RES, MAX_EXPORT_RES)
    if (exportHeight == null) {
      setStatus(`export: invalid height (expected integer ${MIN_EXPORT_RES}..${MAX_EXPORT_RES})`)
      return
    }

    const bounds = viewBoundsFrom(viewState, phiField)
    const exportCanvas = document.createElement("canvas")
    exportCanvas.width = exportWidth
    exportCanvas.height = exportHeight

    renderFieldToCanvas(exportCanvas, phiField, {
      showField,
      fieldStride,
      showEquip: equipCount > 0,
      equipCount: Math.max(0, equipCount),
      scaleMode,
      clipPercentile,
      showLegend: true,
      units: "arb.",
      showShading,
      shadingStrength,
      debugAxes,
      viewBounds: bounds,
      probe,
      charges: scene.charges,
      conductors: scene.conductors,
      selectedConductorIndex: selectedConductor
    })

    const blob = await new Promise<Blob | null>(resolve => exportCanvas.toBlob(resolve, "image/png"))
    if (!blob) {
      setStatus("export: failed to encode png")
      return
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const filename = `electrostatic-${exportWidth}x${exportHeight}-${stamp}.png`
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    setStatus(`exported ${filename}`)
  }

  return (
    <div style={{ display: "flex", gap: 16, padding: 16, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ width: 340 }}>
        <input
          ref={projectFileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={onProjectFileChange}
          style={{ display: "none" }}
        />
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>electro mvp</div>

        <div style={{ marginBottom: 10, color: "#444" }}>
          wheel: zoom, right/middle/shift+drag: pan, left-drag charge: move, mode=probe: sample φ
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <button onClick={runSolve} disabled={status === "solving"} style={{ padding: "8px 12px" }}>solve</button>
          <button onClick={saveProjectToDisk}>save project</button>
          <button onClick={openProjectFilePicker}>load project</button>
          <button onClick={() => addCharge(+1)}>+ charge</button>
          <button onClick={() => addCharge(-1)}>- charge</button>
          <button onClick={removeSelected} disabled={scene.charges.length === 0}>del</button>
          <button onClick={addRectangleConductor}>+ rect cond</button>
          <button onClick={addCircleConductor}>+ circle cond</button>
          <button onClick={removeSelectedConductor} disabled={scene.conductors.length === 0}>del cond</button>
          <button onClick={() => setViewState(makeDefaultView(currentDomain))}>reset view</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => setMode("move")}
            style={{ flex: 1, padding: "6px 10px", background: mode === "move" ? "#e7f0ff" : "white" }}
          >
            move charges
          </button>
          <button
            onClick={() => setMode("probe")}
            style={{ flex: 1, padding: "6px 10px", background: mode === "probe" ? "#e7f0ff" : "white" }}
          >
            probe φ
          </button>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600 }}>charges</div>
          {scene.charges.map((c, i) => (
            <div
              key={i}
              onClick={() => setSelected(i)}
              style={{
                cursor: "pointer",
                padding: "6px 8px",
                marginTop: 6,
                border: "1px solid #ddd",
                borderRadius: 8,
                background: i === selected ? "#f2f2f2" : "white",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center"
              }}
            >
              <div>
                <div>#{i} q={c.q.toFixed(2)}</div>
                <div style={{ fontSize: 12, color: "#555" }}>
                  x={c.x.toFixed(3)} y={c.y.toFixed(3)}
                </div>
              </div>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: c.q >= 0 ? "#e64f4f" : "#4f7be6"
                }}
              />
            </div>
          ))}
        </div>

        {selectedCharge && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>selected</div>
            <label style={{ display: "block", fontSize: 12 }}>
              q
              <input
                type="text"
                inputMode="decimal"
                value={selectedQInput}
                onChange={e => commitSelectedChargeQ(e.target.value)}
                style={{ width: "100%" }}
              />
            </label>
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>conductors</div>
          {scene.conductors.length === 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>none</div>
          )}
          {scene.conductors.map((c, i) => (
            <div
              key={i}
              onClick={() => setSelectedConductor(i)}
              style={{
                cursor: "pointer",
                padding: "6px 8px",
                marginTop: 6,
                border: "1px solid #ddd",
                borderRadius: 8,
                background: i === selectedConductor ? "#f2f2f2" : "white",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 12
              }}
            >
              <div>
                <div>#{i} {c.kind} V={c.potential.toFixed(3)}</div>
                {c.kind === "rectangle" ? (
                  <div style={{ color: "#555" }}>
                    [{c.xMin.toFixed(2)}, {c.xMax.toFixed(2)}] x [{c.yMin.toFixed(2)}, {c.yMax.toFixed(2)}]
                  </div>
                ) : (
                  <div style={{ color: "#555" }}>
                    c=({c.x.toFixed(2)}, {c.y.toFixed(2)}) r={c.radius.toFixed(2)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {selectedCond && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>selected conductor</div>
            <label style={{ display: "block", fontSize: 12 }}>
              type
              <select
                value={selectedCond.kind}
                onChange={e => {
                  const k = e.target.value
                  if (k === "rectangle") {
                    patchSelectedConductor(c => c.kind === "rectangle" ? c : ({
                      kind: "rectangle",
                      potential: c.potential,
                      xMin: c.x - c.radius,
                      xMax: c.x + c.radius,
                      yMin: c.y - c.radius,
                      yMax: c.y + c.radius
                    }))
                  } else {
                    patchSelectedConductor(c => c.kind === "circle" ? c : ({
                      kind: "circle",
                      potential: c.potential,
                      x: 0.5 * (c.xMin + c.xMax),
                      y: 0.5 * (c.yMin + c.yMax),
                      radius: 0.5 * Math.max(Math.abs(c.xMax - c.xMin), Math.abs(c.yMax - c.yMin))
                    }))
                  }
                }}
                style={{ width: "100%" }}
              >
                <option value="rectangle">rectangle</option>
                <option value="circle">circle</option>
              </select>
            </label>
            <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
              potential
              <input
                type="number"
                value={selectedCond.potential}
                step={0.1}
                onChange={e => patchSelectedConductor(c => ({ ...c, potential: Number(e.target.value) }))}
                style={{ width: "100%" }}
              />
            </label>
            {selectedCond.kind === "rectangle" ? (
              <>
                <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
                  x min
                  <input
                    type="number"
                    value={selectedCond.xMin}
                    step={0.05}
                    onChange={e => patchSelectedConductor(c => c.kind === "rectangle" ? { ...c, xMin: Number(e.target.value) } : c)}
                    style={{ width: "100%" }}
                  />
                </label>
                <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
                  x max
                  <input
                    type="number"
                    value={selectedCond.xMax}
                    step={0.05}
                    onChange={e => patchSelectedConductor(c => c.kind === "rectangle" ? { ...c, xMax: Number(e.target.value) } : c)}
                    style={{ width: "100%" }}
                  />
                </label>
                <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
                  y min
                  <input
                    type="number"
                    value={selectedCond.yMin}
                    step={0.05}
                    onChange={e => patchSelectedConductor(c => c.kind === "rectangle" ? { ...c, yMin: Number(e.target.value) } : c)}
                    style={{ width: "100%" }}
                  />
                </label>
                <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
                  y max
                  <input
                    type="number"
                    value={selectedCond.yMax}
                    step={0.05}
                    onChange={e => patchSelectedConductor(c => c.kind === "rectangle" ? { ...c, yMax: Number(e.target.value) } : c)}
                    style={{ width: "100%" }}
                  />
                </label>
              </>
            ) : (
              <>
                <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
                  center x
                  <input
                    type="number"
                    value={selectedCond.x}
                    step={0.05}
                    onChange={e => patchSelectedConductor(c => c.kind === "circle" ? { ...c, x: Number(e.target.value) } : c)}
                    style={{ width: "100%" }}
                  />
                </label>
                <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
                  center y
                  <input
                    type="number"
                    value={selectedCond.y}
                    step={0.05}
                    onChange={e => patchSelectedConductor(c => c.kind === "circle" ? { ...c, y: Number(e.target.value) } : c)}
                    style={{ width: "100%" }}
                  />
                </label>
                <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
                  radius
                  <input
                    type="number"
                    value={selectedCond.radius}
                    step={0.05}
                    min={0}
                    onChange={e => patchSelectedConductor(c => c.kind === "circle" ? { ...c, radius: Number(e.target.value) } : c)}
                    style={{ width: "100%" }}
                  />
                </label>
              </>
            )}
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>grid</div>
          <label style={{ display: "block", fontSize: 12 }}>
            nx
            <input
              type="text"
              inputMode="numeric"
              value={nxInput}
              onChange={e => applyTextDraft(e.target.value, setNxInput, setNx, parseIntInRange(e.target.value, 32, 1024))}
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ display: "block", fontSize: 12 }}>
            ny
            <input
              type="text"
              inputMode="numeric"
              value={nyInput}
              onChange={e => applyTextDraft(e.target.value, setNyInput, setNy, parseIntInRange(e.target.value, 32, 1024))}
              style={{ width: "100%" }}
            />
          </label>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>solver</div>
          <label style={{ display: "block", fontSize: 12 }}>
            max iters
            <input
              type="text"
              inputMode="numeric"
              value={maxItersInput}
              onChange={e => applyTextDraft(e.target.value, setMaxItersInput, setMaxIters, parseIntInRange(e.target.value, 1, 50000))}
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ display: "block", fontSize: 12 }}>
            tolerance
            <input
              type="text"
              inputMode="decimal"
              value={tolInput}
              onChange={e => {
                const raw = e.target.value
                const v = parseFinite(raw)
                applyTextDraft(raw, setTolInput, setTol, v != null && v > 0 ? v : null)
              }}
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ display: "block", fontSize: 12 }}>
            omega (sor)
            <input
              type="text"
              inputMode="decimal"
              value={omegaInput}
              onChange={e => applyTextDraft(e.target.value, setOmegaInput, setOmega, parseFloatInRange(e.target.value, 0.1, 1.99))}
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ display: "block", fontSize: 12 }}>
            charge sigma (cells)
            <input
              type="text"
              inputMode="decimal"
              value={sigmaCellsInput}
              onChange={e => applyTextDraft(e.target.value, setSigmaCellsInput, setSigmaCells, parseFloatInRange(e.target.value, 0.25, 6))}
              style={{ width: "100%" }}
            />
          </label>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>overlays</div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 6 }}>
            <input type="checkbox" checked={showField} onChange={e => setShowField(e.target.checked)} />
            show E arrows (E = -∇φ)
          </label>
          <label style={{ display: "block", fontSize: 12 }}>
            arrow stride (cells)
            <input
              type="text"
              inputMode="numeric"
              value={fieldStrideInput}
              onChange={e => applyTextDraft(e.target.value, setFieldStrideInput, setFieldStride, parseIntInRange(e.target.value, 2, 64))}
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
            equipotential lines
            <input
              type="text"
              inputMode="numeric"
              value={equipCountInput}
              onChange={e => applyTextDraft(e.target.value, setEquipCountInput, setEquipCount, parseIntInRange(e.target.value, 0, 24))}
              style={{ width: "100%" }}
            />
          </label>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>rendering</div>
          <label style={{ display: "block", fontSize: 12 }}>
            scale mode
            <select
              value={scaleMode}
              onChange={e => setScaleMode(e.target.value as ScaleMode)}
              style={{ width: "100%" }}
            >
              <option value="linear">linear</option>
              <option value="symmetric">symmetric around zero</option>
              <option value="log">log magnitude</option>
            </select>
          </label>
          <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
            percentile clip (% each tail)
            <input
              type="text"
              inputMode="decimal"
              value={clipPercentileInput}
              onChange={e => applyTextDraft(e.target.value, setClipPercentileInput, setClipPercentile, parseFloatInRange(e.target.value, 0, 20))}
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginTop: 6 }}>
            <input type="checkbox" checked={showLegend} onChange={e => setShowLegend(e.target.checked)} />
            show legend and numeric scale
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginTop: 6 }}>
            <input type="checkbox" checked={showShading} onChange={e => setShowShading(e.target.checked)} />
            gradient lighting (visual only)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginTop: 6 }}>
            <input type="checkbox" checked={debugAxes} onChange={e => setDebugAxes(e.target.checked)} />
            debug axes and viewport
          </label>
          <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
            shading strength
            <input
              type="range"
              value={shadingStrength}
              min={0}
              max={1}
              step={0.05}
              onChange={e => setShadingStrength(Number(e.target.value))}
              disabled={!showShading}
              style={{ width: "100%" }}
            />
          </label>
          <div style={{ marginTop: 6, fontSize: 12, color: "#555" }}>
            zoom {viewState.zoom.toFixed(2)}x
          </div>
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid #ddd" }}>
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>png export</div>
            <label style={{ display: "block", fontSize: 12 }}>
              width (px)
              <input
                type="text"
                inputMode="numeric"
                value={exportWidthInput}
                onChange={e => setExportWidthInput(e.target.value)}
                style={{ width: "100%" }}
              />
            </label>
            <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
              height (px)
              <input
                type="text"
                inputMode="numeric"
                value={exportHeightInput}
                onChange={e => setExportHeightInput(e.target.value)}
                style={{ width: "100%" }}
              />
            </label>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={useViewportResolutionForExport} style={{ flex: 1 }}>
                use viewport
              </button>
              <button onClick={exportPng} disabled={!phiField} style={{ flex: 1 }}>
                export png
              </button>
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: "#555" }}>
              export always includes legend and numeric scale
            </div>
          </div>
        </div>

        <div style={{ padding: 10, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ fontWeight: 600 }}>status</div>
          <div style={{ marginTop: 6, fontSize: 12, color: "#333" }}>{status}</div>
          {inputError && (
            <div style={{ marginTop: 6, fontSize: 12, color: "#a31515" }}>
              input: {inputError}
            </div>
          )}
          {meta && (
            <div style={{ marginTop: 6, fontSize: 12, color: "#555" }}>
              phi range [{meta.phiMin.toFixed(3)}, {meta.phiMax.toFixed(3)}]
            </div>
          )}
          {probe && (
            <div style={{ marginTop: 6, fontSize: 12, color: "#222" }}>
              probe: x={probe.x.toFixed(3)} y={probe.y.toFixed(3)} φ={probe.phi.toFixed(4)}
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 1 }}>
        <canvas
          ref={canvasRef}
          onMouseDown={onCanvasMouseDown}
          onMouseMove={onCanvasMouseMove}
          onMouseUp={finishDrag}
          onMouseLeave={finishDrag}
          onContextMenu={e => e.preventDefault()}
          style={{
            display: "block",
            border: "1px solid #ddd",
            borderRadius: 12,
            overscrollBehavior: "contain",
            touchAction: "none"
          }}
        />
      </div>
    </div>
  )
}
