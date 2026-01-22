using System.Numerics;

namespace Electro;

public static class Solver
{
    // solves -laplacian(phi) = rho/eps on a regular grid with neumann boundary dphi/dn=0 (copy edge neighbor)
    // point charges are deposited as gaussian blobs to avoid singularities
    public static SolveResult Solve(SceneDto scene, GridSpecDto grid, SolverSpecDto solver)
    {
        var nx = Math.Clamp(grid.Nx, 32, 2048);
        var ny = Math.Clamp(grid.Ny, 32, 2048);

        var xMin = scene.Domain.XMin;
        var xMax = scene.Domain.XMax;
        var yMin = scene.Domain.YMin;
        var yMax = scene.Domain.YMax;

        if (!(xMax > xMin) || !(yMax > yMin))
            throw new ArgumentException("bad domain bounds");

        var eps = scene.Domain.Epsilon;
        if (eps <= 0) eps = 1f;

        var dx = (xMax - xMin) / (nx - 1);
        var dy = (yMax - yMin) / (ny - 1);

        var invDx2 = 1f / (dx * dx);
        var invDy2 = 1f / (dy * dy);

        var phi = new float[nx * ny];
        var rho = new float[nx * ny];

        DepositChargesGaussian(scene, nx, ny, xMin, yMin, dx, dy, solver.ChargeSigmaCells, rho);

        // rhs b = rho/eps
        // equation: -(phi_xx + phi_yy) = rho/eps
        // discrete laplacian: (phiE - 2phi + phiW)/dx^2 + (phiN - 2phi + phiS)/dy^2
        // so update for interior from gs/sor:
        // phi = ( (phiE+phiW)*invDx2 + (phiN+phiS)*invDy2 + b ) / (2(invDx2+invDy2))
        var denom = 2f * (invDx2 + invDy2);
        var omega = Math.Clamp(solver.Omega, 0.1f, 1.99f);
        var tol = Math.Max(1e-10f, solver.Tolerance);
        var maxIters = Math.Clamp(solver.MaxIters, 1, 200000);

        float residual = float.PositiveInfinity;
        int it;

        // warm start: 0
        for (it = 0; it < maxIters; it++)
        {
            // neumann boundary: copy adjacent interior values each iter (cheap and works ok for mvp)
            ApplyNeumannZero(phi, nx, ny);

            // gauss-seidel sweep + sor
            for (int j = 1; j < ny - 1; j++)
            {
                int row = j * nx;
                for (int i = 1; i < nx - 1; i++)
                {
                    int k = row + i;

                    float phiW = phi[k - 1];
                    float phiE = phi[k + 1];
                    float phiS = phi[k - nx];
                    float phiN = phi[k + nx];

                    float b = rho[k] / eps;

                    float phiNew = ((phiE + phiW) * invDx2 + (phiN + phiS) * invDy2 + b) / denom;
                    phi[k] = phi[k] + omega * (phiNew - phi[k]);
                }
            }

            if (it % 10 == 0 || it == maxIters - 1)
            {
                residual = ComputeResidualL2(phi, rho, eps, nx, ny, invDx2, invDy2);
                if (residual < tol) break;
            }
        }

        // final boundary copy
        ApplyNeumannZero(phi, nx, ny);

        // range for visualization
        float min = float.PositiveInfinity, max = float.NegativeInfinity;
        for (int k = 0; k < phi.Length; k++)
        {
            var v = phi[k];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        if (!float.IsFinite(min) || !float.IsFinite(max))
        {
            min = -1; max = 1;
        }
        if (Math.Abs(max - min) < 1e-12f)
        {
            max = min + 1e-6f;
        }

        return new SolveResult
        {
            Phi = phi,
            Nx = nx,
            Ny = ny,
            XMin = xMin,
            XMax = xMax,
            YMin = yMin,
            YMax = yMax,
            PhiMin = min,
            PhiMax = max,
            Iterations = it + 1,
            Residual = residual
        };
    }

    private static void DepositChargesGaussian(
        SceneDto scene, int nx, int ny,
        float xMin, float yMin, float dx, float dy,
        float sigmaCells, float[] rho)
    {
        Array.Clear(rho);

        if (scene.Charges.Count == 0) return;

        // gaussian sigma in meters based on dx,dy
        float sigmaX = Math.Max(dx, 1e-9f) * Math.Max(0.25f, sigmaCells);
        float sigmaY = Math.Max(dy, 1e-9f) * Math.Max(0.25f, sigmaCells);

        // cutoff ~3 sigma
        int radI = (int)MathF.Ceiling(3f * sigmaX / dx);
        int radJ = (int)MathF.Ceiling(3f * sigmaY / dy);

        foreach (var c in scene.Charges)
        {
            float x = c.X;
            float y = c.Y;
            float q = c.Q;

            // map to nearest cell index
            float fi = (x - xMin) / dx;
            float fj = (y - yMin) / dy;

            int i0 = (int)MathF.Round(fi);
            int j0 = (int)MathF.Round(fj);

            if (i0 < 0 || i0 >= nx || j0 < 0 || j0 >= ny) continue;

            int iStart = Math.Max(0, i0 - radI);
            int iEnd = Math.Min(nx - 1, i0 + radI);
            int jStart = Math.Max(0, j0 - radJ);
            int jEnd = Math.Min(ny - 1, j0 + radJ);

            // deposit weights then normalize so sum(rho)*dx*dy = q
            double sumW = 0.0;
            for (int j = jStart; j <= jEnd; j++)
            {
                float yy = yMin + j * dy;
                float dyc = yy - y;
                float wy = MathF.Exp(-0.5f * (dyc * dyc) / (sigmaY * sigmaY));

                int row = j * nx;
                for (int i = iStart; i <= iEnd; i++)
                {
                    float xx = xMin + i * dx;
                    float dxc = xx - x;
                    float wx = MathF.Exp(-0.5f * (dxc * dxc) / (sigmaX * sigmaX));

                    sumW += (double)(wx * wy);
                }
            }

            if (sumW <= 0) continue;

            // convert to rho: q distributed over area
            double scale = q / (sumW * dx * dy);

            for (int j = jStart; j <= jEnd; j++)
            {
                float yy = yMin + j * dy;
                float dyc = yy - y;
                float wy = MathF.Exp(-0.5f * (dyc * dyc) / (sigmaY * sigmaY));

                int row = j * nx;
                for (int i = iStart; i <= iEnd; i++)
                {
                    float xx = xMin + i * dx;
                    float dxc = xx - x;
                    float wx = MathF.Exp(-0.5f * (dxc * dxc) / (sigmaX * sigmaX));

                    int k = row + i;
                    rho[k] += (float)(scale * wx * wy);
                }
            }
        }
    }

    private static void ApplyNeumannZero(float[] phi, int nx, int ny)
    {
        // left/right edges copy neighbor
        for (int j = 0; j < ny; j++)
        {
            int row = j * nx;
            phi[row + 0] = phi[row + 1];
            phi[row + (nx - 1)] = phi[row + (nx - 2)];
        }
        // bottom/top edges copy neighbor
        for (int i = 0; i < nx; i++)
        {
            phi[0 * nx + i] = phi[1 * nx + i];
            phi[(ny - 1) * nx + i] = phi[(ny - 2) * nx + i];
        }
    }

    private static float ComputeResidualL2(float[] phi, float[] rho, float eps, int nx, int ny, float invDx2, float invDy2)
    {
        double sum = 0.0;
        int cnt = 0;

        for (int j = 1; j < ny - 1; j++)
        {
            int row = j * nx;
            for (int i = 1; i < nx - 1; i++)
            {
                int k = row + i;

                float phiC = phi[k];
                float phiW = phi[k - 1];
                float phiE = phi[k + 1];
                float phiS = phi[k - nx];
                float phiN = phi[k + nx];

                float lap = (phiE - 2f * phiC + phiW) * invDx2
                          + (phiN - 2f * phiC + phiS) * invDy2;

                // equation: -(lap) = rho/eps
                float r = -lap - (rho[k] / eps);

                sum += (double)r * r;
                cnt++;
            }
        }

        if (cnt == 0) return 0f;
        return (float)Math.Sqrt(sum / cnt);
    }
}
