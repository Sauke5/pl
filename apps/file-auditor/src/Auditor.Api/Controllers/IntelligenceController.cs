using System.Text.Json;
using Auditor.Api.DTOs;
using Auditor.Api.Options;
using Auditor.Api.Services;
using Auditor.Data;
using Auditor.Data.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Auditor.Api.Controllers;

[ApiController]
[Route("api/intelligence")]
public sealed class IntelligenceController : ControllerBase
{
    private readonly AuditorDbContext _db;
    private AuditorOptions _options;

    public IntelligenceController(
        AuditorDbContext db,
        IOptionsMonitor<AuditorOptions> options)
    {
        _db = db;
        _options = options.CurrentValue;
    }

    [HttpGet("overview")]
    public async Task<ActionResult<ExecutiveIntelligenceDto>> Overview(
        CancellationToken cancellationToken)
    {
        var runs = await _db.AuditRuns
            .AsNoTracking()
            .Where(x => x.Status == "Completed")
            .OrderByDescending(x => x.Id)
            .Take(2)
            .ToListAsync(cancellationToken);

        if (runs.Count == 0)
            return NotFound();

        var latest = runs[0];
        var previous = runs.Count > 1 ? runs[1] : null;
        if (previous is not null && !(await ScanComparability.FindComparableIdsAsync(
                _db, latest.Id, [previous.Id], cancellationToken)).Contains(previous.Id))
            previous = null;
        await LoadScanThresholdsAsync(latest.Id, cancellationToken);

        var departments = await _db.DepartmentSnapshots
            .AsNoTracking()
            .Where(x => x.AuditRunId == latest.Id && x.ProblemObjects > 0)
            .ToListAsync(cancellationToken);

        var branches = await _db.BranchSnapshots
            .AsNoTracking()
            .Where(x => x.AuditRunId == latest.Id)
            .ToListAsync(cancellationToken);

        var branchByDepartment = branches
            .GroupBy(x => x.DepartmentKey, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                x => x.Key,
                x => x.OrderByDescending(b => b.CriticalPaths)
                      .ThenByDescending(b => b.ProblemObjects)
                      .ToList(),
                StringComparer.OrdinalIgnoreCase);

        var targets = new List<ExecutiveDepartmentDto>();

        foreach (var department in departments)
        {
            branchByDepartment.TryGetValue(
                department.DepartmentKey,
                out var departmentBranches);

            departmentBranches ??= new List<BranchSnapshot>();

            var top3 = Percent(
                departmentBranches.Take(3).Sum(x => x.CriticalPaths),
                department.CriticalPaths);

            long potential30 = 0;
            var exact = false;

            foreach (var branch in departmentBranches)
            {
                var histogram = Histogram(branch);
                if (histogram.Count == 0)
                    continue;

                exact = true;
                potential30 +=
                    SimulateHistogram(histogram, 30).CriticalReduced;
            }

            var priorityScore =
                PriorityScore(
                    department,
                    top3,
                    potential30);

            targets.Add(
                new ExecutiveDepartmentDto(
                    department.Id,
                    department.DepartmentName,
                    department.CriticalPaths,
                    Percent(
                        department.ProblemObjects,
                        department.TotalObjects),
                    ScoreV2(department),
                    PriorityLabel(priorityScore),
                    priorityScore,
                    top3,
                    potential30,
                    exact));
        }

        var change =
            new ExecutiveChangeDto(
                previous is not null,
                previous?.Id,
                previous is null ? 0 : latest.TotalObjects - previous.TotalObjects,
                previous is null ? 0 : latest.ProblemObjects - previous.ProblemObjects,
                previous is null ? 0 : latest.CriticalPaths - previous.CriticalPaths,
                previous is null ? 0 : latest.BadPaths - previous.BadPaths,
                previous is null ? 0 : latest.WarningPaths - previous.WarningPaths,
                previous is null ? 0 : latest.MaxPathLength - previous.MaxPathLength);

        var exactCount = targets.Count(x => x.ExactSimulationAvailable);

        var summary =
            previous is null
                ? runs.Count == 1
                    ? "Первый сохранённый аудит: динамика появится после следующего запуска."
                    : "Сравнение доступно после двух срезов с одинаковыми областями и порогами."
                : latest.CriticalPaths < previous.CriticalPaths
                    ? $"Critical уменьшились на {previous.CriticalPaths - latest.CriticalPaths:N0}."
                    : latest.CriticalPaths > previous.CriticalPaths
                        ? $"Critical выросли на {latest.CriticalPaths - previous.CriticalPaths:N0}."
                        : "Количество Critical не изменилось.";

        return Ok(
            new ExecutiveIntelligenceDto(
                latest.Id,
                change,
                targets
                    .OrderByDescending(x => x.PriorityScore)
                    .ThenByDescending(x => x.PotentialCriticalReductionAt30)
                    .Take(8)
                    .ToArray(),
                exactCount,
                targets.Count,
                summary));
    }

