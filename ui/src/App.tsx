import React, { useEffect, useRef, useState } from "react"
import type { PointCharge, Scene, SolveMeta, PhiField, Probe } from "./types"
import { solve, fetchPhi } from "./api"
import { renderFieldToCanvas } from "./render"

const defaultScene: Scene = {
  domain: { xMin: -1, xMax: 1, yMin: -1, yMax: 1, epsilon: 1 },
  charges: [
    { x: -0.35, y: 0.0, q: +1.0 },
    { x: +0.35, y: 0.0, q: -1.0 }
  ]
}

type CanvasDomain = { xMin: number; xMax: number; yMin: number; yMax: number }

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [scene, setScene] = useState<Scene>(defaultScene)

  const [nx, setNx] = useState(256)
  const [ny, setNy] = useState(256)
  const [maxIters, setMaxIters] = useState(800)
  const [tol, setTol] = useState(1e-4)
  const [omega, setOmega] = useState(1.85)
  const [sigmaCells, setSigmaCells] = useState(1.25)

  const [phiField, setPhiField] = useState<PhiField | null>(null)
  const [meta, setMeta] = useState<SolveMeta | null>(null)
  const [status, setStatus] = useState<string>("idle")
  const [selected, setSelected] = useState<number>(0)
  const [mode, setMode] = useState<"move" | "probe">("move")
  const [probe, setProbe] = useState<Probe | null>(null)

  const [showField, setShowField] = useState(true)
  const [fieldStride, setFieldStride] = useState(12)
  const [equipCount, setEquipCount] = useState(8)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const resize = () => {
      const w = Math.max(360, Math.min(window.innerWidth - 340, 980))
      const h = Math.max(360, Math.min(window.innerHeight - 50, 980))
      c.width = w
      c.height = h
      renderCurrent()
    }
    resize()
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [])

  useEffect(() => {
    renderCurrent()
  }, [phiField, showField, fieldStride, equipCount, probe, scene.charges])

  async function runSolve() {
    try {
      setStatus("solving")
      setProbe(null)
      const m = await solve(
        scene,
        { nx, ny },
        { maxIters, tolerance: tol, omega, chargeSigmaCells: sigmaCells }
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

  function renderCurrent(nextField?: PhiField | null) {
    const c = canvasRef.current
    const field = nextField ?? phiField
    if (!c || !field) return
    renderFieldToCanvas(c, field, {
      showField,
      fieldStride,
      showEquip: equipCount > 0,
      equipCount: Math.max(0, equipCount),
      probe,
      charges: scene.charges
    })
  }

  function canvasToWorld(ev: React.MouseEvent, domain: CanvasDomain) {
    const c = canvasRef.current
    if (!c) return null
    const r = c.getBoundingClientRect()
    const u = (ev.clientX - r.left) / r.width
    const v = (ev.clientY - r.top) / r.height
    const x = domain.xMin + u * (domain.xMax - domain.xMin)
    const y = domain.yMax - v * (domain.yMax - domain.yMin)
    return { x, y }
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

  function onCanvasClick(ev: React.MouseEvent) {
    const domain: CanvasDomain = phiField ?? scene.domain
    const p = canvasToWorld(ev, domain)
    if (!p) return

    if (mode === "probe") {
      const val = samplePhi(p.x, p.y)
      if (val == null) {
        setStatus("probe: run solve first")
        return
      }
      const info = { x: p.x, y: p.y, phi: val }
      setProbe(info)
      renderCurrent()
      return
    }

    setProbe(null)
    // move selected charge
    setScene(s => {
      const ch = [...s.charges]
      if (ch.length === 0) return s
      const idx = Math.min(selected, ch.length - 1)
      ch[idx] = { ...ch[idx], x: p.x, y: p.y }
      return { ...s, charges: ch }
    })
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

  const selectedCharge: PointCharge | null = scene.charges[selected] ?? null

  return (
    <div style={{ display: "flex", gap: 16, padding: 16, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ width: 340 }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>electro mvp</div>

        <div style={{ marginBottom: 10, color: "#444" }}>
          click canvas: move (mode=move) or probe φ (mode=probe)
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <button onClick={runSolve} disabled={status === "solving"} style={{ padding: "8px 12px" }}>solve</button>
          <button onClick={() => addCharge(+1)}>+ charge</button>
          <button onClick={() => addCharge(-1)}>- charge</button>
          <button onClick={removeSelected} disabled={scene.charges.length === 0}>del</button>
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
                type="number"
                value={selectedCharge.q}
                step={0.1}
                onChange={e => {
                  const q = Number(e.target.value)
                  setScene(s => {
                    const ch = [...s.charges]
                    ch[selected] = { ...ch[selected], q }
                    return { ...s, charges: ch }
                  })
                }}
                style={{ width: "100%" }}
              />
            </label>
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>grid</div>
          <label style={{ display: "block", fontSize: 12 }}>
            nx
            <input type="number" value={nx} min={32} max={1024} onChange={e => setNx(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
          <label style={{ display: "block", fontSize: 12 }}>
            ny
            <input type="number" value={ny} min={32} max={1024} onChange={e => setNy(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>solver</div>
          <label style={{ display: "block", fontSize: 12 }}>
            max iters
            <input type="number" value={maxIters} min={1} max={50000} onChange={e => setMaxIters(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
          <label style={{ display: "block", fontSize: 12 }}>
            tolerance
            <input type="number" value={tol} step={1e-4} onChange={e => setTol(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
          <label style={{ display: "block", fontSize: 12 }}>
            omega (sor)
            <input type="number" value={omega} step={0.05} min={0.1} max={1.99} onChange={e => setOmega(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
          <label style={{ display: "block", fontSize: 12 }}>
            charge sigma (cells)
            <input type="number" value={sigmaCells} step={0.25} min={0.25} max={6} onChange={e => setSigmaCells(Number(e.target.value))} style={{ width: "100%" }} />
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
            <input type="number" value={fieldStride} min={2} max={64} onChange={e => setFieldStride(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
          <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
            equipotential lines
            <input type="number" value={equipCount} min={0} max={24} onChange={e => setEquipCount(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
        </div>

        <div style={{ padding: 10, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ fontWeight: 600 }}>status</div>
          <div style={{ marginTop: 6, fontSize: 12, color: "#333" }}>{status}</div>
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
          onClick={onCanvasClick}
          style={{ width: "100%", height: "100%", border: "1px solid #ddd", borderRadius: 12 }}
        />
      </div>
    </div>
  )
}
