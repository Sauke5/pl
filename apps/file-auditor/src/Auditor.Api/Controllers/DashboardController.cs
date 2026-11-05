using Auditor.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Auditor.Api.Controllers;

[ApiController]
[Route("api/dashboard")]
public sealed class DashboardController : ControllerBase
{
    private readonly AuditorDbContext _db;
    public DashboardController(AuditorDbContext db) => _db = db;

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        var latest = await _db.AuditRuns.AsNoTracking()
            .Where(x => x.Status == "Completed")
            .OrderByDescending(x => x.Id)
            .FirstOrDefaultAsync(cancellationToken);

        return Ok(latest is null
            ? new { totalObjects = 0L, problemObjects = 0L, criticalPaths = 0L, hygieneScore = 100, lastScanUtc = (DateTime?)null }
            : new { latest.TotalObjects, latest.ProblemObjects, latest.CriticalPaths, latest.BadPaths, latest.WarningPaths, latest.MaxPathLength, latest.HygieneScore, lastScanUtc = latest.FinishedAtUtc });
    }
}
