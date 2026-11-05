using Auditor.Api.DTOs;
using Auditor.Api.Services;
using Auditor.Data;
using Auditor.Data.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Auditor.Api.Controllers;

[ApiController]
[Route("api/departments")]
public sealed class DepartmentsController : ControllerBase
{
    private readonly AuditorDbContext _db;

    public DepartmentsController(
        AuditorDbContext db)
    {
        _db = db;
    }

    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<DepartmentListItemDto>>> GetLatest(
        CancellationToken cancellationToken)
    {
        var runs =
            await _db.AuditRuns
                .AsNoTracking()
                .Where(x => x.Status == "Completed")
                .OrderByDescending(x => x.Id)
                .Take(2)
                .ToListAsync(cancellationToken);

        if (runs.Count == 0)
            return Ok(Array.Empty<DepartmentListItemDto>());

        var latestRun = runs[0];

        var current =
            await _db.DepartmentSnapshots
                .AsNoTracking()
                .Where(x => x.AuditRunId == latestRun.Id)
                .Where(x => x.ProblemObjects > 0)
                .OrderByDescending(x => x.CriticalPaths)
                .ThenByDescending(x => x.ProblemObjects)
                .ToListAsync(cancellationToken);

        Dictionary<string, DepartmentSnapshot> previousByKey =
            new(StringComparer.OrdinalIgnoreCase);

        long? previousRunId = null;

        if (runs.Count > 1 && (await ScanComparability.FindComparableIdsAsync(
                _db, latestRun.Id, [runs[1].Id], cancellationToken)).Contains(runs[1].Id))
        {
            previousRunId = runs[1].Id;

            previousByKey =
                await _db.DepartmentSnapshots
                    .AsNoTracking()
                    .Where(x => x.AuditRunId == previousRunId.Value)
                    .ToDictionaryAsync(
                        x => x.DepartmentKey,
                        StringComparer.OrdinalIgnoreCase,
                        cancellationToken);
        }

        return Ok(
            current.Select(
                department =>
                {
                    previousByKey.TryGetValue(
                        department.DepartmentKey,
                        out var previous);

                    return new DepartmentListItemDto(
                        Map(department),
                        Delta(
                            department,
                            previous,
                            previousRunId));
                }));
    }

    [HttpGet("{id:long}")]
    public async Task<ActionResult<DepartmentReportDto>> GetReport(
        long id,
        CancellationToken cancellationToken)
    {
        var department =
            await _db.DepartmentSnapshots
                .AsNoTracking()
                .SingleOrDefaultAsync(
                    x => x.Id == id,
                    cancellationToken);

        if (department is null)
            return NotFound();

        var run =
            await _db.AuditRuns
                .AsNoTracking()
                .SingleAsync(
                    x => x.Id == department.AuditRunId,
                    cancellationToken);

        var previous =
            await _db.DepartmentSnapshots
                .AsNoTracking()
                .Where(x => x.DepartmentKey == department.DepartmentKey)
                .Where(x => x.AuditRunId < department.AuditRunId)
                .OrderByDescending(x => x.AuditRunId)
                .FirstOrDefaultAsync(cancellationToken);

        if (previous is not null && !(await ScanComparability.FindComparableIdsAsync(
                _db, run.Id, [previous.AuditRunId], cancellationToken)).Contains(previous.AuditRunId))
            previous = null;

        var branches =
            await _db.BranchSnapshots
                .AsNoTracking()
                .Where(
                    x =>
                        x.AuditRunId == department.AuditRunId &&
                        x.DepartmentKey == department.DepartmentKey)
                .OrderByDescending(x => x.CriticalPaths)
                .ThenByDescending(x => x.ProblemObjects)
                .Take(30)
                .ToListAsync(cancellationToken);

        var samples =
            await _db.PathSampleSnapshots
                .AsNoTracking()
                .Where(
                    x =>
                        x.AuditRunId == department.AuditRunId &&
                        x.DepartmentKey == department.DepartmentKey)
                .ToListAsync(cancellationToken);

        var history =
            await _db.DepartmentSnapshots
                .AsNoTracking()
                .Where(x => x.DepartmentKey == department.DepartmentKey)
                .Join(
                    _db.AuditRuns.AsNoTracking(),
                    snapshot => snapshot.AuditRunId,
                    scan => scan.Id,
                    (snapshot, scan) =>
                        new
                        {
                            Snapshot = snapshot,
                            Run = scan
                        })
                .Where(x => x.Run.Status == "Completed")
                .OrderByDescending(x => x.Run.StartedAtUtc)
                .Take(30)
                .OrderBy(x => x.Run.StartedAtUtc)
                .ToListAsync(cancellationToken);

        var comparableHistory = await ScanComparability.FindComparableIdsAsync(
            _db, run.Id, history.Select(x => x.Run.Id), cancellationToken);
        history = history.Where(x => x.Run.Id == run.Id || comparableHistory.Contains(x.Run.Id)).ToList();

        var classified =
            department.WarningPaths +
            department.BadPaths +
            department.CriticalPaths;

        var okPaths =
            Math.Max(
                0,
                department.TotalObjects - classified);

        return Ok(
            new DepartmentReportDto(
                Map(department),
                run.Id,
                run.StartedAtUtc,
                run.FinishedAtUtc,
                Delta(
                    department,
                    previous,
                    previous?.AuditRunId),
                okPaths,
                department.WarningPaths,
                department.BadPaths,
                department.CriticalPaths,
                branches.Select(MapBranch).ToArray(),
                samples
                    .Where(x => x.SampleKind == "Longest")
                    .OrderByDescending(x => x.PathLength)
                    .ThenByDescending(x => x.Depth)
                    .Take(30)
                    .Select(MapSample)
                    .ToArray(),
                samples
                    .Where(x => x.SampleKind == "Deepest")
                    .OrderByDescending(x => x.Depth)
                    .ThenByDescending(x => x.PathLength)
                    .Take(30)
                    .Select(MapSample)
                    .ToArray(),
                samples
                    .Where(x => x.SampleKind == "LongName")
                    .OrderByDescending(x => x.NameLength)
                    .ThenByDescending(x => x.PathLength)
                    .Take(30)
                    .Select(MapSample)
                    .ToArray(),
                history
                    .Select(
                        x =>
                            new DepartmentHistoryPointDto(
                                x.Run.Id,
                                x.Run.StartedAtUtc,
                                x.Snapshot.HygieneScore,
                                x.Snapshot.TotalObjects,
                                x.Snapshot.ProblemObjects,
                                Percent(
                                    x.Snapshot.ProblemObjects,
                                    x.Snapshot.TotalObjects),
                                x.Snapshot.CriticalPaths,
                                x.Snapshot.BadPaths,
                                x.Snapshot.WarningPaths,
                                x.Snapshot.MaxPathLength,
                                x.Snapshot.MaxDepth))
                    .ToArray()));
    }

