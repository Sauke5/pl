namespace Auditor.Data.Entities;

public sealed class AuditRun
{
    public long Id { get; set; }

    public DateTime StartedAtUtc { get; set; }

    public DateTime? FinishedAtUtc { get; set; }

    public string Status { get; set; } = "Pending";

    public string? Failure { get; set; }

    public int Workers { get; set; }

    public int PeakActiveWorkers { get; set; }

    public long TotalObjects { get; set; }

    public long TotalFiles { get; set; }

    public long TotalDirectories { get; set; }

    public long ProblemObjects { get; set; }

    public long CriticalPaths { get; set; }

    public long BadPaths { get; set; }

    public long WarningPaths { get; set; }

    public long LongNames { get; set; }

    public long ExcessiveDepth { get; set; }

    public long ErrorCount { get; set; }

    public int MaxPathLength { get; set; }

    public int MaxDepth { get; set; }

    public int HygieneScore { get; set; }

    public long ScannerDurationMs { get; set; }

    public long ObjectsPerSecond { get; set; }

    public ICollection<DepartmentSnapshot> Departments { get; set; }
        = new List<DepartmentSnapshot>();

    public ICollection<BranchSnapshot> Branches { get; set; }
        = new List<BranchSnapshot>();

    public ICollection<PathSampleSnapshot> Samples { get; set; }
        = new List<PathSampleSnapshot>();

    public ICollection<ScanRootSelection> SelectedRoots { get; set; }
        = new List<ScanRootSelection>();

    public ScanThresholdSnapshot? Thresholds { get; set; }
}
