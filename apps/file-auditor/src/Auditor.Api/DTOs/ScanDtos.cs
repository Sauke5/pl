namespace Auditor.Api.DTOs;

public sealed record ScanStartDto(
    long ScanId,
    string Status);

public sealed record ScanProgressDto(
    long ScanId,
    string Status,
    DateTime StartedAtUtc,
    long ProcessedObjects,
    long DirectoriesProcessed,
    long PendingDirectories,
    int QueueLength,
    int ActiveWorkers,
    int TotalWorkers,
    long ObjectsPerSecond,
    string? Error = null);

public sealed record ScanRunDto(
    long Id,
    DateTime StartedAtUtc,
    DateTime? FinishedAtUtc,
    string Status,
    int Workers,
    int PeakActiveWorkers,
    long TotalObjects,
    long TotalFiles,
    long TotalDirectories,
    long ProblemObjects,
    long CriticalPaths,
    long BadPaths,
    long WarningPaths,
    long ErrorCount,
    int MaxPathLength,
    int MaxDepth,
    int HygieneScore,
    long ScannerDurationMs,
    long ObjectsPerSecond,
    string? Failure);

public sealed record DepartmentDto(
    long Id,
    string RootLabel,
    string DepartmentKey,
    string DepartmentName,
    long TotalObjects,
    long ProblemObjects,
    double ProblemPercent,
    long CriticalPaths,
    long BadPaths,
    long WarningPaths,
    long LongNames,
    long DeepPaths,
    long CauseLongParent,
    long CauseDeepTree,
    long CauseLongName,
    long CauseMixed,
    int MaxPathLength,
    int MaxDepth,
    int HygieneScore);

public sealed record BranchDto(
    long Id,
    string RelativePath,
    long TotalObjects,
    long ProblemObjects,
    double ProblemPercent,
    long CriticalPaths,
    long BadPaths,
    long WarningPaths,
    int MaxPathLength,
    int MaxDepth);

public sealed record DepartmentHistoryPointDto(
    long ScanId,
    DateTime StartedAtUtc,
    int HygieneScore,
    long TotalObjects,
    long ProblemObjects,
    double ProblemPercent,
    long CriticalPaths,
    long BadPaths,
    long WarningPaths,
    int MaxPathLength,
    int MaxDepth);

public sealed record PathSampleDto(
    long Id,
    string SampleKind,
    string RelativePath,
    string? DfsPath,
    string? UncPath,
    string? Name,
    string? Severity,
    string? Cause,
    int PathLength,
    int Depth,
    int NameLength);

public sealed record DepartmentReportDto(
    DepartmentDto Department,
    long ScanId,
    DateTime ScanStartedAtUtc,
    DateTime? ScanFinishedAtUtc,
    DepartmentDeltaDto Delta,
    long OkPaths,
    long WarningPaths,
    long BadPaths,
    long CriticalPaths,
    IReadOnlyList<BranchDto> Branches,
    IReadOnlyList<PathSampleDto> LongestPaths,
    IReadOnlyList<PathSampleDto> DeepestPaths,
    IReadOnlyList<PathSampleDto> LongNames,
    IReadOnlyList<DepartmentHistoryPointDto> History);

public sealed record DepartmentDeltaDto(
    bool HasPrevious,
    long? PreviousScanId,
    int HygieneScoreDelta,
    long ProblemObjectsDelta,
    double ProblemPercentDelta,
    long CriticalPathsDelta,
    long BadPathsDelta,
    long WarningPathsDelta,
    int MaxPathLengthDelta);

public sealed record DepartmentListItemDto(
    DepartmentDto Department,
    DepartmentDeltaDto Delta);