    [HttpGet("departments/{id:long}")]
    public async Task<ActionResult<DepartmentRemediationDto>> Department(
        long id,
        CancellationToken cancellationToken)
    {
        var department = await _db.DepartmentSnapshots
            .AsNoTracking()
            .SingleOrDefaultAsync(x => x.Id == id, cancellationToken);

        if (department is null)
            return NotFound();

        await LoadScanThresholdsAsync(department.AuditRunId, cancellationToken);

        var branches = await _db.BranchSnapshots
            .AsNoTracking()
            .Where(
                x =>
                    x.AuditRunId == department.AuditRunId &&
                    x.DepartmentKey == department.DepartmentKey)
            .OrderByDescending(x => x.CriticalPaths)
            .ThenByDescending(x => x.ProblemObjects)
            .ToListAsync(cancellationToken);

        var previousDepartment = await _db.DepartmentSnapshots
            .AsNoTracking()
            .Where(x => x.DepartmentKey == department.DepartmentKey)
            .Where(x => x.AuditRunId < department.AuditRunId)
            .OrderByDescending(x => x.AuditRunId)
            .FirstOrDefaultAsync(cancellationToken);

        if (previousDepartment is not null && !(await ScanComparability.FindComparableIdsAsync(
                _db, department.AuditRunId, [previousDepartment.AuditRunId], cancellationToken))
            .Contains(previousDepartment.AuditRunId))
            previousDepartment = null;

        var previousBranches =
            previousDepartment is null
                ? new List<BranchSnapshot>()
                : await _db.BranchSnapshots
                    .AsNoTracking()
                    .Where(
                        x =>
                            x.AuditRunId == previousDepartment.AuditRunId &&
                            x.DepartmentKey == department.DepartmentKey)
                    .ToListAsync(cancellationToken);

        var concentration =
            new RiskConcentrationDto(
                Percent(branches.Take(1).Sum(x => x.CriticalPaths), department.CriticalPaths),
                Percent(branches.Take(3).Sum(x => x.CriticalPaths), department.CriticalPaths),
                Percent(branches.Take(5).Sum(x => x.CriticalPaths), department.CriticalPaths),
                Percent(branches.Take(10).Sum(x => x.CriticalPaths), department.CriticalPaths),
                Percent(branches.Sum(x => x.CriticalPaths), department.CriticalPaths));

        var branchDtos = new List<BranchRemediationDto>();
        var mergedHistogram = new Dictionary<int, long>();
        long potential30 = 0;
        var anyExact = false;

        foreach (var branch in branches)
        {
            var histogram = Histogram(branch);
            var exact = histogram.Count > 0;
            anyExact |= exact;

            foreach (var pair in histogram)
            {
                mergedHistogram[pair.Key] =
                    mergedHistogram.GetValueOrDefault(pair.Key) + pair.Value;
            }

            var sim30 =
                exact
                    ? SimulateHistogram(histogram, 30)
                    : default;

            var reduction30 =
                exact ? sim30.CriticalReduced : 0;

            potential30 += reduction30;

            var repeated =
                FindRepeatedAdjacentSegment(branch.RelativePath);

            branchDtos.Add(
                new BranchRemediationDto(
                    branch.Id,
                    branch.RelativePath,
                    branch.TotalObjects,
                    branch.ProblemObjects,
                    branch.CriticalPaths,
                    branch.BadPaths,
                    branch.WarningPaths,
                    branch.MaxPathLength,
                    branch.MaxDepth,
                    Percent(branch.CriticalPaths, department.CriticalPaths),
                    reduction30,
                    Percent(reduction30, branch.CriticalPaths),
                    exact,
                    repeated is not null,
                    repeated,
                    BuildBranchRecommendation(
                        branch,
                        repeated,
                        reduction30)));
        }

        var movers = previousDepartment is null
            ? Array.Empty<BranchMoverDto>()
            : BuildMovers(branches, previousBranches);

        var diagnosis =
            Diagnosis(department);

        var priorityScore =
            PriorityScore(
                department,
                concentration.Top3Percent,
                potential30);

        var criticalInHistogram =
            mergedHistogram
                .Where(x => x.Key > _options.CriticalPathLength)
                .Sum(x => x.Value);

        var targets = new[] { 25, 50, 80, 95 }
            .Select(
                target =>
                    new ReductionTargetDto(
                        target,
                        FindRequiredReduction(
                            mergedHistogram,
                            criticalInHistogram,
                            target)))
            .ToArray();

        return Ok(
            new DepartmentRemediationDto(
                department.Id,
                department.DepartmentName,
                department.DepartmentKey,
                diagnosis.Title,
                diagnosis.Detail,
                PriorityLabel(priorityScore),
                priorityScore,
                concentration,
                potential30,
                Percent(potential30, department.CriticalPaths),
                anyExact,
                targets,
                branchDtos.Take(15).ToArray(),
                movers,
                RecommendedAction(
                    department,
                    concentration,
                    potential30,
                    anyExact)));
    }

