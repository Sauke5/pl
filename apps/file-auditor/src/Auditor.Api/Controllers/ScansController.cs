using Auditor.Api.DTOs;
using Auditor.Api.Services;
using Auditor.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System.Text.Json;

namespace Auditor.Api.Controllers;

[ApiController]
[Route("api/scans")]
public sealed class ScansController : ControllerBase
{
    private readonly ScanService _scanService;
    private readonly AuditorDbContext _db;

    public ScansController(
        ScanService scanService,
        AuditorDbContext db)
    {
        _scanService = scanService;
        _db = db;
    }

    [HttpPost]
    public async Task<ActionResult<ScanStartDto>> Start(
        CancellationToken cancellationToken)
    {
        IReadOnlyList<string>? requestedRoots = null;
        using var body = new MemoryStream();
        await Request.Body.CopyToAsync(body, cancellationToken);
        if (body.Length > 8_192)
            return StatusCode(StatusCodes.Status413PayloadTooLarge);
        if (body.Length > 0)
        {
            if (Request.ContentType is null ||
                !Request.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
                return StatusCode(StatusCodes.Status415UnsupportedMediaType);
            try
            {
                body.Position = 0;
                using var document = await JsonDocument.ParseAsync(body, cancellationToken: cancellationToken);
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object ||
                    root.EnumerateObject().Count() != 1 ||
                    !root.TryGetProperty("rootNames", out var names) ||
                    names.ValueKind != JsonValueKind.Array ||
                    names.GetArrayLength() > 64 ||
                    names.EnumerateArray().Any(item => item.ValueKind != JsonValueKind.String))
                    return BadRequest("Expected rootNames array of configured root names.");
                requestedRoots = names.EnumerateArray().Select(item => item.GetString()!).ToArray();
            }
            catch (JsonException)
            {
                return BadRequest("Invalid scan root selection JSON.");
            }
        }

        ScanStartDto? result;
        try
        {
            result = await _scanService.TryStartAsync(requestedRoots, cancellationToken);
        }
        catch (InvalidScanRootsException error)
        {
            return BadRequest(error.Message);
        }

        if (result is null)
        {
            return Conflict(
                new
                {
                    message =
                        "A scan is already running.",
                    current =
                        _scanService.Current
                });
        }

        return Accepted(result);
    }

    [HttpGet("current")]
    public ActionResult<ScanProgressDto?> Current()
    {
        var current =
            _scanService.Current;

        if (
            current is null ||
            !string.Equals(
                current.Status,
                "Running",
                StringComparison.OrdinalIgnoreCase))
        {
            return NoContent();
        }

        return Ok(current);
    }

    [HttpGet("latest")]
    public async Task<ActionResult<ScanRunDto?>> Latest(
        CancellationToken cancellationToken)
    {
        var run =
            await _db.AuditRuns
                .AsNoTracking()
                .OrderByDescending(x => x.Id)
                .FirstOrDefaultAsync(
                    cancellationToken);

        if (run is null)
            return Ok(null);

        return Ok(Map(run));
    }

    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<ScanRunDto>>> History(
        [FromQuery] int take = 30,
        [FromQuery] bool completedOnly = false,
        CancellationToken cancellationToken = default)
    {
        take =
            Math.Clamp(
                take,
                1,
                365);

        var query = _db.AuditRuns.AsNoTracking();
        if (completedOnly)
            query = query.Where(x => x.Status == "Completed");

        var runs =
            await query
                .OrderByDescending(x => x.Id)
                .Take(take)
                .ToListAsync(
                    cancellationToken);

        return Ok(
            runs.Select(Map).ToArray());
    }

    private static ScanRunDto Map(
        Auditor.Data.Entities.AuditRun run)
    {
        return new ScanRunDto(
            run.Id,
            run.StartedAtUtc,
            run.FinishedAtUtc,
            run.Status,
            run.Workers,
            run.PeakActiveWorkers,
            run.TotalObjects,
            run.TotalFiles,
            run.TotalDirectories,
            run.ProblemObjects,
            run.CriticalPaths,
            run.BadPaths,
            run.WarningPaths,
            run.ErrorCount,
            run.MaxPathLength,
            run.MaxDepth,
            run.HygieneScore,
            run.ScannerDurationMs,
            run.ObjectsPerSecond,
            run.Failure);
    }
}
