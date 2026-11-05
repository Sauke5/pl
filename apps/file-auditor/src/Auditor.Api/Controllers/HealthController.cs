using Auditor.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Auditor.Api.Options;
using Microsoft.Extensions.Options;

namespace Auditor.Api.Controllers;

[ApiController]
public sealed class HealthController : ControllerBase
{
    private readonly AuditorDbContext _db;
    private readonly IOptionsMonitor<AuditorOptions> _options;

    public HealthController(
        AuditorDbContext db,
        IOptionsMonitor<AuditorOptions> options)
    {
        _db = db;
        _options = options;
    }

    [HttpGet("/health")]
    public async Task<IActionResult> Health(
        CancellationToken cancellationToken)
    {
        var databaseOk =
            await _db.Database.CanConnectAsync(
                cancellationToken);

        var roots = _options.CurrentValue.Roots;
        var rootsOk = roots.Count > 0 &&
            roots.All(root => !string.IsNullOrWhiteSpace(root.LocalPath) && Directory.Exists(root.LocalPath));

        var payload =
            new
            {
                status =
                    databaseOk && rootsOk
                        ? "Healthy"
                        : "Degraded",
                database =
                    databaseOk
                        ? "OK"
                        : "FAILED",
                roots =
                    rootsOk
                        ? "OK"
                        : "FAILED"
            };

        return
            databaseOk && rootsOk
                ? Ok(payload)
                : StatusCode(
                    StatusCodes.Status503ServiceUnavailable,
                    payload);
    }
}
