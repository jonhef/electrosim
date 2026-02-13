# Electrostatic MVP

This engine/UI pair solves a **2D Poisson equation** on a rectangular domain and renders the potential on a grid. The model is deliberately simple so the assumptions need to be explicit.

## What is solved
- Equation: `-∇²φ = ρ / ε` on a uniform Cartesian grid with cell sizes `dx`, `dy`.
- Boundary condition: homogeneous Neumann (`∂φ/∂n = 0`) enforced each iteration by copying the interior neighbor (isolated box, no open/free-space radiation).
- Optional internal Dirichlet regions (`scene.conductors`) for fixed-potential conductors (`rectangle`, `circle`).
- Solver: Gauss–Seidel with SOR over the interior; the residual reported is the discrete L2 norm of `-laplacian(phi) - rho/eps`.
- Units are arbitrary; `ε` defaults to 1 unless provided via the scene domain.

## Conductors (fixed potential)
Add conductor objects in the scene:
- `rectangle`: `kind="rectangle"` with `xMin/xMax/yMin/yMax` and `potential`.
- `circle`: `kind="circle"` with `x/y/radius` and `potential`.

All grid cells covered by a conductor are constrained to the specified potential every iteration (Dirichlet condition).

## How point charges are regularized
- Each point charge `(x, y, q)` is deposited into `ρ` as a Gaussian blob with standard deviation `sigmaCells * dx` (and `dy`), truncated at ~3σ.
- The deposit is normalized so the integrated charge over the grid area equals `q`, avoiding singularities at the grid nodes while keeping the total charge conserved.

## What “2D electrostatics” means here
- The solution corresponds to infinitely long line charges extruded out of the plane (per unit length in z), **not** a slice of a 3D point-charge field.
- Fields fall off differently than in 3D (logarithmic vs. 1/r), and the Neumann box boundaries reflect the domain rather than modeling open space.
- Use this as a qualitative sandbox for 2D potentials; a true 3D electrostatic solution would require a different model (3D Poisson with open boundaries or conductors).

## Run with Docker (full stack)
Prereq: Docker + docker-compose.

1) Copy `.env.example` to `.env` and adjust if needed:
```
ENGINE_PORT=5000      # host port for the engine (container listens on 5000)
UI_PORT=8080          # host port for the UI (container listens on 80)
ENGINE_URL=http://localhost:5000  # build-time URL embedded into the UI; must be reachable from your browser
```
2) Build and start both services:
```
docker compose up --build
```
This brings up:
- `engine` (.NET API) in Docker (published to host port `${ENGINE_PORT}`).
- `ui` (React built once, served by nginx) exposed at `http://localhost:${UI_PORT}`.

3) Stop and clean up containers:
```
docker compose down
```

Rebuild UI/engine images after code changes with `docker compose build` (or `docker compose up --build`). No local Node.js or .NET install is required. The UI talks to the engine via `ENGINE_URL` (from the browser perspective), so set it to a browser-reachable address if you change ports or host.
