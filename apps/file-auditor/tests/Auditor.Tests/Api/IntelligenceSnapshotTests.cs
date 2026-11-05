using Auditor.Api.Controllers;
using Auditor.Api.DTOs;
using Auditor.Api.Options;
using Auditor.Data;
using Auditor.Data.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Auditor.Tests.Api;

public sealed class IntelligenceSnapshotTests
{
    [Fact]
    public async Task SimulationUsesScanThresholdsAfterConfigurationChanges()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var services = new ServiceCollection()
            .AddDbContext<AuditorDbContext>(options => options.UseSqlite(connection))
            .AddOptions()
            .Configure<AuditorOptions>(options =>
            {
                options.WarningPathLength = 200;
                options.BadPathLength = 260;
                options.CriticalPathLength = 300;
            })
            .BuildServiceProvider();
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AuditorDbContext>();
        await db.Database.EnsureCreatedAsync(TestContext.Current.CancellationToken);
        db.AuditRuns.Add(new AuditRun
        {
            Id = 1, Status = "Completed",
            Thresholds = new ScanThresholdSnapshot
            {
                WarningPathLength = 180, BadPathLength = 220,
                CriticalPathLength = 240, LongNameLength = 100, MaxDepth = 12
            }
        });
        db.DepartmentSnapshots.Add(new DepartmentSnapshot
        {
            Id = 42, AuditRunId = 1, DepartmentKey = "Department",
            DepartmentName = "Department", RootLabel = "Departments",
            TotalObjects = 1, ProblemObjects = 1, CriticalPaths = 1,
            MaxPathLength = 250
        });
        db.BranchSnapshots.Add(new BranchSnapshot
        {
            Id = 7, AuditRunId = 1, DepartmentKey = "Department",
            RelativePath = "A", TotalObjects = 1, ProblemObjects = 1,
            CriticalPaths = 1, MaxPathLength = 250,
            ProblemLengthHistogramJson = "{\"250\":1}"
        });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        var controller = new IntelligenceController(
            db, services.GetRequiredService<IOptionsMonitor<AuditorOptions>>());
        var result = await controller.Simulate(
            42, branchId: 7, shortenBy: 30,
            cancellationToken: TestContext.Current.CancellationToken);
        var simulation = Assert.IsType<BranchSimulationDto>(
            Assert.IsType<OkObjectResult>(result.Result).Value);
        Assert.Equal(1, simulation.Before.Critical);
        Assert.Equal(0, simulation.After.Critical);
        Assert.Equal(1, simulation.CriticalReduced);
    }
}
