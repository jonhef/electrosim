using Electro;

namespace Electrostatics.Tests;

public sealed class ConductorDirichletTests
{
    [Fact]
    public void RectangleConductor_CellsStayAtFixedPotential()
    {
        const float fixedPhi = 0.75f;
        var grid = new GridSpecDto { Nx = 181, Ny = 181 };
        var scene = new SceneDto
        {
            Domain = { XMin = -1f, XMax = 1f, YMin = -1f, YMax = 1f, Epsilon = 1f },
            Charges = { new PointChargeDto { X = 0.55f, Y = 0.1f, Q = +1f } },
            Conductors =
            {
                new ConductorDto
                {
                    Kind = "rectangle",
                    Potential = fixedPhi,
                    XMin = -0.45f,
                    XMax = -0.15f,
                    YMin = -0.2f,
                    YMax = 0.3f
                }
            }
        };

        var solver = new SolverSpecDto { MaxIters = 2500, Tolerance = 1e-5f, Omega = 1.75f, ChargeSigmaCells = 1.0f };
        var result = Solver.Solve(scene, grid, solver);

        AssertMaskedPotentialIsFixed(result, fixedPhi, (x, y) =>
            x >= -0.45f && x <= -0.15f && y >= -0.2f && y <= 0.3f);
    }

    [Fact]
    public void CircleConductor_CellsStayAtFixedPotential()
    {
        const float fixedPhi = -0.4f;
        const float cx = 0.2f;
        const float cy = -0.1f;
        const float r = 0.28f;
        var r2 = r * r;

        var grid = new GridSpecDto { Nx = 201, Ny = 201 };
        var scene = new SceneDto
        {
            Domain = { XMin = -1f, XMax = 1f, YMin = -1f, YMax = 1f, Epsilon = 1f },
            Charges = { new PointChargeDto { X = -0.6f, Y = 0.0f, Q = +1f } },
            Conductors =
            {
                new ConductorDto
                {
                    Kind = "circle",
                    Potential = fixedPhi,
                    X = cx,
                    Y = cy,
                    Radius = r
                }
            }
        };

        var solver = new SolverSpecDto { MaxIters = 2500, Tolerance = 1e-5f, Omega = 1.75f, ChargeSigmaCells = 1.0f };
        var result = Solver.Solve(scene, grid, solver);

        AssertMaskedPotentialIsFixed(result, fixedPhi, (x, y) =>
        {
            var dx = x - cx;
            var dy = y - cy;
            return dx * dx + dy * dy <= r2;
        });
    }

    private static void AssertMaskedPotentialIsFixed(
        SolveResult result,
        float expectedPhi,
        Func<float, float, bool> insideMask)
    {
        var nx = result.Nx;
        var ny = result.Ny;
        var xMin = result.XMin;
        var yMin = result.YMin;
        var dx = (result.XMax - result.XMin) / (nx - 1);
        var dy = (result.YMax - result.YMin) / (ny - 1);

        var seen = 0;
        for (int j = 0; j < ny; j++)
        {
            var y = yMin + j * dy;
            for (int i = 0; i < nx; i++)
            {
                var x = xMin + i * dx;
                if (!insideMask(x, y)) continue;

                seen++;
                var v = result.Phi[j * nx + i];
                Assert.True(MathF.Abs(v - expectedPhi) < 1e-6f, $"masked cell not fixed: x={x}, y={y}, phi={v}");
            }
        }

        Assert.True(seen > 0, "mask should cover at least one grid cell");
    }
}
