using Auditor.Api.DTOs;
using Auditor.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Auditor.Api.Controllers;

[ApiController]
[Route("api/findings")]
public sealed class FindingsController : ControllerBase
{
    private const string ScopeNote =
        "Stored path samples from the latest completed scan; this is not a full file catalog or all findings.";
    private readonly AuditorDbContext _db;

    public FindingsController(AuditorDbContext db) => _db = db;

    [HttpGet]
    public async Task<ActionResult<FindingsPageDto>> Get(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 50,
        [FromQuery] string? department = null,
        [FromQuery] string? severity = null,
        [FromQuery] string? kind = null,
        CancellationToken cancellationToken = default)
    {
        if (page < 1 || page > 10_000 || pageSize < 1 || pageSize > 100)
            return BadRequest("Page must be 1–10000 and pageSize must be 1–100.");

        severity = severity?.Trim().ToUpperInvariant();
        kind = kind?.Trim();
        department = department?.Trim();

        if (severity is not null &&
            severity is not ("CRITICAL" or "BAD" or "WARNING" or "OK"))
            return BadRequest("Unknown severity.");

        kind = kind?.ToLowerInvariant() switch
        {
            "longest" => "Longest",
            "deepest" => "Deepest",
            "longname" => "LongName",
            null => null,
            _ => kind
        };
        if (kind is not null && kind is not ("Longest" or "Deepest" or "LongName"))
            return BadRequest("Unknown sample kind.");

        var latest = await _db.AuditRuns
            .AsNoTracking()
            .Where(x => x.Status == "Completed")
            .OrderByDescending(x => x.Id)
            .Select(x => new { x.Id, x.FinishedAtUtc })
            .FirstOrDefaultAsync(cancellationToken);

        if (latest is null)
            return Ok(new FindingsPageDto(
                null, null, true, ScopeNote, page, pageSize, 0,
                Array.Empty<FindingDto>()));

        var thresholds = await _db.ScanThresholdSnapshots.AsNoTracking()
            .Where(x => x.AuditRunId == latest.Id)
            .Select(x => new AuditThresholdsDto(
                x.WarningPathLength, x.BadPathLength, x.CriticalPathLength,
                x.LongNameLength, x.MaxDepth))
            .FirstOrDefaultAsync(cancellationToken);

        var samples = _db.PathSampleSnapshots
            .AsNoTracking()
            .Where(x => x.AuditRunId == latest.Id);

        if (!string.IsNullOrWhiteSpace(department))
            samples = samples.Where(x => x.DepartmentKey == department);
        if (severity is not null)
            samples = samples.Where(x => x.Severity == severity);
        if (kind is not null)
            samples = samples.Where(x => x.SampleKind == kind);

        // Each path may be sampled as Longest, Deepest and LongName. Keep one
        // representative row before counting and paging; never imply a full catalog.
        var representativeIds = samples
            .GroupBy(x => new { x.RootLabel, x.RelativePath })
            .Select(group => group.Min(x => x.Id));

        var unique = samples.Where(x => representativeIds.Contains(x.Id));
        var total = await unique.CountAsync(cancellationToken);
        var items = await unique
            .OrderByDescending(x => x.Severity == "CRITICAL" ? 3 :
                x.Severity == "BAD" ? 2 :
                x.Severity == "WARNING" ? 1 : 0)
            .ThenByDescending(x => x.PathLength)
            .ThenBy(x => x.Id)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(x => new FindingDto(
                x.Id, x.RootLabel,
                _db.DepartmentSnapshots
                    .Where(d => d.AuditRunId == latest.Id &&
                        d.DepartmentKey == x.DepartmentKey)
                    .Select(d => (long?)d.Id)
                    .FirstOrDefault(),
                x.DepartmentKey, x.DepartmentName,
                x.SampleKind, x.RelativePath, x.DfsPath, x.UncPath,
                x.Name, x.Severity, x.Cause, x.PathLength, x.Depth,
                x.NameLength))
            .ToListAsync(cancellationToken);

        return Ok(new FindingsPageDto(
            latest.Id, latest.FinishedAtUtc, true, ScopeNote,
            page, pageSize, total, items, thresholds));
    }
}
