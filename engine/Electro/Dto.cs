namespace Electro;

public sealed class SolveRequest
{
    public SceneDto? Scene { get; set; }
    public GridSpecDto? Grid { get; set; }
    public SolverSpecDto? Solver { get; set; }
}

public sealed class SolveResponse
{
    public string ResultId { get; set; } = "";
    public int Nx { get; set; }
    public int Ny { get; set; }

    public float XMin { get; set; }
    public float XMax { get; set; }
    public float YMin { get; set; }
    public float YMax { get; set; }

    public float PhiMin { get; set; }
    public float PhiMax { get; set; }

    public int Iterations { get; set; }
    public float Residual { get; set; }
}

public sealed class SceneDto
{
    public DomainDto Domain { get; set; } = new();
    public List<PointChargeDto> Charges { get; set; } = new();
    public List<ConductorDto> Conductors { get; set; } = new();
}

public sealed class DomainDto
{
    public float XMin { get; set; } = -1f;
    public float XMax { get; set; } = 1f;
    public float YMin { get; set; } = -1f;
    public float YMax { get; set; } = 1f;

    // eps0*epsr, but for mvp we just use eps = 1
    public float Epsilon { get; set; } = 1f;
}

public sealed class PointChargeDto
{
    public float X { get; set; }
    public float Y { get; set; }
    public float Q { get; set; } // arbitrary units in this mvp
}

// Conductor with fixed potential (Dirichlet).
// rectangle: Kind="rectangle", use XMin/XMax/YMin/YMax
// circle: Kind="circle", use X/Y/Radius
public sealed class ConductorDto
{
    public string Kind { get; set; } = "rectangle";
    public float Potential { get; set; } = 0f;

    // rectangle
    public float XMin { get; set; }
    public float XMax { get; set; }
    public float YMin { get; set; }
    public float YMax { get; set; }

    // circle
    public float X { get; set; }
    public float Y { get; set; }
    public float Radius { get; set; }
}

public sealed class GridSpecDto
{
    public int Nx { get; set; } = 256;
    public int Ny { get; set; } = 256;
}

public sealed class SolverSpecDto
{
    public int MaxIters { get; set; } = 800;
    public float Tolerance { get; set; } = 1e-4f;
    public float Omega { get; set; } = 1.85f; // sor relaxation
    public float ChargeSigmaCells { get; set; } = 1.25f; // gaussian deposit sigma in cell units
}

public sealed class SolveResult
{
    public required float[] Phi { get; init; }
    public required int Nx { get; init; }
    public required int Ny { get; init; }
    public required float XMin { get; init; }
    public required float XMax { get; init; }
    public required float YMin { get; init; }
    public required float YMax { get; init; }
    public required float PhiMin { get; init; }
    public required float PhiMax { get; init; }
    public required int Iterations { get; init; }
    public required float Residual { get; init; }
}
