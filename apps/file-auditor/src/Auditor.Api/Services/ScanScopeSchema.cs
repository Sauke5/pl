using Auditor.Data;
using Microsoft.EntityFrameworkCore;

namespace Auditor.Api.Services;

public static class ScanScopeSchema
{
    public static async Task EnsureCreatedAsync(IServiceProvider services)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AuditorDbContext>();
        await db.Database.MigrateAsync();
    }
}
