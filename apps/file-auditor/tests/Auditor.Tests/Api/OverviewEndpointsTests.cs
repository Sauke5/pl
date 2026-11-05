using Auditor.Api.Controllers;
using Auditor.Api.DTOs;
using Auditor.Api.Options;
using Auditor.Data;
using Auditor.Data.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using System.Text.Json;

namespace Auditor.Tests.Api;

public sealed class OverviewEndpointsTests
{
    [Fact]
    public async Task InstanceUsesMachineAndLastCompletedScanOnly()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var db = await CreateDatabase(connection);
        db.AuditRuns.AddRange(
            new AuditRun { Id = 1, Status = "Completed", FinishedAtUtc = new DateTime(2026, 10, 1, 10, 0, 0, DateTimeKind.Utc) },
            new AuditRun { Id = 2, Status = "Running" });
        db.ScanRootSelections.Add(new ScanRootSelection { AuditRunId = 1, RootName = "Departments" });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        var options = new MutableOptionsMonitor<AuditorOptions>(new AuditorOptions
        {
            WarningPathLength = 190,
            Roots = new List<AuditRootOptions> { new() { Name = "Departments", LocalPath = "F:\\Shares\\Departments" } }
        });
        var controller = new InstanceController(db, options);
        var result = await controller.Get(TestContext.Current.CancellationToken);
        var value = Assert.IsType<InstanceDto>(Assert.IsType<OkObjectResult>(result.Result).Value);

        Assert.Equal(Environment.MachineName, value.MachineName);
        Assert.Equal(1, value.LatestCompletedScanId);
        Assert.Equal(190, value.Thresholds.WarningPathLength);
        Assert.Equal(["Departments"], value.LatestCompletedRootNames);
        Assert.Equal("F:\\Shares\\Departments", Assert.Single(value.Roots).LocalPath);

