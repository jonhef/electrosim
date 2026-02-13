import React, { useCallback, useEffect, useRef, useState } from "react"
import type { PointCharge, Scene, SolveMeta, PhiField, Probe } from "./types"
import { solve, fetchPhi } from "./api"
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
  ]
}

type ViewState = { centerX: number; centerY: number; zoom: number }
type DragMode = "none" | "pan" | "charge"
type DragState = {
  mode: DragMode
  chargeIndex: number
  lastClientX: number
  lastClientY: number
  moved: boolean
}

const MAX_ZOOM = 250
const CHARGE_HIT_RADIUS_CSS_PX = 14

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

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<DragState>({ mode: "none", chargeIndex: -1, lastClientX: 0, lastClientY: 0, moved: false })

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

  const [viewState, setViewState] = useState<ViewState>(() => makeDefaultView(defaultScene.domain))
  const [selectedQInput, setSelectedQInput] = useState(defaultScene.charges[0]?.q.toString() ?? "")

  const selectedCharge: PointCharge | null = scene.charges[selected] ?? null
  const currentDomain: DomainBounds = phiField ?? scene.domain

  useEffect(() => {
    const q = scene.charges[selected]?.q
    setSelectedQInput(q == null ? "" : String(q))
  }, [scene.charges, selected])

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
      charges: scene.charges
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
    scene.charges
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
      values: {
        nx: number
        ny: number
        maxIters: number
        tol: number
        omega: number
        sigmaCells: number
        fieldStride: number
        equipCount: number
        clipPercentile: number
        selectedQ: number | null
      }
    }
    | { ok: false; message: string } {
    const nxV = parseIntInRange(nxInput, 32, 1024)
    if (nxV == null) return { ok: false, message: "invalid nx (expected integer 32..1024)" }

    const nyV = parseIntInRange(nyInput, 32, 1024)
    if (nyV == null) return { ok: false, message: "invalid ny (expected integer 32..1024)" }

    const maxItersV = parseIntInRange(maxItersInput, 1, 50000)
    if (maxItersV == null) return { ok: false, message: "invalid max iters (expected integer 1..50000)" }

    const tolV = parseFinite(tolInput)
    if (tolV == null || tolV <= 0) return { ok: false, message: "invalid tolerance (expected positive number)" }

    const omegaV = parseFloatInRange(omegaInput, 0.1, 1.99)
    if (omegaV == null) return { ok: false, message: "invalid omega (expected number 0.1..1.99)" }

    const sigmaV = parseFloatInRange(sigmaCellsInput, 0.25, 6)
    if (sigmaV == null) return { ok: false, message: "invalid charge sigma (expected number 0.25..6)" }

    const strideV = parseIntInRange(fieldStrideInput, 2, 64)
    if (strideV == null) return { ok: false, message: "invalid arrow stride (expected integer 2..64)" }

    const equipV = parseIntInRange(equipCountInput, 0, 24)
    if (equipV == null) return { ok: false, message: "invalid equipotential count (expected integer 0..24)" }

    const clipV = parseFloatInRange(clipPercentileInput, 0, 20)
    if (clipV == null) return { ok: false, message: "invalid percentile clip (expected number 0..20)" }

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
      setStatus("solving")
      setProbe(null)

      const sceneForSolve: Scene = selectedCharge && v.selectedQ != null
        ? {
            ...scene,
            charges: scene.charges.map((c, i) => (i === selected ? { ...c, q: v.selectedQ as number } : c))
          }
        : scene

      if (selectedCharge && v.selectedQ != null) {
        setScene(sceneForSolve)
      }

      const m = await solve(
        sceneForSolve,
        { nx: v.nx, ny: v.ny },
        { maxIters: v.maxIters, tolerance: v.tol, omega: v.omega, chargeSigmaCells: v.sigmaCells }
      )
      setMeta(m)

      const buf = await fetchPhi(m.resultId)
      const phi = new Float32Array(buf)
      const field: PhiField = { ...m, phi }

      setPhiField(field)
      setStatus(`done (iters=${m.iterations}, residual=${m.residual.toExponential(2)})`)
      renderCurrent(field)
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

  function onCanvasMouseDown(ev: React.MouseEvent) {
    const domain = currentDomain
    const bounds = viewBoundsFrom(viewState, domain)

    const isPanStart = ev.button === 1 || ev.button === 2 || (ev.button === 0 && ev.shiftKey)
    if (isPanStart) {
      ev.preventDefault()
      dragRef.current = {
        mode: "pan",
        chargeIndex: -1,
        lastClientX: ev.clientX,
        lastClientY: ev.clientY,
        moved: false
      }
      return
    }

    if (ev.button !== 0) return

    const hit = hitTestCharge(ev.clientX, ev.clientY, domain, bounds)
    if (hit >= 0) {
      ev.preventDefault()
      setSelected(hit)
      setProbe(null)
      dragRef.current = {
        mode: "charge",
        chargeIndex: hit,
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
    }
  }

  function finishDrag() {
    const drag = dragRef.current
    if (drag.mode === "none") return

    const movedCharge = drag.mode === "charge" && drag.moved
    dragRef.current = { mode: "none", chargeIndex: -1, lastClientX: 0, lastClientY: 0, moved: false }

    if (movedCharge) {
      void runSolve()
    }
  }

  function onCanvasWheel(ev: React.WheelEvent) {
    ev.preventDefault()

    const c = canvasRef.current
    const p = clientToCanvas(ev.clientX, ev.clientY)
    if (!c || !p) return

    const domain = currentDomain

    setViewState(prev => {
      const prevClamped = clampView(prev, domain)
      const prevBounds = viewBoundsFrom(prevClamped, domain)
      const worldBefore = screenToWorld(c, domain, p.sx, p.sy, prevBounds)
      if (!worldBefore) return prevClamped

      const zoomMul = Math.exp(-ev.deltaY * 0.0015)
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

  return (
    <div style={{ display: "flex", gap: 16, padding: 16, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ width: 340 }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>electro mvp</div>

        <div style={{ marginBottom: 10, color: "#444" }}>
          wheel: zoom, right/middle/shift+drag: pan, left-drag charge: move, mode=probe: sample φ
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <button onClick={runSolve} disabled={status === "solving"} style={{ padding: "8px 12px" }}>solve</button>
          <button onClick={() => addCharge(+1)}>+ charge</button>
          <button onClick={() => addCharge(-1)}>- charge</button>
          <button onClick={removeSelected} disabled={scene.charges.length === 0}>del</button>
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
          onWheel={onCanvasWheel}
          onContextMenu={e => e.preventDefault()}
          style={{ display: "block", border: "1px solid #ddd", borderRadius: 12 }}
        />
      </div>
    </div>
  )
}
