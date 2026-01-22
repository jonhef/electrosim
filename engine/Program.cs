using Electro;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyOrigin()
              .AllowAnyHeader()
              .AllowAnyMethod());
});

var app = builder.Build();
app.UseCors();

app.MapGet("/health", () => Results.Ok(new { ok = true }));

// solve returns meta json (grid, min/max) and an id to fetch binary phi
var store = new ResultStore();

app.MapPost("/solve", (SolveRequest req) =>
{
    var scene = req.Scene ?? new SceneDto();
    var grid = req.Grid ?? new GridSpecDto();
    var solver = req.Solver ?? new SolverSpecDto();

    var result = Solver.Solve(scene, grid, solver);

    var id = store.Put(result.Phi);

    return Results.Ok(new SolveResponse
    {
        ResultId = id,
        Nx = result.Nx,
        Ny = result.Ny,
        XMin = result.XMin,
        XMax = result.XMax,
        YMin = result.YMin,
        YMax = result.YMax,
        PhiMin = result.PhiMin,
        PhiMax = result.PhiMax,
        Iterations = result.Iterations,
        Residual = result.Residual
    });
});

app.MapGet("/result/{id}/phi", (string id) =>
{
    if (!store.TryGet(id, out var phi))
        return Results.NotFound();

    // return float32 little endian raw
    return Results.File(phi, "application/octet-stream");
});

app.Run();

sealed class ResultStore
{
    private readonly Dictionary<string, byte[]> _map = new();
    private readonly object _lock = new();

    public string Put(float[] phi)
    {
        var bytes = new byte[phi.Length * sizeof(float)];
        Buffer.BlockCopy(phi, 0, bytes, 0, bytes.Length);

        var id = Guid.NewGuid().ToString("N");

        lock (_lock)
        {
            _map[id] = bytes;

            // tiny eviction: keep last ~20
            if (_map.Count > 20)
            {
                var first = _map.Keys.First();
                _map.Remove(first);
            }
        }
        return id;
    }

    public bool TryGet(string id, out byte[] bytes)
    {
        lock (_lock) return _map.TryGetValue(id, out bytes!);
    }
}