    private static DepartmentDeltaDto Delta(
        DepartmentSnapshot current,
        DepartmentSnapshot? previous,
        long? previousRunId)
    {
        if (previous is null)
        {
            return new DepartmentDeltaDto(
                false,
                previousRunId,
                0,
                0,
                0,
                0,
                0,
                0,
                0);
        }

        return new DepartmentDeltaDto(
            true,
            previous.AuditRunId,
            current.HygieneScore - previous.HygieneScore,
            current.ProblemObjects - previous.ProblemObjects,
            Math.Round(
                Percent(
                    current.ProblemObjects,
                    current.TotalObjects) -
                Percent(
                    previous.ProblemObjects,
                    previous.TotalObjects),
                2),
            current.CriticalPaths - previous.CriticalPaths,
            current.BadPaths - previous.BadPaths,
            current.WarningPaths - previous.WarningPaths,
            current.MaxPathLength - previous.MaxPathLength);
    }

    private static DepartmentDto Map(
        DepartmentSnapshot x)
    {
        return new DepartmentDto(
            x.Id,
            x.RootLabel,
            x.DepartmentKey,
            x.DepartmentName,
            x.TotalObjects,
            x.ProblemObjects,
            Percent(x.ProblemObjects, x.TotalObjects),
            x.CriticalPaths,
            x.BadPaths,
            x.WarningPaths,
            x.LongNames,
            x.DeepPaths,
            x.CauseLongParent,
            x.CauseDeepTree,
            x.CauseLongName,
            x.CauseMixed,
            x.MaxPathLength,
            x.MaxDepth,
            x.HygieneScore);
    }

    private static BranchDto MapBranch(
        BranchSnapshot x)
    {
        return new BranchDto(
            x.Id,
            x.RelativePath,
            x.TotalObjects,
            x.ProblemObjects,
            Percent(x.ProblemObjects, x.TotalObjects),
            x.CriticalPaths,
            x.BadPaths,
            x.WarningPaths,
            x.MaxPathLength,
            x.MaxDepth);
    }

    private static PathSampleDto MapSample(
        PathSampleSnapshot x)
    {
        return new PathSampleDto(
            x.Id,
            x.SampleKind,
            x.RelativePath,
            x.DfsPath,
            x.UncPath,
            x.Name,
            x.Severity,
            x.Cause,
            x.PathLength,
            x.Depth,
            x.NameLength);
    }

    private static double Percent(
        long part,
        long total)
    {
        if (total <= 0)
            return 0;

        return Math.Round(
            part * 100d / total,
            2);
    }
}