        options.CurrentValue = new AuditorOptions
        {
            Roots = new List<AuditRootOptions> { new() { Name = "Projects", LocalPath = "F:\\Shares\\Projects" } }
        };
        var reloaded = await controller.Get(TestContext.Current.CancellationToken);
        var newValue = Assert.IsType<InstanceDto>(Assert.IsType<OkObjectResult>(reloaded.Result).Value);
        Assert.Equal("Projects", Assert.Single(newValue.Roots).Name);
    }

    [Fact]
    public async Task FindingsUseCompletedRunDeduplicateBeforePagingAndFilter()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var db = await CreateDatabase(connection);
        db.AuditRuns.AddRange(
            new AuditRun { Id = 1, Status = "Completed", FinishedAtUtc = DateTime.UtcNow.AddDays(-1) },
            new AuditRun { Id = 2, Status = "Running" });
        db.DepartmentSnapshots.Add(new DepartmentSnapshot
        {
            Id = 42, AuditRunId = 1, RootLabel = "Departments",
            DepartmentKey = "Departments/IT", DepartmentName = "IT"
        });
        db.PathSampleSnapshots.AddRange(
            Sample(1, 1, "A", "Longest", "CRITICAL"),
            Sample(2, 1, "A", "Deepest", "CRITICAL"),
            Sample(3, 1, "B", "LongName", "WARNING"),
            Sample(4, 2, "C", "Longest", "CRITICAL"));
        db.ScanThresholdSnapshots.Add(new ScanThresholdSnapshot
        {
            AuditRunId = 1, WarningPathLength = 180, BadPathLength = 220,
            CriticalPathLength = 240, LongNameLength = 100, MaxDepth = 12
        });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        var controller = new FindingsController(db);
        var page1 = Value(await controller.Get(pageSize: 1, cancellationToken: TestContext.Current.CancellationToken));
        var page2 = Value(await controller.Get(page: 2, pageSize: 1, cancellationToken: TestContext.Current.CancellationToken));
        Assert.True(page1.IsSample);
        Assert.Equal(1, page1.ScanId);
        Assert.Equal(2, page1.Total);
        Assert.Equal(12, page1.Thresholds?.MaxDepth);
        Assert.Equal("A", Assert.Single(page1.Items).RelativePath);
        Assert.Equal(42, page1.Items[0].DepartmentId);
        Assert.Equal("B", Assert.Single(page2.Items).RelativePath);

        var filtered = Value(await controller.Get(
            department: "Departments/IT", severity: "warning", kind: "longname",
            cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(1, filtered.Total);
        Assert.Equal("B", Assert.Single(filtered.Items).RelativePath);
    }

    [Fact]
    public async Task FindingsWithoutCompletedRunExposeEmptySampleState()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var db = await CreateDatabase(connection);
        db.AuditRuns.Add(new AuditRun { Id = 1, Status = "Running" });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        var result = Value(await new FindingsController(db).Get(cancellationToken: TestContext.Current.CancellationToken));
        Assert.Null(result.ScanId);
        Assert.True(result.IsSample);
        Assert.Empty(result.Items);
    }

    [Fact]
    public async Task LatestCompletedScanIsReturnedAfterManyFailedAttempts()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var db = await CreateDatabase(connection);
        db.AuditRuns.Add(new AuditRun { Id = 1, Status = "Completed" });
        db.AuditRuns.AddRange(Enumerable.Range(2, 40)
            .Select(id => new AuditRun { Id = id, Status = "Failed" }));
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        var response = await new ScansController(null!, db).History(
            take: 1, completedOnly: true,
            cancellationToken: TestContext.Current.CancellationToken);
        var runs = Assert.IsType<ScanRunDto[]>(Assert.IsType<OkObjectResult>(response.Result).Value);
        Assert.Equal(1, Assert.Single(runs).Id);
    }

    [Fact]
    public async Task DashboardKeepsLastCompletedValuesDuringRunningAndFailedScans()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var db = await CreateDatabase(connection);
        db.AuditRuns.AddRange(
            new AuditRun { Id = 1, Status = "Completed", TotalObjects = 50, CriticalPaths = 3 },
            new AuditRun { Id = 2, Status = "Failed", TotalObjects = 0 },
            new AuditRun { Id = 3, Status = "Running", TotalObjects = 1 });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        var response = await new DashboardController(db).Get(TestContext.Current.CancellationToken);
        var value = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(response).Value);
        Assert.Equal(50, value.GetProperty("TotalObjects").GetInt64());
        Assert.Equal(3, value.GetProperty("CriticalPaths").GetInt64());
    }

    private static FindingsPageDto Value(ActionResult<FindingsPageDto> result) =>
        Assert.IsType<FindingsPageDto>(Assert.IsType<OkObjectResult>(result.Result).Value);

    private static PathSampleSnapshot Sample(long id, long runId, string path, string kind, string severity) =>
        new()
        {
            Id = id, AuditRunId = runId, RootLabel = "Departments",
            DepartmentKey = "Departments/IT", DepartmentName = "IT",
            RelativePath = path, SampleKind = kind, Severity = severity,
            PathLength = path == "A" ? 250 : 190
        };

    private static async Task<AuditorDbContext> CreateDatabase(SqliteConnection connection)
    {
        var options = new DbContextOptionsBuilder<AuditorDbContext>()
            .UseSqlite(connection)
            .Options;
        var db = new AuditorDbContext(options);
        await db.Database.EnsureCreatedAsync(TestContext.Current.CancellationToken);
        return db;
    }

    private sealed class MutableOptionsMonitor<T>(T value) : IOptionsMonitor<T>
    {
        public T CurrentValue { get; set; } = value;
        public T Get(string? name) => CurrentValue;
        public IDisposable OnChange(Action<T, string?> listener) => new EmptyDisposable();
    }

    private sealed class EmptyDisposable : IDisposable
    {
        public void Dispose() { }
    }
}
