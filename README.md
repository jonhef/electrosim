# Electrostatic MVP

This engine/UI pair solves a **2D Poisson equation** on a rectangular domain and renders the potential on a grid. The model is deliberately simple so the assumptions need to be explicit.

## What is solved
- Equation: `-∇²φ = ρ / ε` on a uniform Cartesian grid with cell sizes `dx`, `dy`.
- Boundary condition: homogeneous Neumann (`∂φ/∂n = 0`) enforced each iteration by copying the interior neighbor (isolated box, no open/free-space radiation).
- Solver: Gauss–Seidel with SOR over the interior; the residual reported is the discrete L2 norm of `-laplacian(phi) - rho/eps`.
- Units are arbitrary; `ε` defaults to 1 unless provided via the scene domain.

## How point charges are regularized
- Each point charge `(x, y, q)` is deposited into `ρ` as a Gaussian blob with standard deviation `sigmaCells * dx` (and `dy`), truncated at ~3σ.
- The deposit is normalized so the integrated charge over the grid area equals `q`, avoiding singularities at the grid nodes while keeping the total charge conserved.

## What “2D electrostatics” means here
- The solution corresponds to infinitely long line charges extruded out of the plane (per unit length in z), **not** a slice of a 3D point-charge field.
- Fields fall off differently than in 3D (logarithmic vs. 1/r), and the Neumann box boundaries reflect the domain rather than modeling open space.
- Use this as a qualitative sandbox for 2D potentials; a true 3D electrostatic solution would require a different model (3D Poisson with open boundaries or conductors).
