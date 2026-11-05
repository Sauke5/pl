using Auditor.Api.Services;
using Auditor.Data;
using Auditor.Data.Entities;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;

namespace Auditor.Tests.Api;

public sealed class ScanScopeSchemaTests
{
    [Fact]
    public async Task FreshDatabaseHasAuditTablesAndRootSelections()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var services = new ServiceCollection()
            .AddDbContext<AuditorDbContext>(options => options.UseSqlite(connection))
            .BuildServiceProvider();

        await ScanScopeSchema.EnsureCreatedAsync(services);

        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AuditorDbContext>();
        Assert.Empty(await db.AuditRuns.ToListAsync(TestContext.Current.CancellationToken));
        Assert.Empty(await db.ScanRootSelections.ToListAsync(TestContext.Current.CancellationToken));
        Assert.Empty(await db.ScanThresholdSnapshots.ToListAsync(TestContext.Current.CancellationToken));
        Assert.NotEmpty(await db.Database.GetAppliedMigrationsAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task ExistingScanHistoryIsMigratedOnceAndPreserved()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var services = new ServiceCollection()
            .AddDbContext<AuditorDbContext>(options => options.UseSqlite(connection))
            .BuildServiceProvider();

        await using (var setup = services.CreateAsyncScope())
        {
            var db = setup.ServiceProvider.GetRequiredService<AuditorDbContext>();
            var migrator = db.Database.GetService<IMigrator>();
            await migrator.MigrateAsync("20260828073739_Stage5RemediationIntelligence", TestContext.Current.CancellationToken);
            db.AuditRuns.Add(new AuditRun { Id = 16, Status = "Completed" });
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        }

        await ScanScopeSchema.EnsureCreatedAsync(services);
        await ScanScopeSchema.EnsureCreatedAsync(services);

        await using var check = services.CreateAsyncScope();
        var database = check.ServiceProvider.GetRequiredService<AuditorDbContext>();
        Assert.Equal(16, (await database.AuditRuns.SingleAsync(TestContext.Current.CancellationToken)).Id);
        Assert.Empty(await database.ScanRootSelections.ToListAsync(TestContext.Current.CancellationToken));
        Assert.Empty(await database.ScanThresholdSnapshots.ToListAsync(TestContext.Current.CancellationToken));
        Assert.Contains("20261007151324_ScanScopeSnapshot", await database.Database.GetAppliedMigrationsAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task StartupMarksOnlyOrphanedRunningScansAsFailed()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var services = new ServiceCollection()
            .AddDbContext<AuditorDbContext>(options => options.UseSqlite(connection))
            .BuildServiceProvider();
        await ScanScopeSchema.EnsureCreatedAsync(services);
        await using (var setup = services.CreateAsyncScope())
        {
            var db = setup.ServiceProvider.GetRequiredService<AuditorDbContext>();
            db.AuditRuns.AddRange(
                new AuditRun { Id = 1, Status = "Running" },
                new AuditRun { Id = 2, Status = "Completed" });
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        }

        Assert.Equal(1, await ScanRunRecovery.MarkInterruptedAsync(services));
        Assert.Equal(0, await ScanRunRecovery.MarkInterruptedAsync(services));

        await using var check = services.CreateAsyncScope();
        var runs = await check.ServiceProvider.GetRequiredService<AuditorDbContext>()
            .AuditRuns.OrderBy(run => run.Id).ToArrayAsync(TestContext.Current.CancellationToken);
        Assert.Equal("Failed", runs[0].Status);
        Assert.NotNull(runs[0].FinishedAtUtc);
        Assert.Contains("service restart", runs[0].Failure);
        Assert.Equal("Completed", runs[1].Status);
    }
}