    [HttpGet("departments/{id:long}/simulate")]
    public async Task<ActionResult<BranchSimulationDto>> Simulate(
        long id,
        [FromQuery] long branchId,
        [FromQuery] int shortenBy = 30,
        CancellationToken cancellationToken = default)
    {
        shortenBy = Math.Clamp(shortenBy, 0, 300);

        var department = await _db.DepartmentSnapshots
            .AsNoTracking()
            .SingleOrDefaultAsync(x => x.Id == id, cancellationToken);

        if (department is null)
            return NotFound();

        await LoadScanThresholdsAsync(department.AuditRunId, cancellationToken);

        var branch = await _db.BranchSnapshots
            .AsNoTracking()
            .SingleOrDefaultAsync(
                x =>
                    x.Id == branchId &&
                    x.AuditRunId == department.AuditRunId &&
                    x.DepartmentKey == department.DepartmentKey,
                cancellationToken);

        if (branch is null)
            return NotFound();

        var histogram = Histogram(branch);

        if (histogram.Count == 0)
        {
            return Conflict(
                new
                {
                    message =
                        "Exact histogram is not available for this historical scan. Run one new audit after Stage 5 installation."
                });
        }

        var simulation =
            SimulateHistogram(
                histogram,
                shortenBy);

        var newCritical =
            Math.Max(
                0,
                department.CriticalPaths -
                simulation.Before.Critical +
                simulation.After.Critical);

        var newBad =
            Math.Max(
                0,
                department.BadPaths -
                simulation.Before.Bad +
                simulation.After.Bad);

        var newWarning =
            Math.Max(
                0,
                department.WarningPaths -
                simulation.Before.Warning +
                simulation.After.Warning);

        return Ok(
            new BranchSimulationDto(
                department.Id,
                branch.Id,
                branch.RelativePath,
                shortenBy,
                true,
                simulation.Before,
                simulation.After,
                simulation.ObjectsImproved,
                simulation.CriticalReduced,
                simulation.BadReduced,
                simulation.WarningReduced,
                ScoreV2(department),
                ScoreV2(
                    department.TotalObjects,
                    newWarning,
                    newBad,
                    newCritical,
                    department.MaxPathLength,
                    department.MaxDepth),
                newCritical,
                newBad,
                newWarning));
    }

