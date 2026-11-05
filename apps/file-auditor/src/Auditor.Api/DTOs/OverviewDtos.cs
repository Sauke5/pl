namespace Auditor.Api.DTOs;

public sealed record AuditRootDto(
    string Name,
    string LocalPath,
    string ServerUNC,
    string DfsPath);

public sealed record AuditThresholdsDto(
    int WarningPathLength,
    int BadPathLength,
    int CriticalPathLength,
    int LongNameLength,
    int MaxDepth);

public sealed record InstanceDto(
    string MachineName,
    IReadOnlyList<AuditRootDto> Roots,
    AuditThresholdsDto Thresholds,
    long? LatestCompletedScanId,
    DateTime? LatestCompletedScanFinishedAtUtc,
    IReadOnlyList<string> LatestCompletedRootNames);

public sealed record FindingDto(
    long Id,
    string RootLabel,
    long? DepartmentId,
    string DepartmentKey,
    string DepartmentName,
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

public sealed record FindingsPageDto(
    long? ScanId,
    DateTime? ScanFinishedAtUtc,
    bool IsSample,
    string ScopeNote,
    int Page,
    int PageSize,
    int Total,
    IReadOnlyList<FindingDto> Items,
    AuditThresholdsDto? Thresholds = null);
