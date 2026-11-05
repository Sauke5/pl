namespace Auditor.Data.Entities;

public sealed class ScanRootSelection
{
    public long AuditRunId { get; set; }
    public string RootName { get; set; } = string.Empty;
    public AuditRun AuditRun { get; set; } = null!;
}