    private async Task LoadScanThresholdsAsync(long scanId, CancellationToken cancellationToken)
    {
        var saved = await _db.ScanThresholdSnapshots.AsNoTracking()
            .SingleOrDefaultAsync(x => x.AuditRunId == scanId, cancellationToken);
        if (saved is null)
            return;

        _options = new AuditorOptions
        {
            WarningPathLength = saved.WarningPathLength,
            BadPathLength = saved.BadPathLength,
            CriticalPathLength = saved.CriticalPathLength,
            LongNameLength = saved.LongNameLength,
            MaxDepth = saved.MaxDepth
        };
    }

    private Dictionary<int, long> Histogram(
        BranchSnapshot branch)
    {
        if (string.IsNullOrWhiteSpace(
            branch.ProblemLengthHistogramJson))
        {
            return new();
        }

        try
        {
            return
                JsonSerializer.Deserialize<Dictionary<int, long>>(
                    branch.ProblemLengthHistogramJson)
                ?? new();
        }
        catch
        {
            return new();
        }
    }

    private SimulationCalc SimulateHistogram(
        IReadOnlyDictionary<int, long> histogram,
        int shortenBy)
    {
        var before = new MutableSeverity();
        var after = new MutableSeverity();
        long improved = 0;

        foreach (var pair in histogram)
        {
            var currentSeverity =
                Severity(pair.Key);

            var newLength =
                Math.Max(
                    0,
                    pair.Key - shortenBy);

            var newSeverity =
                Severity(newLength);

            before.Add(currentSeverity, pair.Value);
            after.Add(newSeverity, pair.Value);

            if (Rank(newSeverity) < Rank(currentSeverity))
                improved += pair.Value;
        }

        var beforeDto = before.Dto();
        var afterDto = after.Dto();

        return new SimulationCalc(
            beforeDto,
            afterDto,
            improved,
            Math.Max(0, beforeDto.Critical - afterDto.Critical),
            Math.Max(0, beforeDto.Bad - afterDto.Bad),
            Math.Max(0, beforeDto.Warning - afterDto.Warning));
    }

    private string Severity(int length)
    {
        if (length > _options.CriticalPathLength)
            return "Critical";

        if (length > _options.BadPathLength)
            return "Bad";

        if (length > _options.WarningPathLength)
            return "Warning";

        return "OK";
    }

    private static int Rank(string severity) =>
        severity switch
        {
            "Critical" => 3,
            "Bad" => 2,
            "Warning" => 1,
            _ => 0
        };

    private int? FindRequiredReduction(
        IReadOnlyDictionary<int, long> histogram,
        long initialCritical,
        int targetPercent)
    {
        if (initialCritical <= 0 || histogram.Count == 0)
            return null;

        var targetReduction =
            (long)Math.Ceiling(
                initialCritical *
                targetPercent /
                100d);

        var max =
            Math.Max(
                1,
                histogram.Keys.Max() -
                _options.CriticalPathLength);

        for (var reduction = 1; reduction <= max; reduction++)
        {
            var sim =
                SimulateHistogram(
                    histogram,
                    reduction);

            if (sim.CriticalReduced >= targetReduction)
                return reduction;
        }

        return null;
    }

