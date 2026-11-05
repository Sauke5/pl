namespace Auditor.Api.Options;

public sealed class AuditorOptions
{
    public int Workers { get; set; } = 48;

    public int WarningPathLength { get; set; } = 180;

    public int BadPathLength { get; set; } = 220;

    public int CriticalPathLength { get; set; } = 240;

    public int LongNameLength { get; set; } = 100;

    public int MaxDepth { get; set; } = 12;

    public int BranchDepth { get; set; } = 4;

    public int ProgressEvery { get; set; } = 25_000;

    public int StoredBranchesPerDepartment { get; set; } = 30;

    public bool FollowReparsePoints { get; set; }

    public List<AuditRootOptions> Roots { get; set; } = new();
}

public sealed class AuditRootOptions
{
    public string Name { get; set; } = string.Empty;

    public string LocalPath { get; set; } = string.Empty;

    public string ServerUNC { get; set; } = string.Empty;

    public string DfsPath { get; set; } = string.Empty;
}
