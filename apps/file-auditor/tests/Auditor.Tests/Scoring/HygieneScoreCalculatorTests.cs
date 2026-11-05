using Auditor.Core.Scoring;
using Xunit;

namespace Auditor.Tests.Scoring;

public sealed class HygieneScoreCalculatorTests
{
    [Fact]
    public void EmptyStructure_IsPerfect()
    {
        var score =
            HygieneScoreCalculator.Calculate(
                0,
                0,
                0,
                0);

        Assert.Equal(
            100,
            score);
    }

    [Fact]
    public void CriticalHeavyStructure_IsPenalized()
    {
        var score =
            HygieneScoreCalculator.Calculate(
                1000,
                500,
                250,
                100);

        Assert.InRange(
            score,
            0,
            40);
    }
}
