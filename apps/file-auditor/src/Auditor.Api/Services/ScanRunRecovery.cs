using Auditor.Data;
using Microsoft.EntityFrameworkCore;

namespace Auditor.Api.Services;

public static class ScanRunRecovery
{
    public static async Task<int> MarkInterruptedAsync(IServiceProvider services)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AuditorDbContext>();
        var now = DateTime.UtcNow;
        return await db.AuditRuns
            .Where(run => run.Status == "Running")
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(run => run.Status, "Failed")
                .SetProperty(run => run.Failure, "Scan interrupted by service restart.")
                .SetProperty(run => run.FinishedAtUtc, now));
    }
}
