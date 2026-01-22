import type { PhiField, PointCharge, Probe } from "./types"

export type RenderOptions = {
  showField: boolean
  fieldStride: number
  showEquip: boolean
  equipCount: number
  probe?: Probe | null
  charges?: PointCharge[]
}

// renders float32 phi into canvas as heatmap with optional overlays
export function renderFieldToCanvas(canvas: HTMLCanvasElement, field: PhiField, opts: RenderOptions) {
  const ctx = canvas.getContext("2d")
  if (!ctx) return

  drawHeatmap(canvas, ctx, field)

  if (opts.showEquip && opts.equipCount > 0) {
    drawEquipotentials(canvas, ctx, field, opts.equipCount)
  }

  if (opts.showField) {
    drawFieldArrows(canvas, ctx, field, Math.max(2, Math.floor(opts.fieldStride)))
  }

  if (opts.charges && opts.charges.length) {
    drawCharges(canvas, ctx, field, opts.charges)
  }

  if (opts.probe) {
    drawProbe(canvas, ctx, field, opts.probe)
  }
}

function drawHeatmap(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, field: PhiField) {
  const { nx, ny, phi, phiMin, phiMax } = field

  const img = ctx.createImageData(nx, ny)
  const data = img.data

  const inv = 1.0 / (phiMax - phiMin)

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      let t = (phi[k] - phiMin) * inv
      if (!Number.isFinite(t)) t = 0
      if (t < 0) t = 0
      if (t > 1) t = 1

      const [r, g, b] = turboish(t)
      const p = 4 * k
      data[p + 0] = r
      data[p + 1] = g
      data[p + 2] = b
      data[p + 3] = 255
    }
  }

  // draw into a temporary canvas at native resolution, then scale to fit
  const tmp = document.createElement("canvas")
  tmp.width = nx
  tmp.height = ny
  const tctx = tmp.getContext("2d")!
  tctx.putImageData(img, 0, 0)

  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height)
}

function drawEquipotentials(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  field: PhiField,
  levels: number
) {
  const { phiMin, phiMax } = field
  const span = phiMax - phiMin
  if (!Number.isFinite(span) || span <= 1e-12) return

  const count = Math.max(1, levels)
  for (let i = 1; i <= count; i++) {
    const level = phiMin + (i / (count + 1)) * span
    const segments = marchingSquares(field, level)

    ctx.beginPath()
    for (const seg of segments) {
      const [x1, y1, x2, y2] = seg
      const p1 = worldToCanvas(canvas, field, x1, y1)
      const p2 = worldToCanvas(canvas, field, x2, y2)
      ctx.moveTo(p1.x, p1.y)
      ctx.lineTo(p2.x, p2.y)
    }
    const hue = 210 + (120 * i) / count
    ctx.strokeStyle = `hsla(${hue}, 80%, 55%, 0.9)`
    ctx.lineWidth = 1
    ctx.stroke()
  }
}

function drawFieldArrows(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  field: PhiField,
  stride: number
) {
  const { phi, nx, ny, xMin, xMax, yMin, yMax } = field
  const dx = (xMax - xMin) / (nx - 1)
  const dy = (yMax - yMin) / (ny - 1)

  const arrows: { x: number; y: number; ex: number; ey: number; mag: number }[] = []
  let maxMag = 0

  for (let j = stride; j < ny - stride; j += stride) {
    for (let i = stride; i < nx - stride; i += stride) {
      const k = j * nx + i
      const dphidx = (phi[k + 1] - phi[k - 1]) / (2 * dx)
      const dphidy = (phi[k + nx] - phi[k - nx]) / (2 * dy)

      const ex = -dphidx
      const ey = -dphidy
      const mag = Math.hypot(ex, ey)
      if (!Number.isFinite(mag) || mag <= 0) continue

      const x = xMin + i * dx
      const y = yMin + j * dy
      arrows.push({ x, y, ex, ey, mag })
      if (mag > maxMag) maxMag = mag
    }
  }

  if (arrows.length === 0 || maxMag === 0) return

  const scale = (Math.min(canvas.width, canvas.height) * 0.1) / maxMag

  ctx.save()
  ctx.strokeStyle = "rgba(10, 10, 10, 0.9)"
  ctx.lineWidth = 1

  for (const a of arrows) {
    const p = worldToCanvas(canvas, field, a.x, a.y)
    const dxPix = a.ex * scale
    const dyPix = -a.ey * scale // flip for canvas y-down
    drawArrow(ctx, p.x, p.y, dxPix, dyPix)
  }

  ctx.restore()
}

function drawCharges(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  field: PhiField,
  charges: PointCharge[]
) {
  if (!charges.length) return
  ctx.save()
  ctx.lineWidth = 1.5

  for (const c of charges) {
    const p = worldToCanvas(canvas, field, c.x, c.y)
    const color = c.q >= 0 ? "rgba(240, 60, 60, 0.95)" : "rgba(60, 110, 240, 0.95)"
    const r = 7
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = "rgba(0,0,0,0.5)"
    ctx.stroke()
  }

  ctx.restore()
}

