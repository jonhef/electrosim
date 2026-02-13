import type { PhiField, PointCharge, Probe } from "./types"

export type ScaleMode = "linear" | "symmetric" | "log"
export type DomainBounds = { xMin: number; xMax: number; yMin: number; yMax: number }

export type RenderOptions = {
  showField: boolean
  fieldStride: number
  showEquip: boolean
  equipCount: number
  scaleMode?: ScaleMode
  clipPercentile?: number
  showLegend?: boolean
  units?: string
  showShading?: boolean
  shadingStrength?: number
  debugAxes?: boolean
  viewBounds?: DomainBounds
  probe?: Probe | null
  charges?: PointCharge[]
}

type Normalization = {
  mode: ScaleMode
  clipPercentile: number
  rawMin: number
  rawMax: number
  mapMin: number
  mapMax: number
  transform: (v: number) => number
}

type Segment = [number, number, number, number]
export type ScreenPoint = { x: number; y: number }
type Point = ScreenPoint
type Viewport = { x: number; y: number; width: number; height: number }

const DEFAULT_CLIP_PERCENT = 1
const DEFAULT_UNITS = "arb."
const BAYER_4X4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
const HEATMAP_TMP = document.createElement("canvas")
const HEATMAP_TMP_CTX = HEATMAP_TMP.getContext("2d")

export function worldToScreen(
  canvas: HTMLCanvasElement,
  domain: DomainBounds,
  x: number,
  y: number,
  viewBounds?: DomainBounds
): Point {
  const vp = computeViewport(canvas.width, canvas.height, domain)
  const view = clampViewBounds(domain, viewBounds ?? domain)
  return worldToCanvasInViewport(vp, view, x, y)
}

export function screenToWorld(
  canvas: HTMLCanvasElement,
  domain: DomainBounds,
  screenX: number,
  screenY: number,
  viewBounds?: DomainBounds
): Point | null {
  const vp = computeViewport(canvas.width, canvas.height, domain)
  const view = clampViewBounds(domain, viewBounds ?? domain)
  return canvasToWorldInViewport(vp, view, screenX, screenY)
}

export function getDomainViewport(canvas: HTMLCanvasElement, domain: DomainBounds) {
  return computeViewport(canvas.width, canvas.height, domain)
}

// renders float32 phi into canvas as heatmap with optional overlays
export function renderFieldToCanvas(canvas: HTMLCanvasElement, field: PhiField, opts: RenderOptions) {
  const ctx = canvas.getContext("2d")
  if (!ctx) return

  const viewBounds = clampViewBounds(field, opts.viewBounds ?? field)
  const viewport = computeViewport(canvas.width, canvas.height, field)
  const norm = buildNormalization(field, opts)
  drawHeatmap(canvas, ctx, field, norm, opts, viewport, viewBounds)

  if (opts.showEquip && opts.equipCount > 0) {
    drawEquipotentials(canvas, ctx, field, opts.equipCount, viewport, viewBounds)
  }

  if (opts.showField) {
    drawFieldArrows(canvas, ctx, field, Math.max(2, Math.floor(opts.fieldStride)), viewport, viewBounds)
  }

  if (opts.charges && opts.charges.length) {
    drawCharges(canvas, ctx, field, opts.charges, viewport, viewBounds)
  }

  if (opts.probe) {
    drawProbe(canvas, ctx, field, opts.probe, viewport, viewBounds)
  }

  if (opts.debugAxes ?? false) {
    drawDebugAxes(canvas, ctx, field, viewport, viewBounds)
  }

  if (opts.showLegend ?? true) {
    drawLegend(canvas, ctx, norm, opts, viewport)
  }
}

