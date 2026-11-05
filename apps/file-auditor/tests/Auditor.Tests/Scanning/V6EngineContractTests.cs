using Auditor.Core.Scanning.Engine;
using Xunit;

namespace Auditor.Tests.Scanning;

public sealed class V6EngineContractTests
{
    [Fact]
    public void EngineExposesExpectedOptions()
    {
        var options =
            new ScanOptions
            {
                Workers = 48,
                WarningPathLength = 180,
                BadPathLength = 220,
                CriticalPathLength = 240
            };

        Assert.Equal(
            48,
            options.Workers);

        Assert.Equal(
            240,
            options.CriticalPathLength);
    }

    [Fact]
    public void EngineExposesProgressCallback()
    {
        var property =
            typeof(ExtremeScanner)
                .GetProperty(
                    "ProgressChanged");

        Assert.NotNull(property);
    }
}
