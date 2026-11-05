using Auditor.Api.DTOs;
using Auditor.Api.Options;
using Auditor.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Auditor.Api.Controllers;

[ApiController]
[Route("api/instance")]
public sealed class InstanceController : ControllerBase
{
    private readonly AuditorDbContext _db;
    private readonly IOptionsMonitor<AuditorOptions> _options;

    public InstanceController(AuditorDbContext db, IOptionsMonitor<AuditorOptions> options)
    {
        _db = db;
        _options = options;
    }

    [HttpGet]
    public async Task<ActionResult<InstanceDto>> Get(CancellationToken cancellationToken)
    {
        var latest = await _db.AuditRuns
            .AsNoTracking()
            .Where(x => x.Status == "Completed")
            .OrderByDescending(x => x.Id)
            .Select(x => new { x.Id, x.FinishedAtUtc })
            .FirstOrDefaultAsync(cancellationToken);

        var selectedRoots = latest is null
            ? Array.Empty<string>()
            : await _db.ScanRootSelections.AsNoTracking()
                .Where(x => x.AuditRunId == latest.Id)
                .OrderBy(x => x.RootName)
                .Select(x => x.RootName)
                .ToArrayAsync(cancellationToken);

        var settings = _options.CurrentValue;
        return Ok(new InstanceDto(
            Environment.MachineName,
            settings.Roots.Select(x => new AuditRootDto(
                x.Name, x.LocalPath, x.ServerUNC, x.DfsPath)).ToArray(),
            new AuditThresholdsDto(
                settings.WarningPathLength,
                settings.BadPathLength,
                settings.CriticalPathLength,
                settings.LongNameLength,
                settings.MaxDepth),
            latest?.Id,
            latest?.FinishedAtUtc,
            selectedRoots));
    }
}
