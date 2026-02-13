export type PointCharge = { x: number; y: number; q: number }
export type RectConductor = {
  kind: "rectangle"
  potential: number
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}
export type CircleConductor = {
  kind: "circle"
  potential: number
  x: number
  y: number
  radius: number
}
export type Conductor = RectConductor | CircleConductor

export type Scene = {
  domain: { xMin: number; xMax: number; yMin: number; yMax: number; epsilon: number }
  charges: PointCharge[]
  conductors: Conductor[]
}

export type SolveMeta = {
  resultId: string
  nx: number
  ny: number
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  phiMin: number
  phiMax: number
  iterations: number
  residual: number
}

export type GridSpec = { nx: number; ny: number }
export type SolverSpec = { maxIters: number; tolerance: number; omega: number; chargeSigmaCells: number }

export type PhiField = SolveMeta & { phi: Float32Array }

export type Probe = { x: number; y: number; phi: number }
