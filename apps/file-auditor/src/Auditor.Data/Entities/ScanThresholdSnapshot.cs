namespace Auditor.Data.Entities;

public sealed class ScanThresholdSnapshot
{
    public long AuditRunId { get; set; }
    public AuditRun AuditRun { get; set; } = null!;
    public int WarningPathLength { get; set; }
    public int BadPathLength { get; set; }
    public int CriticalPathLength { get; set; }
    public int LongNameLength { get; set; }
    public int MaxDepth { get; set; }
}