    private static IReadOnlyList<BranchMoverDto> BuildMovers(
        IReadOnlyList<BranchSnapshot> current,
        IReadOnlyList<BranchSnapshot> previous)
    {
        var old =
            previous.ToDictionary(
                x => x.RelativePath,
                StringComparer.OrdinalIgnoreCase);

        var movers = new List<BranchMoverDto>();

        foreach (var branch in current)
        {
            old.TryGetValue(
                branch.RelativePath,
                out var previousBranch);

            var previousCritical =
                previousBranch?.CriticalPaths ?? 0;

            var delta =
                branch.CriticalPaths -
                previousCritical;

            if (delta == 0)
                continue;

            movers.Add(
                new BranchMoverDto(
                    branch.RelativePath,
                    branch.CriticalPaths,
                    previousCritical,
                    delta,
                    previousBranch is null
                        ? "New"
                        : delta < 0
                            ? "Improved"
                            : "Worsened"));
        }

        foreach (var branch in previous)
        {
            if (current.Any(
                x =>
                    string.Equals(
                        x.RelativePath,
                        branch.RelativePath,
                        StringComparison.OrdinalIgnoreCase)))
            {
                continue;
            }

            if (branch.CriticalPaths <= 0)
                continue;

            movers.Add(
                new BranchMoverDto(
                    branch.RelativePath,
                    0,
                    branch.CriticalPaths,
                    -branch.CriticalPaths,
                    "Resolved"));
        }

        return movers
            .OrderByDescending(x => Math.Abs(x.CriticalDelta))
            .Take(12)
            .ToArray();
    }

    private static string? FindRepeatedAdjacentSegment(
        string relativePath)
    {
        var parts =
            relativePath
                .Split(
                    '\\',
                    StringSplitOptions.RemoveEmptyEntries |
                    StringSplitOptions.TrimEntries);

        for (var i = 1; i < parts.Length; i++)
        {
            if (string.Equals(
                parts[i - 1],
                parts[i],
                StringComparison.OrdinalIgnoreCase))
            {
                return parts[i];
            }
        }

        return null;
    }

    private static string BuildBranchRecommendation(
        BranchSnapshot branch,
        string? repeated,
        long reductionAt30)
    {
        if (repeated is not null)
        {
            return
                $"Проверить повторяющийся сегмент «{repeated}»: это потенциально бесплатное сокращение префикса.";
        }

        if (reductionAt30 > 0)
        {
            return
                $"Сокращение префикса примерно на 30 символов снимет Critical минимум с {reductionAt30:N0} объектов этой ветки.";
        }

        if (branch.MaxDepth > 12)
        {
            return
                "Сократить число промежуточных каталогов и убрать технические уровни дерева.";
        }

        return
            "Проверить верхние уровни ветки: локальное сокращение префикса даст наибольший эффект.";
    }

    private static (string Title, string Detail) Diagnosis(
        DepartmentSnapshot department)
    {
        var causes =
            new[]
            {
                ("Длинная родительская структура", department.CauseLongParent),
                ("Глубокое дерево каталогов", department.CauseDeepTree),
                ("Длинные имена", department.CauseLongName),
                ("Смешанная причина", department.CauseMixed)
            };

        var dominant =
            causes.OrderByDescending(x => x.Item2).First();

        var total =
            Math.Max(
                1,
                causes.Sum(x => x.Item2));

        return (
            dominant.Item1,
            $"{Percent(dominant.Item2, total):0.0}% классифицированных проблем относится к этой причине.");
    }

    private static int PriorityScore(
        DepartmentSnapshot department,
        double top3Concentration,
        long potential30)
    {
        var criticalComponent =
            Math.Min(
                45,
                Math.Log10(
                    Math.Max(
                        1,
                        department.CriticalPaths) + 1) * 9);

        var problemComponent =
            Math.Min(
                20,
                Percent(
                    department.ProblemObjects,
                    department.TotalObjects) * 0.30);

        var concentrationComponent =
            Math.Min(
                15,
                top3Concentration * 0.15);

        var remediationComponent =
            department.CriticalPaths <= 0
                ? 0
                : Math.Min(
                    20,
                    Percent(
                        potential30,
                        department.CriticalPaths) * 0.20);

        return
            Math.Clamp(
                (int)Math.Round(
                    criticalComponent +
                    problemComponent +
                    concentrationComponent +
                    remediationComponent),
                0,
                100);
    }

