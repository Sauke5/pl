using System.Text.Json;
using System.Diagnostics;
using Auditor.Api.DTOs;
using Auditor.Api.Options;
using Auditor.Core.Scanning;
using Auditor.Core.Scanning.Engine;
using Auditor.Core.Scoring;
using Auditor.Data;
using Auditor.Data.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Auditor.Api.Services;

public sealed class ScanService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IOptionsMonitor<AuditorOptions> _options;
    private readonly ILogger<ScanService> _logger;
    private readonly SemaphoreSlim _singleScan = new(1, 1);
    private readonly object _stateLock = new();

    private ScanProgressDto? _current;

    public ScanService(
        IServiceScopeFactory scopeFactory,
        IOptionsMonitor<AuditorOptions> options,
        ILogger<ScanService> logger)
    {
        _scopeFactory = scopeFactory;
        _options = options;
        _logger = logger;
    }

    public ScanProgressDto? Current
    {
        get
        {
            lock (_stateLock)
                return _current;
        }
    }

    public async Task<ScanStartDto?> TryStartAsync(
        IReadOnlyList<string>? requestedRootNames,
        CancellationToken cancellationToken)
    {
        var config = _options.CurrentValue;
        var selectedRoots = ScanRootSelector.Select(config.Roots, requestedRootNames);
        if (!await _singleScan.WaitAsync(0, cancellationToken))
            return null;

        long scanId;

        try
        {
            await using var scope =
                _scopeFactory.CreateAsyncScope();

            var db =
                scope.ServiceProvider
                    .GetRequiredService<AuditorDbContext>();

            var run =
                new AuditRun
                {
                    StartedAtUtc = DateTime.UtcNow,
                    Status = "Running",
                    Workers = config.Workers,
                    SelectedRoots = selectedRoots.Select(root =>
                        new ScanRootSelection { RootName = root.Name }).ToList(),
                    Thresholds = new ScanThresholdSnapshot
                    {
                        WarningPathLength = config.WarningPathLength,
                        BadPathLength = config.BadPathLength,
                        CriticalPathLength = config.CriticalPathLength,
                        LongNameLength = config.LongNameLength,
                        MaxDepth = config.MaxDepth
                    }
                };

            db.AuditRuns.Add(run);

            await db.SaveChangesAsync(cancellationToken);

            scanId = run.Id;

            lock (_stateLock)
            {
                _current =
                    new ScanProgressDto(
                        scanId,
                        "Running",
                        run.StartedAtUtc,
                        0,
                        0,
                        0,
                        0,
                        0,
                        run.Workers,
                        0);
            }

            _ =
                Task.Run(
                    () => ExecuteAsync(scanId, config, selectedRoots),
                    CancellationToken.None);

            return new ScanStartDto(
                scanId,
                "Running");
        }
        catch
        {
            _singleScan.Release();
            throw;
        }
    }

    private async Task ExecuteAsync(
        long scanId,
        AuditorOptions config,
        IReadOnlyList<AuditRootOptions> selectedRoots)
    {
        var stopwatch =
            Stopwatch.StartNew();

        try
        {
            var roots =
                selectedRoots
                    .Where(
                        x =>
                            !string.IsNullOrWhiteSpace(
                                x.LocalPath))
                    .Select(
                        x =>
                            new RootMap
                            {
                                Label = x.Name,
                                LocalPath = x.LocalPath,
                                ServerUNC =
                                    string.IsNullOrWhiteSpace(x.ServerUNC)
                                        ? x.LocalPath
                                        : x.ServerUNC,
                                DFSPath =
                                    string.IsNullOrWhiteSpace(x.DfsPath)
                                        ? string.IsNullOrWhiteSpace(x.ServerUNC)
                                            ? x.LocalPath
                                            : x.ServerUNC
                                        : x.DfsPath
                            })
                    .ToArray();

            if (roots.Length == 0)
                throw new InvalidOperationException(
                    "No scan roots configured.");

            foreach (var root in roots)
            {
                if (!Directory.Exists(root.LocalPath))
                    throw new DirectoryNotFoundException(
                        $"Scan root does not exist: {root.LocalPath}");
            }

            var scanOptions =
                new ScanOptions
                {
                    Workers =
                        Math.Clamp(
                            config.Workers,
                            1,
                            256),

                    WarningPathLength =
                        config.WarningPathLength,

                    BadPathLength =
                        config.BadPathLength,

                    CriticalPathLength =
                        config.CriticalPathLength,

                    LongNameLength =
                        config.LongNameLength,

                    MaxDepth =
                        config.MaxDepth,

                    BranchDepth =
                        Math.Max(
                            1,
                            config.BranchDepth),

                    TopLongest = 100,

                    TopLongNames = 100,

                    TopDeepest = 100,

                    TopAnomalies = 200,

                    ProgressEvery =
                        Math.Max(
                            1_000,
                            config.ProgressEvery),

                    FollowReparsePoints =
                        config.FollowReparsePoints,

                    CaptureAllProblems = false
                };

            var scanner =
                new AuditScanner();

            var result =
                await Task.Run(
                    () =>
                        scanner.Scan(
                            roots,
                            scanOptions,
                            progress =>
                            {
                                var seconds =
                                    Math.Max(
                                        stopwatch.Elapsed.TotalSeconds,
                                        0.001);

                                var rate =
                                    (long)Math.Round(
                                        progress.ProcessedObjects /
                                        seconds);

                                ScanProgressDto state;

                                lock (_stateLock)
                                {
                                    state =
                                        new ScanProgressDto(
                                            scanId,
                                            "Running",
                                            _current?.StartedAtUtc
                                                ?? DateTime.UtcNow,
                                            progress.ProcessedObjects,
                                            progress.DirectoriesProcessed,
                                            progress.PendingDirectories,
                                            progress.QueueLength,
                                            progress.ActiveWorkers,
                                            progress.TotalWorkers,
                                            rate);

                                    _current = state;
                                }

                            }),
                    CancellationToken.None);

            stopwatch.Stop();

            await PersistResultAsync(
                scanId,
                result,
                config);

            var completed =
                new ScanProgressDto(
                    scanId,
                    "Completed",
                    Current?.StartedAtUtc
                        ?? DateTime.UtcNow,
                    result.TotalObjects,
                    result.DirectoriesProcessed,
                    0,
                    0,
                    0,
                    result.Workers,
                    result.Duration.TotalSeconds > 0
                        ? (long)Math.Round(
                            result.TotalObjects /
                            result.Duration.TotalSeconds)
                        : 0);

            lock (_stateLock)
                _current = completed;


            _logger.LogInformation(
                "Audit scan {ScanId} completed: {Objects} objects in {Duration} ms.",
                scanId,
                result.TotalObjects,
                result.Duration.TotalMilliseconds);
        }
        catch (Exception ex)
        {
            stopwatch.Stop();

            _logger.LogError(
                ex,
                "Audit scan {ScanId} failed.",
                scanId);

            await MarkFailedAsync(
                scanId,
                ex);

            ScanProgressDto failed;

            lock (_stateLock)
            {
                failed =
                    new ScanProgressDto(
                        scanId,
                        "Failed",
                        _current?.StartedAtUtc
                            ?? DateTime.UtcNow,
                        _current?.ProcessedObjects ?? 0,
                        _current?.DirectoriesProcessed ?? 0,
                        0,
                        0,
                        0,
                        _current?.TotalWorkers ?? 0,
                        _current?.ObjectsPerSecond ?? 0,
                        ex.Message);

                _current = failed;
            }

        }
        finally
        {
            _singleScan.Release();
        }
    }

    private async Task PersistResultAsync(
        long scanId,
        ScanResult result,
        AuditorOptions config)
    {
        await using var scope =
            _scopeFactory.CreateAsyncScope();

        var db =
            scope.ServiceProvider
                .GetRequiredService<AuditorDbContext>();

        var run =
            await db.AuditRuns
                .SingleAsync(
                    x => x.Id == scanId);

        run.FinishedAtUtc =
            DateTime.UtcNow;

        run.Status =
            "Completed";

        run.Workers =
            result.Workers;

        run.PeakActiveWorkers =
            result.PeakActiveWorkers;

        run.TotalObjects =
            result.TotalObjects;

        run.TotalFiles =
            result.TotalFiles;

        run.TotalDirectories =
            result.TotalDirectories;

        run.ProblemObjects =
            result.ProblemObjects;

        run.CriticalPaths =
            result.CriticalPaths;

        run.BadPaths =
            result.BadPaths;

        run.WarningPaths =
            result.WarningPaths;

        run.LongNames =
            result.LongNames;

        run.ExcessiveDepth =
            result.ExcessiveDepth;

        run.ErrorCount =
            result.Errors?.Count ?? 0;

        run.MaxPathLength =
            result.MaxRiskPathLength;

        run.MaxDepth =
            result.MaxDepth;

        run.ScannerDurationMs =
            (long)Math.Round(
                result.Duration.TotalMilliseconds);

        run.ObjectsPerSecond =
            result.Duration.TotalSeconds > 0
                ? (long)Math.Round(
                    result.TotalObjects /
                    result.Duration.TotalSeconds)
                : 0;

        run.HygieneScore =
            HygieneScoreCalculator.Calculate(
                result.TotalObjects,
                result.ProblemObjects,
                result.CriticalPaths,
                result.BadPaths);

        foreach (var department in result.Departments)
        {
            var key =
                $"{department.Label}/{department.TopFolder}";

            db.DepartmentSnapshots.Add(
                new DepartmentSnapshot
                {
                    AuditRunId = scanId,
                    RootLabel =
                        department.Label ?? string.Empty,
                    DepartmentKey = key,
                    DepartmentName =
                        department.TopFolder ?? "[ROOT]",
                    TotalObjects =
                        department.TotalObjects,
                    TotalFiles =
                        department.TotalFiles,
                    TotalDirectories =
                        department.TotalDirectories,
                    ProblemObjects =
                        department.ProblemObjects,
                    CriticalPaths =
                        department.CriticalPaths,
                    BadPaths =
                        department.BadPaths,
                    WarningPaths =
                        department.WarningPaths,
                    LongNames =
                        department.LongNames,
                    DeepPaths =
                        department.ExcessiveDepth,
                    CauseLongParent =
                        department.CauseLongParent,
                    CauseDeepTree =
                        department.CauseDeepTree,
                    CauseLongName =
                        department.CauseLongName,
                    CauseMixed =
                        department.CauseMixed,
                    MaxPathLength =
                        department.MaxRiskPathLength,
                    MaxPathRelative =
                        department.MaxRiskRelativePath,
                    MaxDepth =
                        department.MaxDepth,
                    HygieneScore =
                        HygieneScoreCalculator.Calculate(
                            department.TotalObjects,
                            department.ProblemObjects,
                            department.CriticalPaths,
                            department.BadPaths)
                });
        }

        var branchLimit =
            Math.Clamp(
                config.StoredBranchesPerDepartment,
                1,
                200);

        foreach (
            var departmentGroup in
            result.Branches
                .GroupBy(
                    x =>
                        new
                        {
                            x.Label,
                            x.TopFolder
                        })
        )
        {
            foreach (
                var branch in
                departmentGroup
                    .OrderByDescending(
                        x => x.CriticalPaths)
                    .ThenByDescending(
                        x => x.ProblemObjects)
                    .Take(branchLimit)
            )
            {
                db.BranchSnapshots.Add(
                    new BranchSnapshot
                    {
                        AuditRunId = scanId,
                        RootLabel =
                            branch.Label ?? string.Empty,
                        DepartmentKey =
                            $"{branch.Label}/{branch.TopFolder}",
                        DepartmentName =
                            branch.TopFolder ?? "[ROOT]",
                        RelativePath =
                            branch.Branch ?? string.Empty,
                        TotalObjects =
                            branch.TotalObjects,
                        ProblemObjects =
                            branch.ProblemObjects,
                        CriticalPaths =
                            branch.CriticalPaths,
                        BadPaths =
                            branch.BadPaths,
                        WarningPaths =
                            branch.WarningPaths,
                        LongNames =
                            branch.LongNames,
                        DeepPaths =
                            branch.ExcessiveDepth,
                        MaxPathLength =
                            branch.MaxRiskPathLength,
                        MaxDepth =
                            branch.MaxDepth,
                        ProblemLengthHistogramJson =
                            JsonSerializer.Serialize(
                                branch.ProblemLengthHistogram ??
                                new Dictionary<int, long>())
                    });
            }
        }

        PersistSampleCollection(
            db,
            scanId,
            result.DepartmentLongest,
            "Longest",
            int.MaxValue);

        PersistSampleCollection(
            db,
            scanId,
            result.DepartmentDeepest,
            "Deepest",
            int.MaxValue);

        PersistSampleCollection(
            db,
            scanId,
            result.DepartmentLongNamesTop,
            "LongName",
            int.MaxValue);

        var rootLookup =
            config.Roots
                .ToDictionary(
                    x => x.Name,
                    x => x,
                    StringComparer.OrdinalIgnoreCase);

        foreach (
            var sample in
            db.PathSampleSnapshots.Local
                .Where(x => x.AuditRunId == scanId))
        {
            if (
                !rootLookup.TryGetValue(
                    sample.RootLabel,
                    out var root))
            {
                continue;
            }

            static string CombineDisplayPath(
                string root,
                string relative)
            {
                if (string.IsNullOrWhiteSpace(root))
                    return relative;

                if (string.IsNullOrWhiteSpace(relative))
                    return root;

                return
                    root.TrimEnd('\\') +
                    "\\" +
                    relative.TrimStart('\\');
            }

            sample.DfsPath =
                CombineDisplayPath(
                    string.IsNullOrWhiteSpace(root.DfsPath)
                        ? string.IsNullOrWhiteSpace(root.ServerUNC)
                            ? root.LocalPath
                            : root.ServerUNC
                        : root.DfsPath,
                    sample.RelativePath);

            sample.UncPath =
                CombineDisplayPath(
                    string.IsNullOrWhiteSpace(root.ServerUNC)
                        ? root.LocalPath
                        : root.ServerUNC,
                    sample.RelativePath);

            if (
                sample.PathLength <= 0 &&
                !string.IsNullOrWhiteSpace(
                    sample.DfsPath))
            {
                sample.PathLength =
                    sample.DfsPath.Length;
            }
        }

        await db.SaveChangesAsync();
    }

    private static void PersistSampleCollection(
        AuditorDbContext db,
        long scanId,
        System.Collections.IEnumerable? source,
        string sampleKind,
        int limit)
    {
        if (source is null)
            return;

        var count = 0;

        foreach (var item in source)
        {
            if (item is null)
                continue;

            if (count++ >= limit)
                break;

            var type = item.GetType();

            object? GetValue(params string[] names)
            {
                foreach (var name in names)
                {
                    var property =
                        type.GetProperty(
                            name,
                            System.Reflection.BindingFlags.Public |
                            System.Reflection.BindingFlags.NonPublic |
                            System.Reflection.BindingFlags.Instance |
                            System.Reflection.BindingFlags.IgnoreCase);

                    if (property is not null)
                    {
                        var value = property.GetValue(item);
                        if (value is not null)
                            return value;
                    }

                    var field =
                        type.GetField(
                            name,
                            System.Reflection.BindingFlags.Public |
                            System.Reflection.BindingFlags.NonPublic |
                            System.Reflection.BindingFlags.Instance |
                            System.Reflection.BindingFlags.IgnoreCase);

                    if (field is not null)
                    {
                        var value = field.GetValue(item);
                        if (value is not null)
                            return value;
                    }
                }

                return null;
            }

            string GetString(params string[] names)
            {
                var value = GetValue(names);
                return value?.ToString() ?? string.Empty;
            }

            int GetInt(params string[] names)
            {
                var value = GetValue(names);

                if (value is null)
                    return 0;

                if (value is int intValue)
                    return intValue;

                if (value is long longValue)
                    return checked((int)Math.Min(longValue, int.MaxValue));

                return int.TryParse(
                    value.ToString(),
                    out var parsed)
                        ? parsed
                        : 0;
            }

            var label =
                GetString(
                    "Label",
                    "RootLabel");

            var topFolder =
                GetString(
                    "TopFolder",
                    "Department");

            var relative =
                GetString(
                    "RelativePath",
                    "Relative",
                    "Path",
                    "LocalDisplay",
                    "DisplayPath");

            var pathLength =
                GetInt(
                    "PathLength",
                    "Length",
                    "RiskPathLength",
                    "FullPathLength");

            var depth =
                GetInt(
                    "Depth",
                    "PathDepth",
                    "DirectoryDepth");

            var name =
                GetString(
                    "Name",
                    "FileName");

            var nameLength =
                GetInt(
                    "NameLength",
                    "FileNameLength");

            if (
                nameLength <= 0 &&
                !string.IsNullOrWhiteSpace(name))
            {
                nameLength = name.Length;
            }

            if (
                pathLength <= 0 &&
                !string.IsNullOrWhiteSpace(relative))
            {
                pathLength = relative.Length;
            }

            if (
                string.IsNullOrWhiteSpace(relative) &&
                string.IsNullOrWhiteSpace(name))
            {
                continue;
            }

            db.PathSampleSnapshots.Add(
                new PathSampleSnapshot
                {
                    AuditRunId = scanId,
                    RootLabel = label,
                    DepartmentKey =
                        $"{label}/{topFolder}",
                    DepartmentName =
                        string.IsNullOrWhiteSpace(topFolder)
                            ? "[ROOT]"
                            : topFolder,
                    SampleKind = sampleKind,
                    RelativePath = relative,
                    Name = NullIfEmpty(name),
                    Severity =
                        NullIfEmpty(
                            GetString(
                                "Severity")),
                    Cause =
                        NullIfEmpty(
                            GetString(
                                "Cause",
                                "Reason")),
                    PathLength = pathLength,
                    Depth = depth,
                    NameLength = nameLength
                });
        }
    }
    private static void PersistTypedDeepestIfMissing(
        AuditorDbContext db,
        long scanId,
        IEnumerable<Sample>? source,
        int limit)
    {
        if (source is null)
            return;

        if (
            db.PathSampleSnapshots.Local.Any(
                x =>
                    x.AuditRunId == scanId &&
                    x.SampleKind == "Deepest"))
        {
            return;
        }

        foreach (
            var sample in
            source
                .Where(x => x is not null)
                .OrderByDescending(x => x.Depth)
                .ThenByDescending(x => x.RiskPathLength)
                .Take(limit))
        {
            db.PathSampleSnapshots.Add(
                new PathSampleSnapshot
                {
                    AuditRunId = scanId,
                    RootLabel =
                        sample.Label ?? string.Empty,
                    DepartmentKey =
                        $"{sample.Label}/{sample.TopFolder}",
                    DepartmentName =
                        string.IsNullOrWhiteSpace(
                            sample.TopFolder)
                            ? "[ROOT]"
                            : sample.TopFolder,
                    SampleKind = "Deepest",
                    RelativePath =
                        sample.RelativePath ??
                        string.Empty,
                    Severity =
                        NullIfEmpty(
                            sample.Severity ??
                            string.Empty),
                    PathLength =
                        sample.RiskPathLength,
                    Depth =
                        sample.Depth,
                    NameLength =
                        sample.NameLength
                });
        }
    }
    private static string? NullIfEmpty(
        string value)
    {
        return string.IsNullOrWhiteSpace(value)
            ? null
            : value;
    }

    private async Task MarkFailedAsync(
        long scanId,
        Exception exception)
    {
        try
        {
            await using var scope =
                _scopeFactory.CreateAsyncScope();

            var db =
                scope.ServiceProvider
                    .GetRequiredService<AuditorDbContext>();

            var run =
                await db.AuditRuns
                    .SingleOrDefaultAsync(
                        x => x.Id == scanId);

            if (run is null)
                return;

            run.Status =
                "Failed";

            run.FinishedAtUtc =
                DateTime.UtcNow;

            run.Failure =
                exception.ToString();

            await db.SaveChangesAsync();
        }
        catch (Exception persistenceException)
        {
            _logger.LogError(
                persistenceException,
                "Could not persist failure state for scan {ScanId}.",
                scanId);
        }
    }
}