function drawProbe(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  field: PhiField,
  probe: Probe
) {
  const p = worldToCanvas(canvas, field, probe.x, probe.y)
  ctx.save()
  ctx.strokeStyle = "rgba(0,0,0,0.9)"
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(p.x - 10, p.y)
  ctx.lineTo(p.x + 10, p.y)
  ctx.moveTo(p.x, p.y - 10)
  ctx.lineTo(p.x, p.y + 10)
  ctx.stroke()

  const label = `φ=${probe.phi.toFixed(4)}`
  const padding = 4
  const metrics = ctx.measureText(label)
  const w = metrics.width + padding * 2
  const h = 16 + padding * 2
  const x = Math.min(canvas.width - w - 4, Math.max(4, p.x + 12))
  const y = Math.max(h + 4, p.y - 12)

  ctx.fillStyle = "rgba(255, 255, 255, 0.9)"
  ctx.fillRect(x, y - h, w, h)
  ctx.strokeStyle = "rgba(0,0,0,0.4)"
  ctx.strokeRect(x, y - h, w, h)

  ctx.fillStyle = "rgba(0,0,0,0.9)"
  ctx.font = "12px system-ui, -apple-system, sans-serif"
  ctx.fillText(label, x + padding, y - h / 2 + 4)
  ctx.restore()
}

function worldToCanvas(
  canvas: HTMLCanvasElement,
  field: PhiField,
  x: number,
  y: number
): { x: number; y: number } {
  const u = (x - field.xMin) / (field.xMax - field.xMin)
  const v = (y - field.yMin) / (field.yMax - field.yMin)
  return { x: u * canvas.width, y: canvas.height - v * canvas.height }
}

function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number) {
  const bx = x + dx
  const by = y + dy
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return

  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(bx, by)
  ctx.stroke()

  const head = Math.min(8, 0.6 * len)
  const ang = Math.atan2(dy, dx)

  const hx1 = bx - head * Math.cos(ang - Math.PI / 7)
  const hy1 = by - head * Math.sin(ang - Math.PI / 7)
  const hx2 = bx - head * Math.cos(ang + Math.PI / 7)
  const hy2 = by - head * Math.sin(ang + Math.PI / 7)

  ctx.beginPath()
  ctx.moveTo(bx, by)
  ctx.lineTo(hx1, hy1)
  ctx.lineTo(hx2, hy2)
  ctx.lineTo(bx, by)
  ctx.stroke()
}

// cheap approximation of turbo-like palette without deps
function turboish(t: number): [number, number, number] {
  const x = t
  const r = clamp01(1.5 * x - 0.2) - clamp01(1.5 * x - 1.2) * 0.2
  const g = clamp01(1.5 * x) - clamp01(1.5 * x - 1.0) * 0.3
  const b = clamp01(1.2 - 1.5 * x) + clamp01(0.2 - 1.5 * x) * 0.1

  return [to255(r), to255(g), to255(b)]
}

function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function to255(x: number) {
  return Math.max(0, Math.min(255, Math.round(255 * x)))
}

type Segment = [number, number, number, number]

function marchingSquares(field: PhiField, iso: number): Segment[] {
  const { phi, nx, ny, xMin, yMin, xMax, yMax } = field
  const dx = (xMax - xMin) / (nx - 1)
  const dy = (yMax - yMin) / (ny - 1)
  const segments: Segment[] = []

  for (let j = 0; j < ny - 1; j++) {
    const row = j * nx
    for (let i = 0; i < nx - 1; i++) {
      const k = row + i
      const v0 = phi[k] // bottom-left
      const v1 = phi[k + 1] // bottom-right
      const v2 = phi[k + 1 + nx] // top-right
      const v3 = phi[k + nx] // top-left

      let caseIdx = 0
      if (v0 < iso) caseIdx |= 1
      if (v1 < iso) caseIdx |= 2
      if (v2 < iso) caseIdx |= 4
      if (v3 < iso) caseIdx |= 8

      if (caseIdx === 0 || caseIdx === 15) continue

      const edges = marchingEdges(caseIdx)
      if (edges.length === 0) continue

      const baseX = xMin + i * dx
      const baseY = yMin + j * dy

      for (let e = 0; e < edges.length; e += 2) {
        const p1 = edgePoint(edges[e], v0, v1, v2, v3, iso, baseX, baseY, dx, dy)
        const p2 = edgePoint(edges[e + 1], v0, v1, v2, v3, iso, baseX, baseY, dx, dy)
        if (p1 && p2) {
          segments.push([p1.x, p1.y, p2.x, p2.y])
        }
      }
    }
  }

  return segments
}

function marchingEdges(caseIdx: number): number[] {
  switch (caseIdx) {
    case 1:
      return [3, 0]
    case 2:
      return [0, 1]
    case 3:
      return [3, 1]
    case 4:
      return [1, 2]
    case 5:
      return [3, 2, 0, 1]
    case 6:
      return [0, 2]
    case 7:
      return [3, 2]
    case 8:
      return [2, 3]
    case 9:
      return [2, 0]
    case 10:
      return [2, 1, 0, 3]
    case 11:
      return [2, 1]
    case 12:
      return [1, 3]
    case 13:
      return [1, 0]
    case 14:
      return [0, 3]
    default:
      return []
  }
}

type Point = { x: number; y: number }

function edgePoint(
  edge: number,
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  iso: number,
  baseX: number,
  baseY: number,
  dx: number,
  dy: number
): Point | null {
  const clampT = (t: number) => (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.5)

  switch (edge) {
    case 0: {
      const t = clampT((iso - v0) / (v1 - v0))
      return { x: baseX + t * dx, y: baseY }
    }
    case 1: {
      const t = clampT((iso - v1) / (v2 - v1))
      return { x: baseX + dx, y: baseY + t * dy }
    }
    case 2: {
      const t = clampT((iso - v3) / (v2 - v3))
      return { x: baseX + t * dx, y: baseY + dy }
    }
    case 3: {
      const t = clampT((iso - v0) / (v3 - v0))
      return { x: baseX, y: baseY + t * dy }
    }
    default:
      return null
  }
}
