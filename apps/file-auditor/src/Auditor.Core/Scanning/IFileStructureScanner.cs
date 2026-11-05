using Auditor.Core.Scanning.Models;
namespace Auditor.Core.Scanning;

public interface IFileStructureScanner
{
    Task<ScanSummary> ScanAsync(
        ScanRequest request,
        IProgress<ScanProgress>? progress = null,
        CancellationToken cancellationToken = default);
}
