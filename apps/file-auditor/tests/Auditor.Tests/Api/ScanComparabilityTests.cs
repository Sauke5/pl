using Auditor.Api.Controllers;
using Auditor.Api.DTOs;
using Auditor.Api.Options;
using Auditor.Api.Services;
using Auditor.Data;
using Auditor.Data.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Auditor.Tests.Api;

public sealed class ScanComparabilityTests
{
    [Fact]
    public async Task ChangesRequireTheSameRootsAndThresholds()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var services = new ServiceCollection()
            .AddDbContext<AuditorDbContext>(options => options.UseSqlite(connection))
            .AddOptions()
            .Configure<AuditorOptions>(_ => { })
            .BuildServiceProvider();
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AuditorDbContext>();
        await db.Database.EnsureCreatedAsync(TestContext.Current.CancellationToken);

        db.AuditRuns.AddRange(
            Run(1, ["A"], 240),
            Run(2, ["A", "B"], 240),
            Run(3, ["A", "B"], 260),
            Run(4, ["A", "B"], 240));
        db.DepartmentSnapshots.AddRange(
            new DepartmentSnapshot { Id = 31, AuditRunId = 3, RootLabel = "A", DepartmentKey = "A/team", DepartmentName = "team", TotalObjects = 10, ProblemObjects = 8, CriticalPaths = 8 },
            new DepartmentSnapshot { Id = 41, AuditRunId = 4, RootLabel = "A", DepartmentKey = "A/team", DepartmentName = "team", TotalObjects = 10, ProblemObjects = 2, CriticalPaths = 2 });
        db.BranchSnapshots.Add(new BranchSnapshot
        {
            Id = 44, AuditRunId = 4, RootLabel = "A", DepartmentKey = "A/team",
            RelativePath = "A/team/docs", TotalObjects = 2, ProblemObjects = 2, CriticalPaths = 2
        });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        var comparable = await ScanComparability.FindComparableIdsAsync(
            db, 4, [1, 2, 3], TestContext.Current.CancellationToken);
        Assert.Equal([2L, 4L], comparable.OrderBy(x => x));

        var intelligence = new IntelligenceController(
            db, services.GetRequiredService<IOptionsMonitor<AuditorOptions>>());
        var overview = Assert.IsType<ExecutiveIntelligenceDto>(
            Assert.IsType<OkObjectResult>((await intelligence.Overview(TestContext.Current.CancellationToken)).Result).Value);
        Assert.False(overview.Change.HasPrevious);
        Assert.Contains("одинаковыми областями и порогами", overview.Summary);
        var remediation = Assert.IsType<DepartmentRemediationDto>(
            Assert.IsType<OkObjectResult>((await intelligence.Department(41, TestContext.Current.CancellationToken)).Result).Value);
        Assert.Empty(remediation.Movers);

        var departments = new DepartmentsController(db);
        var list = Assert.IsAssignableFrom<IEnumerable<DepartmentListItemDto>>(
            Assert.IsType<OkObjectResult>((await departments.GetLatest(TestContext.Current.CancellationToken)).Result).Value).ToArray();
        Assert.Single(list);
        Assert.False(list[0].Delta.HasPrevious);

        var report = Assert.IsType<DepartmentReportDto>(
            Assert.IsType<OkObjectResult>((await departments.GetReport(41, TestContext.Current.CancellationToken)).Result).Value);
        Assert.False(report.Delta.HasPrevious);
        Assert.Single(report.History);
    }

    private static AuditRun Run(long id, string[] roots, int critical) => new()
    {
        Id = id,
        Status = "Completed",
        SelectedRoots = roots.Select(name => new ScanRootSelection { RootName = name }).ToList(),
        Thresholds = new ScanThresholdSnapshot
        {
            WarningPathLength = 180,
            BadPathLength = 220,
            CriticalPathLength = critical,
            LongNameLength = 100,
            MaxDepth = 12
        }
    };
}
