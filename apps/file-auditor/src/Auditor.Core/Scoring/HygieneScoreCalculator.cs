namespace Auditor.Core.Scoring;

public static class HygieneScoreCalculator
{
    public static int Calculate(long total, long problems, long critical, long bad)
    {
        if (total <= 0) return 100;
        var penalty =
            ((double)problems / total) * 45 +
            ((double)critical / total) * 400 +
            ((double)bad / total) * 120;
        return Math.Clamp((int)Math.Round(100 - penalty), 0, 100);
    }
}
