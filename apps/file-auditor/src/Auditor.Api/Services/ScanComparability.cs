using Auditor.Data;
using Auditor.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Auditor.Api.Services;

public static class ScanComparability
{
    public static async Task<HashSet<long>> FindComparableIdsAsync(
        AuditorDbContext db,
        long currentId,
        IEnumerable<long> candidateIds,
        CancellationToken cancellationToken)
    {
        var ids = candidateIds.Append(currentId).Distinct().ToArray();
        var roots = await db.ScanRootSelections.AsNoTracking()
            .Where(x => ids.Contains(x.AuditRunId))
            .Select(x => new { x.AuditRunId, x.RootName })
            .ToListAsync(cancellationToken);
        var thresholds = await db.ScanThresholdSnapshots.AsNoTracking()
            .Where(x => ids.Contains(x.AuditRunId))
            .ToDictionaryAsync(x => x.AuditRunId, cancellationToken);

        var rootsByRun = roots.GroupBy(x => x.AuditRunId)
            .ToDictionary(group => group.Key,
                group => group.Select(x => x.RootName).ToHashSet(StringComparer.OrdinalIgnoreCase));
        if (!rootsByRun.TryGetValue(currentId, out var currentRoots) ||
            currentRoots.Count == 0 ||
            !thresholds.TryGetValue(currentId, out var currentThresholds))
            return new HashSet<long>();

        return ids.Where(id =>
            rootsByRun.TryGetValue(id, out var candidateRoots) &&
            currentRoots.SetEquals(candidateRoots) &&
            thresholds.TryGetValue(id, out var candidateThresholds) &&
            SameThresholds(currentThresholds, candidateThresholds))
            .ToHashSet();
    }

    private static bool SameThresholds(ScanThresholdSnapshot a, ScanThresholdSnapshot b) =>
        a.WarningPathLength == b.WarningPathLength &&
        a.BadPathLength == b.BadPathLength &&
        a.CriticalPathLength == b.CriticalPathLength &&
        a.LongNameLength == b.LongNameLength &&
        a.MaxDepth == b.MaxDepth;
}
