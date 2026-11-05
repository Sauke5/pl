namespace Auditor.Core.Scanning.Models;

public sealed record ScanRoot(string Name, string LocalPath, string DfsPath);

public sealed record ScanRequest(IReadOnlyCollection<ScanRoot> Roots, int Workers = 48);

public sealed record ScanProgress(
    long ProcessedObjects,
    long ProcessedDirectories,
    long PendingDirectories,
    int ActiveWorkers,
    int TotalWorkers,
    double ObjectsPerSecond);

public sealed class ScanSummary
{
    public long TotalObjects { get; init; }
    public long TotalFiles { get; init; }
    public long TotalDirectories { get; init; }
    public long ProblemObjects { get; init; }
    public long WarningPaths { get; init; }
    public long BadPaths { get; init; }
    public long CriticalPaths { get; init; }
    public int MaxPathLength { get; init; }
    public int MaxDepth { get; init; }
    public double DurationSeconds { get; init; }
}