function drawHeatmap(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  field: PhiField,
  norm: Normalization,
  opts: RenderOptions,
  viewport: Viewport,
  viewBounds: DomainBounds
) {
  const { nx, ny, phi } = field

  const img = ctx.createImageData(nx, ny)
  const data = img.data

  const shading = opts.showShading ?? false
  const shadeStrength = Math.min(1, Math.max(0, opts.shadingStrength ?? 0.35))
  const gradP95 = shading ? estimateGradientP95(field) : 1
  const gradDen = Math.max(1e-12, gradP95)

  for (let j = 0; j < ny; j++) {
    const jm1 = j > 0 ? j - 1 : j
    const jp1 = j + 1 < ny ? j + 1 : j

    for (let i = 0; i < nx; i++) {
      const k = j * nx + i

      let t = clamp01(norm.transform(phi[k]))
      const d = (BAYER_4X4[(j & 3) * 4 + (i & 3)] / 15 - 0.5) * (1 / 255)
      t = clamp01(t + d)

      let [r, g, b] = turbo(t)

      if (shading) {
        const im1 = i > 0 ? i - 1 : i
        const ip1 = i + 1 < nx ? i + 1 : i
        const gx = 0.5 * (phi[j * nx + ip1] - phi[j * nx + im1])
        const gy = 0.5 * (phi[jp1 * nx + i] - phi[jm1 * nx + i])
        const gNorm = clamp01(Math.hypot(gx, gy) / gradDen)

        // apply lighting in linear space to avoid gamma artifacts
        const lr = srgbToLinear(r)
        const lg = srgbToLinear(g)
        const lb = srgbToLinear(b)
        const shadeFactor = 1 + (gNorm - 0.5) * 0.22 * shadeStrength

        r = linearToSrgb(clamp01(lr * shadeFactor))
        g = linearToSrgb(clamp01(lg * shadeFactor))
        b = linearToSrgb(clamp01(lb * shadeFactor))
      }

      const p = 4 * ((ny - 1 - j) * nx + i)
      data[p + 0] = to255(r)
      data[p + 1] = to255(g)
      data[p + 2] = to255(b)
      data[p + 3] = 255
    }
  }

  // draw at native grid then upscale with bilinear filtering
  if (!HEATMAP_TMP_CTX) return
  if (HEATMAP_TMP.width !== nx || HEATMAP_TMP.height !== ny) {
    HEATMAP_TMP.width = nx
    HEATMAP_TMP.height = ny
  }

  HEATMAP_TMP_CTX.putImageData(img, 0, 0)

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  const domainW = field.xMax - field.xMin
  const domainH = field.yMax - field.yMin
  const sx = ((viewBounds.xMin - field.xMin) / domainW) * nx
  const sw = ((viewBounds.xMax - viewBounds.xMin) / domainW) * nx
  const sy = ((field.yMax - viewBounds.yMax) / domainH) * ny
  const sh = ((viewBounds.yMax - viewBounds.yMin) / domainH) * ny

  ctx.fillStyle = "rgb(245 247 250)"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(HEATMAP_TMP, sx, sy, sw, sh, viewport.x, viewport.y, viewport.width, viewport.height)
}

