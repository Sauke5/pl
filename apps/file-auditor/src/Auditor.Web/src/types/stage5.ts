export interface RiskConcentration {
  top1Percent: number;
  top3Percent: number;
  top5Percent: number;
  top10Percent: number;
  storedBranchCoveragePercent: number;
}

export interface ReductionTarget {
  targetPercent: number;
  requiredCharacters: number | null;
}

export interface BranchRemediation {
  branchId: number;
  relativePath: string;
  totalObjects: number;
  problemObjects: number;
  criticalPaths: number;
  badPaths: number;
  warningPaths: number;
  maxPathLength: number;
  maxDepth: number;
  criticalSharePercent: number;
  criticalReductionAt30: number;
  criticalReductionAt30Percent: number;
  exactSimulationAvailable: boolean;
  hasRepeatedAdjacentSegment: boolean;
  repeatedSegment: string | null;
  recommendation: string;
}

export interface BranchMover {
  relativePath: string;
  currentCritical: number;
  previousCritical: number;
  criticalDelta: number;
  kind: 'New' | 'Improved' | 'Worsened' | 'Resolved' | string;
}

export interface DepartmentRemediation {
  departmentId: number;
  departmentName: string;
  departmentKey: string;
  diagnosis: string;
  diagnosisDetail: string;
  remediationPriority: string;
  priorityScore: number;
  concentration: RiskConcentration;
  potentialCriticalReductionAt30: number;
  potentialCriticalReductionAt30Percent: number;
  exactSimulationAvailable: boolean;
  reductionTargets: ReductionTarget[];
  branches: BranchRemediation[];
  movers: BranchMover[];
  recommendedAction: string;
}

export interface ExecutiveDepartment {
  departmentId: number;
  departmentName: string;
  criticalPaths: number;
  problemPercent: number;
  hygieneScore: number;
  remediationPriority: string;
  priorityScore: number;
  top3ConcentrationPercent: number;
  potentialCriticalReductionAt30: number;
  exactSimulationAvailable: boolean;
}

export interface ExecutiveChange {
  hasPrevious: boolean;
  previousScanId: number | null;
  totalObjectsDelta: number;
  problemObjectsDelta: number;
  criticalPathsDelta: number;
  badPathsDelta: number;
  warningPathsDelta: number;
  maxPathLengthDelta: number;
}

export interface ExecutiveIntelligence {
  scanId: number;
  change: ExecutiveChange;
  bestRemediationTargets: ExecutiveDepartment[];
  departmentsWithExactSimulation: number;
  departmentCount: number;
  summary: string;
}

export interface SimulationSeverity {
  ok: number;
  warning: number;
  bad: number;
  critical: number;
}

export interface BranchSimulation {
  departmentId: number;
  branchId: number;
  branchPath: string;
  shortenBy: number;
  exact: boolean;
  before: SimulationSeverity;
  after: SimulationSeverity;
  objectsImproved: number;
  criticalReduced: number;
  badReduced: number;
  warningReduced: number;
  estimatedDepartmentScoreBefore: number;
  estimatedDepartmentScoreAfter: number;
  estimatedDepartmentCriticalAfter: number;
  estimatedDepartmentBadAfter: number;
  estimatedDepartmentWarningAfter: number;
}