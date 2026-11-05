namespace Auditor.Api.DTOs;

public sealed record RiskConcentrationDto(
    double Top1Percent,
    double Top3Percent,
    double Top5Percent,
    double Top10Percent,
    double StoredBranchCoveragePercent);

public sealed record ReductionTargetDto(
    int TargetPercent,
    int? RequiredCharacters);

public sealed record BranchRemediationDto(
    long BranchId,
    string RelativePath,
    long TotalObjects,
    long ProblemObjects,
    long CriticalPaths,
    long BadPaths,
    long WarningPaths,
    int MaxPathLength,
    int MaxDepth,
    double CriticalSharePercent,
    long CriticalReductionAt30,
    double CriticalReductionAt30Percent,
    bool ExactSimulationAvailable,
    bool HasRepeatedAdjacentSegment,
    string? RepeatedSegment,
    string Recommendation);

public sealed record BranchMoverDto(
    string RelativePath,
    long CurrentCritical,
    long PreviousCritical,
    long CriticalDelta,
    string Kind);

public sealed record DepartmentRemediationDto(
    long DepartmentId,
    string DepartmentName,
    string DepartmentKey,
    string Diagnosis,
    string DiagnosisDetail,
    string RemediationPriority,
    int PriorityScore,
    RiskConcentrationDto Concentration,
    long PotentialCriticalReductionAt30,
    double PotentialCriticalReductionAt30Percent,
    bool ExactSimulationAvailable,
    IReadOnlyList<ReductionTargetDto> ReductionTargets,
    IReadOnlyList<BranchRemediationDto> Branches,
    IReadOnlyList<BranchMoverDto> Movers,
    string RecommendedAction);

public sealed record ExecutiveDepartmentDto(
    long DepartmentId,
    string DepartmentName,
    long CriticalPaths,
    double ProblemPercent,
    int HygieneScore,
    string RemediationPriority,
    int PriorityScore,
    double Top3ConcentrationPercent,
    long PotentialCriticalReductionAt30,
    bool ExactSimulationAvailable);

public sealed record ExecutiveChangeDto(
    bool HasPrevious,
    long? PreviousScanId,
    long TotalObjectsDelta,
    long ProblemObjectsDelta,
    long CriticalPathsDelta,
    long BadPathsDelta,
    long WarningPathsDelta,
    int MaxPathLengthDelta);

public sealed record ExecutiveIntelligenceDto(
    long ScanId,
    ExecutiveChangeDto Change,
    IReadOnlyList<ExecutiveDepartmentDto> BestRemediationTargets,
    int DepartmentsWithExactSimulation,
    int DepartmentCount,
    string Summary);

public sealed record SimulationSeverityDto(
    long Ok,
    long Warning,
    long Bad,
    long Critical);

public sealed record BranchSimulationDto(
    long DepartmentId,
    long BranchId,
    string BranchPath,
    int ShortenBy,
    bool Exact,
    SimulationSeverityDto Before,
    SimulationSeverityDto After,
    long ObjectsImproved,
    long CriticalReduced,
    long BadReduced,
    long WarningReduced,
    int EstimatedDepartmentScoreBefore,
    int EstimatedDepartmentScoreAfter,
    long EstimatedDepartmentCriticalAfter,
    long EstimatedDepartmentBadAfter,
    long EstimatedDepartmentWarningAfter);