namespace Auditor.Data.Entities;

public sealed class DepartmentSnapshot
{
    public long Id { get; set; }

    public long AuditRunId { get; set; }

    public AuditRun AuditRun { get; set; } = null!;

    public string RootLabel { get; set; } = string.Empty;

    public string DepartmentKey { get; set; } = string.Empty;

    public string DepartmentName { get; set; } = string.Empty;

    public long TotalObjects { get; set; }

    public long TotalFiles { get; set; }

    public long TotalDirectories { get; set; }

    public long ProblemObjects { get; set; }

    public long CriticalPaths { get; set; }

    public long BadPaths { get; set; }

    public long WarningPaths { get; set; }

    public long LongNames { get; set; }

    public long DeepPaths { get; set; }

    public long CauseLongParent { get; set; }

    public long CauseDeepTree { get; set; }

    public long CauseLongName { get; set; }

    public long CauseMixed { get; set; }

    public int MaxPathLength { get; set; }

    public string? MaxPathRelative { get; set; }

    public int MaxDepth { get; set; }

    public int HygieneScore { get; set; }
}
