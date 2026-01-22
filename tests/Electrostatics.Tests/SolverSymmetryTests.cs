using Electro;

namespace Electrostatics.Tests;

public sealed class SolverSymmetryTests
{
    [Fact]
    public void Dipole_IsAntisymmetricAcrossCenter()
    {
        var grid = new GridSpecDto { Nx = 201, Ny = 201 };
        var scene = new SceneDto
        {
            Domain = { XMin = -1f, XMax = 1f, YMin = -1f, YMax = 1f, Epsilon = 1f },
            Charges =
            {
                new PointChargeDto { X = -0.25f, Y = 0f, Q = +1f },
                new PointChargeDto { X = +0.25f, Y = 0f, Q = -1f }
            }
        };
        var solver = new SolverSpecDto { MaxIters = 4000, Tolerance = 1e-5f, Omega = 1.7f, ChargeSigmaCells = 1.0f };

        var residuals = new List<float>();
        var result = Solver.Solve(scene, grid, solver, residuals);

        AssertResidualMonotone(residuals);

        var phi = result.Phi;
        int nx = result.Nx, ny = result.Ny;

        float maxAntiSymError = 0f;
        for (int j = 1; j < ny - 1; j++)
        {
            for (int i = 1; i < nx / 2; i++)
            {
                float a = phi[Index(i, j, nx)];
                float b = phi[Index(nx - 1 - i, j, nx)];
                float err = MathF.Abs(a + b); // antisymmetry across x=0 plane
                if (err > maxAntiSymError) maxAntiSymError = err;
            }
        }

        Assert.True(maxAntiSymError < 1e-3f, $"dipole antisymmetry error too large: {maxAntiSymError}");
    }

    [Fact]
    public void CenteredCharge_IsAxisSymmetric_ResidualDecreases()
    {
        var grid = new GridSpecDto { Nx = 201, Ny = 201 };
        var scene = new SceneDto
        {
            Domain = { XMin = -1f, XMax = 1f, YMin = -1f, YMax = 1f, Epsilon = 1f },
            Charges = { new PointChargeDto { X = 0f, Y = 0f, Q = +1f } }
        };
        var solver = new SolverSpecDto { MaxIters = 3000, Tolerance = 5e-6f, Omega = 1.7f, ChargeSigmaCells = 1.0f };

        var residuals = new List<float>();
        var result = Solver.Solve(scene, grid, solver, residuals);

        AssertResidualMonotone(residuals);

        var phi = result.Phi;
        int nx = result.Nx, ny = result.Ny;

        float maxAxisSymError = 0f;
        for (int j = 1; j < ny - 1; j++)
        {
            for (int i = 1; i < nx / 2; i++)
            {
                float left = phi[Index(i, j, nx)];
                float right = phi[Index(nx - 1 - i, j, nx)];
                float errX = MathF.Abs(left - right);
                if (errX > maxAxisSymError) maxAxisSymError = errX;
            }
        }

        for (int i = 1; i < nx - 1; i++)
        {
            for (int j = 1; j < ny / 2; j++)
            {
                float bottom = phi[Index(i, j, nx)];
                float top = phi[Index(i, ny - 1 - j, nx)];
                float errY = MathF.Abs(bottom - top);
                if (errY > maxAxisSymError) maxAxisSymError = errY;
            }
        }

        Assert.True(maxAxisSymError < 1e-3f, $"axis symmetry error too large: {maxAxisSymError}");
    }

    private static int Index(int i, int j, int nx) => j * nx + i;

    private static void AssertResidualMonotone(IReadOnlyList<float> residuals)
    {
        Assert.True(residuals.Count > 1, "residual log should contain samples");
        for (int k = 1; k < residuals.Count; k++)
        {
            Assert.True(residuals[k] <= residuals[k - 1] + 1e-8f, $"residual increased at step {k}: {residuals[k - 1]} -> {residuals[k]}");
        }
    }
}
