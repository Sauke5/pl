import type { Department } from '../types/audit';

export const number = new Intl.NumberFormat('ru-RU');

export function plural(value: number, one: string, few: string, many: string) {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  const last = value % 10;
  return last === 1 ? one : last >= 2 && last <= 4 ? few : many;
}

export function dateTime(value?: string | null) {
  if (!value) return 'Нет данных';
  const utcValue = /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`;
  const parsed = new Date(utcValue);
  if (Number.isNaN(parsed.getTime())) return 'Нет данных';
  return parsed.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

export function percent(part: number, total: number) {
  return total > 0 ? `${(part * 100 / total).toFixed(1)}%` : '—';
}

export function departmentAction(department: Department) {
  if (department.problemObjects === 0) {
    return {
      count: 0,
      title: 'Проверить сохранённые примеры',
      detail: 'Сверьте примеры с текущей структурой раздела.',
    };
  }
  const causes = [
    { count: department.causeLongParent, title: 'Сократить общий путь к документам', detail: 'Проверьте верхние папки с ответственным за раздел.' },
    { count: department.causeDeepTree, title: 'Проверить лишние уровни папок', detail: 'Разберите самые глубокие ветки с ответственным за раздел.' },
    { count: department.causeLongName, title: 'Проверить длинные имена документов и папок', detail: 'Начните с сохранённых примеров. Уточните у ответственного, какие имена допустимо сокращать.' },
    { count: department.causeMixed, title: 'Разобрать длинные пути', detail: 'Сверьте вложенность и имена по примерам.' },
  ];
  const leading = causes.sort((a, b) => b.count - a.count)[0];
  return leading.count > 0 ? leading : {
    count: 0,
    title: 'Разобрать сохранённые проблемные пути',
    detail: 'Начните с примеров и веток раздела.',
  };
}

export type Instance = {
  machineName: string;
  roots: { name: string; localPath: string; serverUNC: string; dfsPath: string }[];
  thresholds: { warningPathLength: number; badPathLength: number; criticalPathLength: number; longNameLength: number; maxDepth: number };
  latestCompletedScanId: number | null;
  latestCompletedScanFinishedAtUtc: string | null;
  latestCompletedRootNames: string[];
};

export type Finding = {
  id: number;
  departmentId: number | null;
  departmentKey: string;
  departmentName: string;
  rootLabel: string;
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
};

export type Findings = {
  scanId: number | null;
  scanFinishedAtUtc: string | null;
  isSample: boolean;
  scopeNote: string;
  page: number;
  pageSize: number;
  total: number;
  items: Finding[];
  thresholds: Instance['thresholds'] | null;
};

export type PortalSession = {
  authenticated: boolean;
  csrf_token?: string;
  user?: { id: string; name: string; admin: boolean };
};
