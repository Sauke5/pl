namespace Auditor.Data.Entities;

public sealed class PathSampleSnapshot
{
    public long Id { get; set; }

    public long AuditRunId { get; set; }

    public AuditRun AuditRun { get; set; } = null!;

    public string RootLabel { get; set; } = string.Empty;

    public string DepartmentKey { get; set; } = string.Empty;

    public string DepartmentName { get; set; } = string.Empty;

    public string SampleKind { get; set; } = string.Empty;

    public string RelativePath { get; set; } = string.Empty;

    public string? DfsPath { get; set; }

    public string? UncPath { get; set; }

    public string? Name { get; set; }

    public string? Severity { get; set; }

    public string? Cause { get; set; }

    public int PathLength { get; set; }

    public int Depth { get; set; }

    public int NameLength { get; set; }
}