function drawEquipotentials(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  field: PhiField,
  levels: number,
  viewport: Viewport,
  viewBounds: DomainBounds
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
      const p1 = worldToCanvas(canvas, viewBounds, x1, y1, viewport)
      const p2 = worldToCanvas(canvas, viewBounds, x2, y2, viewport)
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
  stride: number,
  viewport: Viewport,
  viewBounds: DomainBounds
) {
  const { phi, nx, ny, xMin, xMax, yMin, yMax } = field
  const dx = (xMax - xMin) / (nx - 1)
  const dy = (yMax - yMin) / (ny - 1)

  const arrows: { x: number; y: number; ex: number; ey: number; mag: number }[] = []
  const cellPxX = viewport.width / Math.max(1, nx - 1)
  const cellPxY = viewport.height / Math.max(1, ny - 1)
  const minSpacingPx = 22
  const adaptiveStride = Math.max(
    Math.max(2, Math.floor(stride)),
    Math.ceil(minSpacingPx / Math.max(1e-6, Math.min(cellPxX, cellPxY)))
  )

  const iMin = Math.max(adaptiveStride, Math.floor((viewBounds.xMin - xMin) / dx) - adaptiveStride)
  const iMax = Math.min(nx - adaptiveStride - 1, Math.ceil((viewBounds.xMax - xMin) / dx) + adaptiveStride)
  const jMin = Math.max(adaptiveStride, Math.floor((viewBounds.yMin - yMin) / dy) - adaptiveStride)
  const jMax = Math.min(ny - adaptiveStride - 1, Math.ceil((viewBounds.yMax - yMin) / dy) + adaptiveStride)
  if (iMin > iMax || jMin > jMax) return

  for (let j = jMin; j <= jMax; j += adaptiveStride) {
    for (let i = iMin; i <= iMax; i += adaptiveStride) {
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
    }
  }

  if (arrows.length === 0) return

  const magP95 = percentileFromArray(arrows.map(a => a.mag), 0.95)
  const normDen = Math.max(1e-12, magP95)
  const minLen = 4
  const maxLen = Math.min(26, 0.055 * Math.min(viewport.width, viewport.height))

  ctx.save()
  ctx.lineWidth = 1.1

  for (const a of arrows) {
    const m = clamp01(a.mag / normDen)
    if (m < 0.03) continue

    const p = worldToCanvas(canvas, viewBounds, a.x, a.y, viewport)
    const dirX = a.ex / a.mag
    const dirY = -a.ey / a.mag // flip for canvas y-down
    const len = minLen + (maxLen - minLen) * Math.sqrt(m)
    const alpha = 0.12 + 0.72 * m
    ctx.strokeStyle = `rgba(15, 18, 22, ${alpha.toFixed(3)})`
    drawArrow(ctx, p.x, p.y, dirX * len, dirY * len)
  }

  ctx.restore()
}

