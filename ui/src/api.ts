import type { Scene, GridSpec, SolverSpec, SolveMeta } from "./types"

const ENGINE = "http://localhost:5000"

export async function solve(scene: Scene, grid: GridSpec, solver: SolverSpec): Promise<SolveMeta> {
  const res = await fetch(`${ENGINE}/solve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scene, grid, solver })
  })
  if (!res.ok) throw new Error(`solve failed: ${res.status}`)
  return (await res.json()) as SolveMeta
}

export async function fetchPhi(resultId: string): Promise<ArrayBuffer> {
  const res = await fetch(`${ENGINE}/result/${resultId}/phi`)
  if (!res.ok) throw new Error(`phi fetch failed: ${res.status}`)
  return await res.arrayBuffer()
}