    private static string PriorityLabel(
        int score) =>
        score switch
        {
            >= 75 => "Исправлять первым",
            >= 55 => "Высокий приоритет",
            >= 35 => "Средний приоритет",
            _ => "Низкий приоритет"
        };

    private static string RecommendedAction(
        DepartmentSnapshot department,
        RiskConcentrationDto concentration,
        long potential30,
        bool exact)
    {
        if (!exact)
        {
            return
                "Агрегаты доступны. Для точной симуляции достаточно выполнить один новый аудит после установки Stage 5.";
        }

        if (concentration.Top3Percent >= 70)
        {
            return
                $"Точечная реорганизация оправдана: TOP-3 ветки создают {concentration.Top3Percent:0.0}% Critical. Начать с самой концентрированной ветки.";
        }

        if (potential30 > 0)
        {
            return
                $"Сокращение проблемных префиксов на ~30 символов потенциально снимет Critical минимум с {potential30:N0} объектов сохранённых TOP-веток.";
        }

        if (department.CauseDeepTree > department.CauseLongName)
        {
            return
                "Проблема распределена: приоритет — уменьшение вложенности и числа промежуточных каталогов.";
        }

        return
            "Проблема распределена по структуре. Массовое переименование файлов даст меньший эффект, чем пересмотр верхних уровней дерева.";
    }

    private int ScoreV2(
        DepartmentSnapshot department) =>
        ScoreV2(
            department.TotalObjects,
            department.WarningPaths,
            department.BadPaths,
            department.CriticalPaths,
            department.MaxPathLength,
            department.MaxDepth);

    private static int ScoreV2(
        long totalObjects,
        long warning,
        long bad,
        long critical,
        int maxPath,
        int maxDepth)
    {
        var total =
            Math.Max(
                1,
                totalObjects);

        var severityRisk =
            warning / (double)total * 0.25 +
            bad / (double)total * 1.0 +
            critical / (double)total * 3.0;

        var maxPathRisk =
            Math.Clamp(
                (maxPath - 240d) / 240d,
                0,
                2) * 0.08;

        var depthRisk =
            Math.Clamp(
                (maxDepth - 12d) / 12d,
                0,
                2) * 0.06;

        var raw =
            100 *
            Math.Exp(
                -1.7 *
                (
                    severityRisk +
                    maxPathRisk +
                    depthRisk
                ));

        return
            Math.Clamp(
                (int)Math.Round(raw),
                0,
                100);
    }

    private static double Percent(
        long part,
        long total)
    {
        if (total <= 0)
            return 0;

        return
            part *
            100d /
            total;
    }

    private sealed class MutableSeverity
    {
        public long Ok { get; private set; }
        public long Warning { get; private set; }
        public long Bad { get; private set; }
        public long Critical { get; private set; }

        public void Add(
            string severity,
            long value)
        {
            switch (severity)
            {
                case "Critical":
                    Critical += value;
                    break;
                case "Bad":
                    Bad += value;
                    break;
                case "Warning":
                    Warning += value;
                    break;
                default:
                    Ok += value;
                    break;
            }
        }

        public SimulationSeverityDto Dto() =>
            new(
                Ok,
                Warning,
                Bad,
                Critical);
    }

    private readonly record struct SimulationCalc(
        SimulationSeverityDto Before,
        SimulationSeverityDto After,
        long ObjectsImproved,
        long CriticalReduced,
        long BadReduced,
        long WarningReduced);
}
