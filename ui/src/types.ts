export type PointCharge = { x: number; y: number; q: number }

export type Scene = {
  domain: { xMin: number; xMax: number; yMin: number; yMax: number; epsilon: number }
  charges: PointCharge[]
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
