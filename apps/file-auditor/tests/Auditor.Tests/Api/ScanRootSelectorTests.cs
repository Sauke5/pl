using Auditor.Api.Options;
using Auditor.Api.Services;

namespace Auditor.Tests.Api;

public sealed class ScanRootSelectorTests
{
    private static readonly AuditRootOptions[] Configured =
    [
        new() { Name = "Departments", LocalPath = @"F:\Shares\Departments" },
        new() { Name = "Projects", LocalPath = @"F:\Shares\Projects" },
    ];

    [Fact]
    public void SelectedRootIsResolvedOnlyFromServerConfiguration()
    {
        var result = ScanRootSelector.Select(Configured, ["projects"]);
        var root = Assert.Single(result);
        Assert.Equal("Projects", root.Name);
        Assert.Equal(@"F:\Shares\Projects", root.LocalPath);
        Assert.NotSame(Configured[1], root);
    }

    [Fact]
    public void EmptyLegacyRequestUsesAllConfiguredRoots()
    {
        Assert.Equal(["Departments", "Projects"],
            ScanRootSelector.Select(Configured, null).Select(x => x.Name));
    }

    [Fact]
    public void RejectsEmptyUnknownOrDuplicateRootNames()
    {
        foreach (string[] requested in new string[][]
        {
            [], [@"C:\Windows"], ["Departments", "departments"]
        })
            Assert.Throws<InvalidScanRootsException>(() =>
                ScanRootSelector.Select(Configured, requested));
    }
}