function drawCharges(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  field: PhiField,
  charges: PointCharge[],
  viewport: Viewport,
  viewBounds: DomainBounds
) {
  if (!charges.length) return
  ctx.save()
  ctx.lineWidth = 1.5

  for (const c of charges) {
    const p = worldToCanvas(canvas, viewBounds, c.x, c.y, viewport)
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
  probe: Probe,
  viewport: Viewport,
  viewBounds: DomainBounds
) {
  const p = worldToCanvas(canvas, viewBounds, probe.x, probe.y, viewport)
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

function drawDebugAxes(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  field: PhiField,
  viewport: Viewport,
  viewBounds: DomainBounds
) {
  ctx.save()
  ctx.strokeStyle = "rgba(255,255,255,0.35)"
  ctx.lineWidth = 1
  ctx.setLineDash([6, 4])
  ctx.strokeRect(viewport.x + 0.5, viewport.y + 0.5, viewport.width - 1, viewport.height - 1)

  if (field.xMin <= 0 && field.xMax >= 0) {
    const a = worldToCanvas(canvas, viewBounds, 0, field.yMin, viewport)
    const b = worldToCanvas(canvas, viewBounds, 0, field.yMax, viewport)
    ctx.strokeStyle = "rgba(255,255,255,0.45)"
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }

  if (field.yMin <= 0 && field.yMax >= 0) {
    const a = worldToCanvas(canvas, viewBounds, field.xMin, 0, viewport)
    const b = worldToCanvas(canvas, viewBounds, field.xMax, 0, viewport)
    ctx.strokeStyle = "rgba(255,255,255,0.45)"
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }

  ctx.setLineDash([])
  ctx.restore()
}

function drawLegend(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  norm: Normalization,
  opts: RenderOptions,
  viewport: Viewport
) {
  const barH = Math.max(120, Math.min(220, viewport.height - 40))
  const barW = 16
  const panelW = 138
  const panelH = barH + 58
  const x0 = Math.max(10, Math.min(canvas.width - panelW - 10, viewport.x + viewport.width - panelW - 10))
  const y0 = Math.max(10, viewport.y + 10)
  const barX = x0 + 10
  const barY = y0 + 30

  ctx.save()
  ctx.fillStyle = "rgba(255,255,255,0.88)"
  ctx.strokeStyle = "rgba(0,0,0,0.25)"
  ctx.lineWidth = 1
  ctx.fillRect(x0, y0, panelW, panelH)
  ctx.strokeRect(x0, y0, panelW, panelH)

  for (let y = 0; y < barH; y++) {
    const t = 1 - y / Math.max(1, barH - 1)
    const [r, g, b] = turbo(t)
    ctx.fillStyle = `rgb(${to255(r)} ${to255(g)} ${to255(b)})`
    ctx.fillRect(barX, barY + y, barW, 1)
  }

  ctx.strokeStyle = "rgba(0,0,0,0.4)"
  ctx.strokeRect(barX - 0.5, barY - 0.5, barW + 1, barH + 1)

  const units = opts.units ?? DEFAULT_UNITS
  ctx.fillStyle = "rgba(0,0,0,0.92)"
  ctx.font = "11px system-ui, -apple-system, sans-serif"
  ctx.fillText(`scale: ${norm.mode}`, x0 + 34, y0 + 14)
  ctx.fillText(`unit: ${units}`, x0 + 34, y0 + 28)
  ctx.fillText(`${fmt(norm.mapMax)}`, x0 + 34, barY + 8)
  ctx.fillText(`${fmt(norm.mapMin)}`, x0 + 34, barY + barH - 3)

  if (norm.mode !== "linear" && norm.mapMin < 0 && norm.mapMax > 0) {
    const zeroY = barY + Math.round((1 - norm.transform(0)) * (barH - 1))
    ctx.strokeStyle = "rgba(0,0,0,0.45)"
    ctx.beginPath()
    ctx.moveTo(barX - 2, zeroY + 0.5)
    ctx.lineTo(barX + barW + 2, zeroY + 0.5)
    ctx.stroke()
    ctx.fillText("0", x0 + 34, zeroY + 4)
  }

  if (norm.clipPercentile > 0) {
    ctx.fillStyle = "rgba(0,0,0,0.72)"
    ctx.fillText(`clip: ${norm.clipPercentile}%`, x0 + 8, y0 + panelH - 22)
  }

  ctx.fillStyle = "rgba(0,0,0,0.60)"
  ctx.fillText(`raw: [${fmt(norm.rawMin)}, ${fmt(norm.rawMax)}]`, x0 + 8, y0 + panelH - 8)
  ctx.restore()
}

function worldToCanvas(
  canvas: HTMLCanvasElement,
  bounds: DomainBounds,
  x: number,
  y: number,
  viewport?: Viewport
): { x: number; y: number } {
  const vp = viewport ?? computeViewport(canvas.width, canvas.height, bounds)
  return worldToCanvasInViewport(vp, bounds, x, y)
}

function worldToCanvasInViewport(
  viewport: Viewport,
  domain: DomainBounds,
  x: number,
  y: number
): Point {
  const u = (x - domain.xMin) / (domain.xMax - domain.xMin)
  const v = (y - domain.yMin) / (domain.yMax - domain.yMin)
  return {
    x: viewport.x + u * viewport.width,
    y: viewport.y + (1 - v) * viewport.height
  }
}

function canvasToWorldInViewport(
  viewport: Viewport,
  domain: DomainBounds,
  screenX: number,
  screenY: number
): Point | null {
  if (
    screenX < viewport.x ||
    screenX > viewport.x + viewport.width ||
    screenY < viewport.y ||
    screenY > viewport.y + viewport.height
  ) {
    return null
  }

  const u = (screenX - viewport.x) / Math.max(1e-12, viewport.width)
  const v = 1 - (screenY - viewport.y) / Math.max(1e-12, viewport.height)
  const x = domain.xMin + u * (domain.xMax - domain.xMin)
  const y = domain.yMin + v * (domain.yMax - domain.yMin)
  return { x, y }
}

function clampViewBounds(domain: DomainBounds, view: DomainBounds): DomainBounds {
  const domainW = domain.xMax - domain.xMin
  const domainH = domain.yMax - domain.yMin
  const minW = domainW / 250
  const minH = domainH / 250

  let w = clamp(view.xMax - view.xMin, minW, domainW)
  let h = clamp(view.yMax - view.yMin, minH, domainH)
  const cx = 0.5 * (view.xMin + view.xMax)
  const cy = 0.5 * (view.yMin + view.yMax)

  let xMin = cx - 0.5 * w
  let xMax = cx + 0.5 * w
  let yMin = cy - 0.5 * h
  let yMax = cy + 0.5 * h

  if (xMin < domain.xMin) {
    xMax += domain.xMin - xMin
    xMin = domain.xMin
  }
  if (xMax > domain.xMax) {
    xMin -= xMax - domain.xMax
    xMax = domain.xMax
  }
  if (yMin < domain.yMin) {
    yMax += domain.yMin - yMin
    yMin = domain.yMin
  }
  if (yMax > domain.yMax) {
    yMin -= yMax - domain.yMax
    yMax = domain.yMax
  }

  // final clamp if domain smaller than desired window
  xMin = clamp(xMin, domain.xMin, domain.xMax - minW)
  xMax = clamp(xMax, domain.xMin + minW, domain.xMax)
  yMin = clamp(yMin, domain.yMin, domain.yMax - minH)
  yMax = clamp(yMax, domain.yMin + minH, domain.yMax)

  return { xMin, xMax, yMin, yMax }
}

function computeViewport(canvasWidth: number, canvasHeight: number, domain: DomainBounds): Viewport {
  const domainWidth = Math.max(1e-12, domain.xMax - domain.xMin)
  const domainHeight = Math.max(1e-12, domain.yMax - domain.yMin)
  const domainAspect = domainWidth / domainHeight
  const canvasAspect = canvasWidth / Math.max(1e-12, canvasHeight)

  let width = canvasWidth
  let height = canvasHeight
  if (canvasAspect > domainAspect) {
    width = canvasHeight * domainAspect
  } else {
    height = canvasWidth / domainAspect
  }

  return {
    x: 0.5 * (canvasWidth - width),
    y: 0.5 * (canvasHeight - height),
    width,
    height
  }
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

  const head = Math.min(7, 0.55 * len)
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

// Official polynomial approximation of Google Turbo colormap (returns sRGB [0..1])
function turbo(t: number): [number, number, number] {
  const x = clamp01(t)
  const x2 = x * x
  const x3 = x2 * x
  const x4 = x3 * x
  const x5 = x4 * x

  const r = 0.13572138 + 4.6153926 * x - 42.66032258 * x2 + 132.13108234 * x3 - 152.94239396 * x4 + 59.28637943 * x5
  const g = 0.09140261 + 2.19418839 * x + 4.84296658 * x2 - 14.18503333 * x3 + 4.27729857 * x4 + 2.82956604 * x5
  const b = 0.1066733 + 12.64194608 * x - 60.58204836 * x2 + 110.36276771 * x3 - 89.90310912 * x4 + 27.34824973 * x5

  return [clamp01(r), clamp01(g), clamp01(b)]
}

function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function clamp(x: number, lo: number, hi: number) {
  return x < lo ? lo : x > hi ? hi : x
}

function to255(x: number) {
  return Math.max(0, Math.min(255, Math.round(255 * clamp01(x))))
}

function srgbToLinear(x: number) {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
}

function linearToSrgb(x: number) {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
}

function buildNormalization(field: PhiField, opts: RenderOptions): Normalization {
  const mode = opts.scaleMode ?? "linear"
  const clipPercentile = Math.min(20, Math.max(0, opts.clipPercentile ?? DEFAULT_CLIP_PERCENT))
  const rawMin = field.phiMin
  const rawMax = field.phiMax
  const [clipLo, clipHi] = percentileClip(field.phi, clipPercentile, rawMin, rawMax)
  const safeLo = Number.isFinite(clipLo) ? clipLo : rawMin
  const safeHi = Number.isFinite(clipHi) ? clipHi : rawMax

  if (mode === "symmetric") {
    const absMax = Math.max(Math.abs(safeLo), Math.abs(safeHi), 1e-12)
    const inv = 0.5 / absMax
    return {
      mode,
      clipPercentile,
      rawMin,
      rawMax,
      mapMin: -absMax,
      mapMax: absMax,
      transform: (v: number) => (clamp(v, -absMax, absMax) + absMax) * inv
    }
  }

  if (mode === "log") {
    const absMax = Math.max(Math.abs(safeLo), Math.abs(safeHi), 1e-12)
    const knee = Math.max(absMax * 0.02, 1e-12)
    const den = Math.log1p(absMax / knee)

    return {
      mode,
      clipPercentile,
      rawMin,
      rawMax,
      mapMin: -absMax,
      mapMax: absMax,
      transform: (v: number) => {
        const clamped = clamp(v, -absMax, absMax)
        const signed = Math.sign(clamped) * (Math.log1p(Math.abs(clamped) / knee) / den)
        return 0.5 + 0.5 * signed
      }
    }
  }

  const span = Math.max(1e-12, safeHi - safeLo)
  const inv = 1 / span
  return {
    mode: "linear",
    clipPercentile,
    rawMin,
    rawMax,
    mapMin: safeLo,
    mapMax: safeHi,
    transform: (v: number) => (clamp(v, safeLo, safeHi) - safeLo) * inv
  }
}

function percentileClip(phi: Float32Array, clipPercent: number, fallbackMin: number, fallbackMax: number): [number, number] {
  if (phi.length === 0) return [fallbackMin, fallbackMax]
  if (clipPercent <= 0) return [fallbackMin, fallbackMax]

  const sample = deterministicSample(phi, 16384)
  if (sample.length === 0) return [fallbackMin, fallbackMax]

  sample.sort((a, b) => a - b)
  const qLo = percentileFromSorted(sample, clipPercent / 100)
  const qHi = percentileFromSorted(sample, 1 - clipPercent / 100)

  if (!Number.isFinite(qLo) || !Number.isFinite(qHi) || qHi <= qLo) return [fallbackMin, fallbackMax]
  return [qLo, qHi]
}

function deterministicSample(src: Float32Array, maxCount: number): number[] {
  const n = src.length
  if (n <= maxCount) return Array.from(src)

  const step = Math.max(1, Math.floor(n / maxCount))
  const out: number[] = []
  for (let i = 0; i < n; i += step) out.push(src[i])
  return out
}

function percentileFromSorted(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const x = clamp01(p) * (arr.length - 1)
  const i0 = Math.floor(x)
  const i1 = Math.min(arr.length - 1, i0 + 1)
  const t = x - i0
  return arr[i0] * (1 - t) + arr[i1] * t
}

function percentileFromArray(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return percentileFromSorted(sorted, p)
}

function estimateGradientP95(field: PhiField): number {
  const { nx, ny, phi } = field
  const grads: number[] = []
  const stepX = Math.max(1, Math.floor(nx / 64))
  const stepY = Math.max(1, Math.floor(ny / 64))

  for (let j = 1; j < ny - 1; j += stepY) {
    for (let i = 1; i < nx - 1; i += stepX) {
      const k = j * nx + i
      const gx = 0.5 * (phi[k + 1] - phi[k - 1])
      const gy = 0.5 * (phi[k + nx] - phi[k - nx])
      grads.push(Math.hypot(gx, gy))
    }
  }

  return Math.max(1e-12, percentileFromArray(grads, 0.95))
}

function fmt(v: number) {
  if (!Number.isFinite(v)) return "n/a"
  const a = Math.abs(v)
  if (a >= 1e3 || (a > 0 && a < 1e-2)) return v.toExponential(2)
  return v.toFixed(3)
}

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
