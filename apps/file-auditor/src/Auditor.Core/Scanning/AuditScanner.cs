using Auditor.Core.Scanning.Engine;

namespace Auditor.Core.Scanning;

public sealed class AuditScanner
{
    public ScanResult Scan(
        IReadOnlyCollection<RootMap> roots,
        ScanOptions options,
        Action<ProgressSnapshot>? progress = null)
    {
        ArgumentNullException.ThrowIfNull(roots);
        ArgumentNullException.ThrowIfNull(options);

        if (roots.Count == 0)
            throw new ArgumentException(
                "At least one scan root is required.",
                nameof(roots));

        ExtremeScanner.ProgressChanged =
            progress;

        try
        {
            return ExtremeScanner.Scan(
                roots.ToArray(),
                options);
        }
        finally
        {
            ExtremeScanner.ProgressChanged =
                null;
        }
    }
}
