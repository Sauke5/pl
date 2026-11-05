export interface ScanRun {
  id: number;
  startedAtUtc: string;
  finishedAtUtc: string | null;
  status: string;
  workers: number;
  peakActiveWorkers: number;
  totalObjects: number;
  totalFiles: number;
  totalDirectories: number;
  problemObjects: number;
  criticalPaths: number;
  badPaths: number;
  warningPaths: number;
  errorCount: number;
  maxPathLength: number;
  maxDepth: number;
  hygieneScore: number;
  scannerDurationMs: number;
  objectsPerSecond: number;
  failure: string | null;
}

export interface ScanProgress {
  scanId: number;
  status: string;
  startedAtUtc: string;
  processedObjects: number;
  directoriesProcessed: number;
  pendingDirectories: number;
  queueLength: number;
  activeWorkers: number;
  totalWorkers: number;
  objectsPerSecond: number;
  error?: string | null;
}

export interface Department {
  id: number;
  rootLabel: string;
  departmentKey: string;
  departmentName: string;
  totalObjects: number;
  problemObjects: number;
  problemPercent: number;
  criticalPaths: number;
  badPaths: number;
  warningPaths: number;
  longNames: number;
  deepPaths: number;
  causeLongParent: number;
  causeDeepTree: number;
  causeLongName: number;
  causeMixed: number;
  maxPathLength: number;
  maxDepth: number;
  hygieneScore: number;
}

export interface DepartmentDelta {
  hasPrevious: boolean;
  previousScanId: number | null;
  hygieneScoreDelta: number;
  problemObjectsDelta: number;
  problemPercentDelta: number;
  criticalPathsDelta: number;
  badPathsDelta: number;
  warningPathsDelta: number;
  maxPathLengthDelta: number;
}

export interface DepartmentListItem {
  department: Department;
  delta: DepartmentDelta;
}

export interface Branch {
  id: number;
  relativePath: string;
  totalObjects: number;
  problemObjects: number;
  problemPercent: number;
  criticalPaths: number;
  badPaths: number;
  warningPaths: number;
  maxPathLength: number;
  maxDepth: number;
}

export interface PathSample {
  id: number;
  sampleKind: string;
  relativePath: string;
  dfsPath: string | null;
  uncPath: string | null;
  name: string | null;
  severity: string | null;
  cause: string | null;
  pathLength: number;
  depth: number;
  nameLength: number;
}

export interface DepartmentHistoryPoint {
  scanId: number;
  startedAtUtc: string;
  hygieneScore: number;
  totalObjects: number;
  problemObjects: number;
  problemPercent: number;
  criticalPaths: number;
  badPaths: number;
  warningPaths: number;
  maxPathLength: number;
  maxDepth: number;
}

export interface DepartmentReport {
  department: Department;
  scanId: number;
  scanStartedAtUtc: string;
  scanFinishedAtUtc: string | null;
  delta: DepartmentDelta;
  okPaths: number;
  warningPaths: number;
  badPaths: number;
  criticalPaths: number;
  branches: Branch[];
  longestPaths: PathSample[];
  deepestPaths: PathSample[];
  longNames: PathSample[];
  history: DepartmentHistoryPoint[];
}
