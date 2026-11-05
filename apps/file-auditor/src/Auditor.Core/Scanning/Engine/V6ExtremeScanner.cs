using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace Auditor.Core.Scanning.Engine
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WIN32_FIND_DATA
    {
        public uint dwFileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftLastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftLastWriteTime;
        public uint nFileSizeHigh;
        public uint nFileSizeLow;
        public uint dwReserved0;
        public uint dwReserved1;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string cFileName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)]
        public string cAlternateFileName;
    }

    public enum FINDEX_INFO_LEVELS
    {
        FindExInfoStandard = 0,
        FindExInfoBasic = 1
    }

    public enum FINDEX_SEARCH_OPS
    {
        FindExSearchNameMatch = 0,
        FindExSearchLimitToDirectories = 1,
        FindExSearchLimitToDevices = 2
    }

    public static class NativeMethods
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr FindFirstFileExW(
            string lpFileName,
            FINDEX_INFO_LEVELS fInfoLevelId,
            out WIN32_FIND_DATA lpFindFileData,
            FINDEX_SEARCH_OPS fSearchOp,
            IntPtr lpSearchFilter,
            int dwAdditionalFlags
        );

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool FindNextFileW(
            IntPtr hFindFile,
            out WIN32_FIND_DATA lpFindFileData
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool FindClose(IntPtr hFindFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CreateDirectoryW(string lpPathName, IntPtr lpSecurityAttributes);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool RemoveDirectoryW(string lpPathName);

        public static int LastError()
        {
            return Marshal.GetLastWin32Error();
        }

        public static ulong FileSize(WIN32_FIND_DATA data)
        {
            return ((ulong)data.nFileSizeHigh << 32) | data.nFileSizeLow;
        }

        public static DateTime? LastWriteTime(WIN32_FIND_DATA data)
        {
            try
            {
                ulong high = (uint)data.ftLastWriteTime.dwHighDateTime;
                ulong low = (uint)data.ftLastWriteTime.dwLowDateTime;
                long value = unchecked((long)((high << 32) | low));
                if (value <= 0) return null;
                return DateTime.FromFileTimeUtc(value).ToLocalTime();
            }
            catch
            {
                return null;
            }
        }
    }

    public sealed class RootMap
    {
        public string Label { get; set; }
        public string LocalPath { get; set; }
        public string ServerUNC { get; set; }
        public string DFSPath { get; set; }
    }

    public sealed class ScanOptions
    {
        public int Workers { get; set; }
        public int WarningPathLength { get; set; }
        public int BadPathLength { get; set; }
        public int CriticalPathLength { get; set; }
        public int LongNameLength { get; set; }
        public int MaxDepth { get; set; }
        public int BranchDepth { get; set; }
        public int TopLongest { get; set; }
        public int TopLongNames { get; set; }
        public int TopDeepest { get; set; }
        public int TopAnomalies { get; set; }
        public int ProgressEvery { get; set; }
        public bool FollowReparsePoints { get; set; }
        public bool CaptureAllProblems { get; set; }
    }

    public sealed class ScanError
    {
        public string Label { get; set; }
        public string TopFolder { get; set; }
        public string RelativePath { get; set; }
        public string Operation { get; set; }
        public int Win32Code { get; set; }
        public string Error { get; set; }
    }

    public sealed class Sample
    {
        public string Label { get; set; }
        public string TopFolder { get; set; }
        public string Type { get; set; }
        public string Severity { get; set; }
        public int RiskPathLength { get; set; }
        public int ServerUNCLength { get; set; }
        public int DFSLength { get; set; }
        public int NameLength { get; set; }
        public int Depth { get; set; }
        public string RelativePath { get; set; }
        public DateTime? LastWriteTime { get; set; }
        public ulong SizeBytes { get; set; }
    }

    public sealed class ExtensionStat
    {
        public string Extension { get; set; }
        public long ProblemFiles { get; set; }
        public long CriticalFiles { get; set; }
        public long BadFiles { get; set; }
        public long WarningFiles { get; set; }

        public void MergeFrom(ExtensionStat other)
        {
            ProblemFiles += other.ProblemFiles;
            CriticalFiles += other.CriticalFiles;
            BadFiles += other.BadFiles;
            WarningFiles += other.WarningFiles;
        }
    }

    public sealed class AnomalySample
    {
        public string AnomalyType { get; set; }
        public string Label { get; set; }
        public string TopFolder { get; set; }
        public string RelativePath { get; set; }
        public string Name { get; set; }
        public string Detail { get; set; }
        public int RiskPathLength { get; set; }
    }

    public class Stat
    {
        public string Label { get; set; }
        public string TopFolder { get; set; }

        public long TotalFiles { get; set; }
        public long TotalDirectories { get; set; }
        public long TotalObjects { get; set; }

        public long NormalPaths { get; set; }
        public long WarningPaths { get; set; }
        public long BadPaths { get; set; }
        public long CriticalPaths { get; set; }

        public long ProblemObjects { get; set; }
        public long LongNames { get; set; }
        public long ExcessiveDepth { get; set; }
        public long ReparsePointsSkipped { get; set; }
        public long ErrorCount { get; set; }

        // Exactly one primary cause per ProblemObject.
        public long CauseLongName { get; set; }
        public long CauseDeepTree { get; set; }
        public long CauseLongParent { get; set; }
        public long CauseMixed { get; set; }

        // Age distribution is for CRITICAL FILES only (directories excluded).
        public long CriticalFiles { get; set; }
        public long CriticalAge0To30 { get; set; }
        public long CriticalAge31To365 { get; set; }
        public long CriticalAge1To3Years { get; set; }
        public long CriticalAgeOver3Years { get; set; }
        public long CriticalAgeUnknown { get; set; }

        // Structural/name anomalies. Independent from ProblemObjects.
        public long AnomalyRepeatedSegment { get; set; }
        public long AnomalyPlaceholderName { get; set; }
        public long AnomalyVersionChaos { get; set; }
        public long AnomalyRedundantParent { get; set; }

        public int MaxRiskPathLength { get; set; }
        public string MaxRiskRelativePath { get; set; }

        public int MaxDepth { get; set; }
        public string MaxDepthRelativePath { get; set; }

        public void MergeFrom(Stat other)
        {
            TotalFiles += other.TotalFiles;
            TotalDirectories += other.TotalDirectories;
            TotalObjects += other.TotalObjects;

            NormalPaths += other.NormalPaths;
            WarningPaths += other.WarningPaths;
            BadPaths += other.BadPaths;
            CriticalPaths += other.CriticalPaths;

            ProblemObjects += other.ProblemObjects;
            LongNames += other.LongNames;
            ExcessiveDepth += other.ExcessiveDepth;
            ReparsePointsSkipped += other.ReparsePointsSkipped;
            ErrorCount += other.ErrorCount;

            CauseLongName += other.CauseLongName;
            CauseDeepTree += other.CauseDeepTree;
            CauseLongParent += other.CauseLongParent;
            CauseMixed += other.CauseMixed;

            CriticalFiles += other.CriticalFiles;
            CriticalAge0To30 += other.CriticalAge0To30;
            CriticalAge31To365 += other.CriticalAge31To365;
            CriticalAge1To3Years += other.CriticalAge1To3Years;
            CriticalAgeOver3Years += other.CriticalAgeOver3Years;
            CriticalAgeUnknown += other.CriticalAgeUnknown;

            AnomalyRepeatedSegment += other.AnomalyRepeatedSegment;
            AnomalyPlaceholderName += other.AnomalyPlaceholderName;
            AnomalyVersionChaos += other.AnomalyVersionChaos;
            AnomalyRedundantParent += other.AnomalyRedundantParent;

            if (other.MaxRiskPathLength > MaxRiskPathLength)
            {
                MaxRiskPathLength = other.MaxRiskPathLength;
                MaxRiskRelativePath = other.MaxRiskRelativePath;
            }

            if (other.MaxDepth > MaxDepth)
            {
                MaxDepth = other.MaxDepth;
                MaxDepthRelativePath = other.MaxDepthRelativePath;
            }
        }
    }

    public class BranchStat : Stat
    {
        public string Branch { get; set; }
        public Dictionary<int,long> ProblemLengthHistogram { get; set; }

        public BranchStat()
        {
            ProblemLengthHistogram = new Dictionary<int,long>();
        }
    }

    public sealed class ScanResult
    {
        public DateTime StartTime { get; set; }
        public DateTime EndTime { get; set; }
        public TimeSpan Duration { get; set; }

        public int Workers { get; set; }
        public int PeakActiveWorkers { get; set; }

        public long DirectoriesProcessed { get; set; }
        public long TotalFiles { get; set; }
        public long TotalDirectories { get; set; }
        public long TotalObjects { get; set; }

        public long NormalPaths { get; set; }
        public long WarningPaths { get; set; }
        public long BadPaths { get; set; }
        public long CriticalPaths { get; set; }

        public long ProblemObjects { get; set; }
        public long LongNames { get; set; }
        public long ExcessiveDepth { get; set; }
        public long ReparsePointsSkipped { get; set; }

        public int MaxRiskPathLength { get; set; }
        public string MaxRiskLabel { get; set; }
        public string MaxRiskTopFolder { get; set; }
        public string MaxRiskRelativePath { get; set; }

        public int MaxDepth { get; set; }
        public string MaxDepthLabel { get; set; }
        public string MaxDepthTopFolder { get; set; }
        public string MaxDepthRelativePath { get; set; }

        public List<Stat> Departments { get; set; }
        public List<Stat> Roots { get; set; }
        public List<BranchStat> Branches { get; set; }

        public List<Sample> Longest { get; set; }
        public List<Sample> LongNamesTop { get; set; }
        public List<Sample> Deepest { get; set; }

        // Stage 4.3: independent TOP-K samples for every department.
        // These lists are not globally ranked; each department contributes
        // up to DepartmentSampleLimit items per category.
        public List<Sample> DepartmentLongest { get; set; }
        public List<Sample> DepartmentLongNamesTop { get; set; }
        public List<Sample> DepartmentDeepest { get; set; }

        public List<ExtensionStat> Extensions { get; set; }
        public List<AnomalySample> Anomalies { get; set; }

        public List<ScanError> Errors { get; set; }
        public List<Sample> AllProblems { get; set; }
    }

    internal sealed class DirWork
    {
        public RootMap Root;
        public string LocalDisplay;
        public string LocalWin32;
        public string Relative;
        public string TopFolder;
        public int Depth;
    }

    internal sealed class MutableStat : Stat
    {
        public void Register(
            bool isDirectory,
            string severity,
            bool isProblem,
            bool longName,
            bool tooDeep,
            string cause,
            int criticalAgeBucket,
            int riskLength,
            int depth,
            string relative)
        {
            TotalObjects++;
            if (isDirectory) TotalDirectories++;
            else TotalFiles++;

            switch (severity)
            {
                case "CRITICAL": CriticalPaths++; break;
                case "BAD": BadPaths++; break;
                case "WARNING": WarningPaths++; break;
                default: NormalPaths++; break;
            }

            if (isProblem) ProblemObjects++;
            if (longName) LongNames++;
            if (tooDeep) ExcessiveDepth++;

            if (isProblem)
            {
                switch (cause)
                {
                    case "LONG_NAME": CauseLongName++; break;
                    case "DEEP_TREE": CauseDeepTree++; break;
                    case "MIXED": CauseMixed++; break;
                    case "LONG_PARENT": CauseLongParent++; break;
                }
            }

            if (!isDirectory && severity == "CRITICAL")
            {
                CriticalFiles++;
                switch (criticalAgeBucket)
                {
                    case 1: CriticalAge0To30++; break;
                    case 2: CriticalAge31To365++; break;
                    case 3: CriticalAge1To3Years++; break;
                    case 4: CriticalAgeOver3Years++; break;
                    default: CriticalAgeUnknown++; break;
                }
            }

            if (riskLength > MaxRiskPathLength)
            {
                MaxRiskPathLength = riskLength;
                MaxRiskRelativePath = relative;
            }

            if (depth > MaxDepth)
            {
                MaxDepth = depth;
                MaxDepthRelativePath = relative;
            }
        }
    }

    internal sealed class MutableBranchStat : BranchStat
    {
        public void Register(
            bool isDirectory,
            string severity,
            bool isProblem,
            bool longName,
            bool tooDeep,
            string cause,
            int criticalAgeBucket,
            int riskLength,
            int depth,
            string relative,
            int warningThreshold)
        {
            TotalObjects++;
            if (isDirectory) TotalDirectories++;
            else TotalFiles++;

            switch (severity)
            {
                case "CRITICAL": CriticalPaths++; break;
                case "BAD": BadPaths++; break;
                case "WARNING": WarningPaths++; break;
                default: NormalPaths++; break;
            }

            if (isProblem) ProblemObjects++;
            if (longName) LongNames++;
            if (tooDeep) ExcessiveDepth++;

            if (isProblem)
            {
                switch (cause)
                {
                    case "LONG_NAME": CauseLongName++; break;
                    case "DEEP_TREE": CauseDeepTree++; break;
                    case "MIXED": CauseMixed++; break;
                    case "LONG_PARENT": CauseLongParent++; break;
                }
            }

            if (!isDirectory && severity == "CRITICAL")
            {
                CriticalFiles++;
                switch (criticalAgeBucket)
                {
                    case 1: CriticalAge0To30++; break;
                    case 2: CriticalAge31To365++; break;
                    case 3: CriticalAge1To3Years++; break;
                    case 4: CriticalAgeOver3Years++; break;
                    default: CriticalAgeUnknown++; break;
                }
            }

            // Only lengths that can currently be a path-length problem are needed
            // for "what if we shorten this branch?" simulation.
            if (riskLength > warningThreshold)
            {
                long count;
                if (!ProblemLengthHistogram.TryGetValue(riskLength, out count))
                    count = 0;
                ProblemLengthHistogram[riskLength] = count + 1;
            }

            if (riskLength > MaxRiskPathLength)
            {
                MaxRiskPathLength = riskLength;
                MaxRiskRelativePath = relative;
            }

            if (depth > MaxDepth)
            {
                MaxDepth = depth;
                MaxDepthRelativePath = relative;
            }
        }
    }

    internal sealed class DepartmentSampleBucket
    {
        public string Label;
        public string TopFolder;

        public readonly List<Sample> Longest = new List<Sample>();
        public readonly List<Sample> LongNamesTop = new List<Sample>();
        public readonly List<Sample> Deepest = new List<Sample>();
    }

    internal sealed class LocalAccumulator
    {
        public readonly Dictionary<string, MutableStat> Departments =
            new Dictionary<string, MutableStat>(StringComparer.OrdinalIgnoreCase);

        public readonly Dictionary<string, MutableStat> Roots =
            new Dictionary<string, MutableStat>(StringComparer.OrdinalIgnoreCase);

        public readonly Dictionary<string, MutableBranchStat> Branches =
            new Dictionary<string, MutableBranchStat>(StringComparer.OrdinalIgnoreCase);

        public readonly List<Sample> Longest = new List<Sample>();
        public readonly List<Sample> LongNamesTop = new List<Sample>();
        public readonly List<Sample> Deepest = new List<Sample>();

        // Stage 4.3: worker-local per-department samples. No locks are needed
        // because each LocalAccumulator belongs to exactly one scanner worker.
        public readonly Dictionary<string, DepartmentSampleBucket> DepartmentSamples =
            new Dictionary<string, DepartmentSampleBucket>(StringComparer.OrdinalIgnoreCase);

        public readonly Dictionary<string, ExtensionStat> Extensions =
            new Dictionary<string, ExtensionStat>(StringComparer.OrdinalIgnoreCase);

        public readonly List<AnomalySample> Anomalies = new List<AnomalySample>();

        public readonly List<ScanError> Errors = new List<ScanError>();
        public readonly List<Sample> AllProblems = new List<Sample>();
    }

    public sealed class ProgressSnapshot
    {
        public long ProcessedObjects { get; set; }
        public long DirectoriesProcessed { get; set; }
        public long PendingDirectories { get; set; }
        public int QueueLength { get; set; }
        public int ActiveWorkers { get; set; }
        public int TotalWorkers { get; set; }
    }

    public static class ExtremeScanner
    {
        public static Action<ProgressSnapshot> ProgressChanged { get; set; }
        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;

        private const int ERROR_FILE_NOT_FOUND = 2;
        private const int ERROR_PATH_NOT_FOUND = 3;
        private const int ERROR_NO_MORE_FILES = 18;
        private const int ERROR_INVALID_PARAMETER = 87;

        private const int FIND_FIRST_EX_LARGE_FETCH = 2;

        private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

        private static long _processed;
        private static long _directoriesProcessed;
        private static long _pendingDirectories;
        private static long _nextProgress;
        private static int _activeWorkers;
        private static int _peakActiveWorkers;
        private static DateTime _scanNow;

        // Representative examples are intentionally bounded.
        private const int DepartmentSampleLimit = 20;

        private static string Join(string left, string right)
        {
            if (String.IsNullOrEmpty(left)) return right ?? "";
            if (String.IsNullOrEmpty(right)) return left;
            return left.TrimEnd('\\') + "\\" + right.TrimStart('\\');
        }

        private static string ToWin32(string path)
        {
            if (String.IsNullOrWhiteSpace(path)) return path;
            if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
            if (path.StartsWith(@"\\", StringComparison.Ordinal))
                return @"\\?\UNC\" + path.Substring(2);
            return @"\\?\" + path;
        }

        private static int UserPathLength(string root, string relative)
        {
            if (String.IsNullOrWhiteSpace(root)) return 0;
            int rootLength = root.TrimEnd('\\').Length;
            if (String.IsNullOrWhiteSpace(relative)) return rootLength;
            return rootLength + 1 + relative.TrimStart('\\').Length;
        }

        private static string Severity(int length, ScanOptions opt)
        {
            if (length > opt.CriticalPathLength) return "CRITICAL";
            if (length > opt.BadPathLength) return "BAD";
            if (length > opt.WarningPathLength) return "WARNING";
            return "OK";
        }

        private static string PrimaryCause(bool pathProblem, bool longName, bool tooDeep)
        {
            if (longName && tooDeep) return "MIXED";
            if (longName) return "LONG_NAME";
            if (tooDeep) return "DEEP_TREE";
            if (pathProblem) return "LONG_PARENT";
            return "NONE";
        }

        private static int CriticalAgeBucket(bool isDirectory, string severity, DateTime? lastWriteTime)
        {
            if (isDirectory || severity != "CRITICAL") return 0;
            if (!lastWriteTime.HasValue) return 5;

            double days = (_scanNow - lastWriteTime.Value).TotalDays;
            if (days < 0) days = 0;
            if (days <= 30) return 1;
            if (days <= 365) return 2;
            if (days <= 1095) return 3;
            return 4;
        }

        private static string ExtensionKey(string name)
        {
            if (String.IsNullOrWhiteSpace(name)) return "[без расширения]";
            int dot = name.LastIndexOf('.');
            if (dot <= 0 || dot == name.Length - 1) return "[без расширения]";
            string ext = name.Substring(dot).ToLowerInvariant();
            if (ext.Length > 20) return "[длинное/аномальное расширение]";
            return ext;
        }

        private static string ParentLeaf(string relativeParent)
        {
            if (String.IsNullOrWhiteSpace(relativeParent)) return "";
            int idx = relativeParent.LastIndexOf('\\');
            return idx < 0 ? relativeParent : relativeParent.Substring(idx + 1);
        }

        private static bool IsPlaceholderName(string name)
        {
            if (String.IsNullOrWhiteSpace(name)) return false;
            string n = name.Trim();

            return String.Equals(n, "новая папка", StringComparison.OrdinalIgnoreCase) ||
                   String.Equals(n, "new folder", StringComparison.OrdinalIgnoreCase) ||
                   String.Equals(n, "без названия", StringComparison.OrdinalIgnoreCase) ||
                   String.Equals(n, "untitled", StringComparison.OrdinalIgnoreCase) ||
                   String.Equals(n, "копия", StringComparison.OrdinalIgnoreCase) ||
                   String.Equals(n, "copy", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsVersionChaos(string name)
        {
            if (String.IsNullOrEmpty(name)) return false;

            return name.IndexOf("final", StringComparison.OrdinalIgnoreCase) >= 0 ||
                   name.IndexOf("финал", StringComparison.OrdinalIgnoreCase) >= 0 ||
                   name.IndexOf("последняя версия", StringComparison.OrdinalIgnoreCase) >= 0 ||
                   name.IndexOf("окончательн", StringComparison.OrdinalIgnoreCase) >= 0 ||
                   name.IndexOf("итогов", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static void RegisterExtension(
            LocalAccumulator acc,
            string name,
            string severity,
            bool isProblem)
        {
            if (!isProblem) return;

            string key = ExtensionKey(name);
            ExtensionStat stat;
            if (!acc.Extensions.TryGetValue(key, out stat))
            {
                stat = new ExtensionStat { Extension = key };
                acc.Extensions.Add(key, stat);
            }

            stat.ProblemFiles++;
            switch (severity)
            {
                case "CRITICAL": stat.CriticalFiles++; break;
                case "BAD": stat.BadFiles++; break;
                case "WARNING": stat.WarningFiles++; break;
            }
        }

        private static void AddAnomalySample(
            LocalAccumulator acc,
            ScanOptions opt,
            string anomalyType,
            DirWork work,
            string topFolder,
            string relative,
            string name,
            string detail,
            int riskLength)
        {
            if (acc.Anomalies.Count >= opt.TopAnomalies * 4) return;

            acc.Anomalies.Add(new AnomalySample
            {
                AnomalyType = anomalyType,
                Label = work.Root.Label,
                TopFolder = String.IsNullOrWhiteSpace(topFolder) ? "[ROOT]" : topFolder,
                RelativePath = relative,
                Name = name,
                Detail = detail,
                RiskPathLength = riskLength
            });
        }

        private static string ErrorMessage(int code)
        {
            try { return new Win32Exception(code).Message; }
            catch { return "Win32 error " + code; }
        }

        private static IntPtr OpenFind(string pattern, out WIN32_FIND_DATA data)
        {
            IntPtr h = NativeMethods.FindFirstFileExW(
                pattern,
                FINDEX_INFO_LEVELS.FindExInfoBasic,
                out data,
                FINDEX_SEARCH_OPS.FindExSearchNameMatch,
                IntPtr.Zero,
                FIND_FIRST_EX_LARGE_FETCH);

            if (h == INVALID_HANDLE_VALUE)
            {
                int code = NativeMethods.LastError();
                if (code == ERROR_INVALID_PARAMETER)
                {
                    h = NativeMethods.FindFirstFileExW(
                        pattern,
                        FINDEX_INFO_LEVELS.FindExInfoBasic,
                        out data,
                        FINDEX_SEARCH_OPS.FindExSearchNameMatch,
                        IntPtr.Zero,
                        0);
                }
            }
            return h;
        }

        private static void UpdatePeak(int current)
        {
            int observed;
            do
            {
                observed = _peakActiveWorkers;
                if (current <= observed) return;
            }
            while (Interlocked.CompareExchange(ref _peakActiveWorkers, current, observed) != observed);
        }

        private static void MaybeProgress(int progressEvery, BlockingCollection<DirWork> queue, int workers)
        {
            long current = Interlocked.Read(ref _processed);
            long target = Interlocked.Read(ref _nextProgress);

            if (current < target) return;

            long next = target + progressEvery;
            if (Interlocked.CompareExchange(ref _nextProgress, next, target) == target)
            {
                long dirs = Interlocked.Read(ref _directoriesProcessed);
                long pending = Interlocked.Read(ref _pendingDirectories);
                int active = Volatile.Read(ref _activeWorkers);

                var callback = ProgressChanged;
                if (callback != null)
                {
                    callback(
                        new ProgressSnapshot
                        {
                            ProcessedObjects = current,
                            DirectoriesProcessed = dirs,
                            PendingDirectories = pending,
                            QueueLength = queue.Count,
                            ActiveWorkers = active,
                            TotalWorkers = workers
                        });
                }
            }
        }

        private static string BuildBranch(string relative, bool isDirectory, int branchDepth)
        {
            if (String.IsNullOrWhiteSpace(relative)) return "";

            int usableLength = relative.Length;
            if (!isDirectory)
            {
                int lastSlash = relative.LastIndexOf('\\');
                if (lastSlash <= 0) return relative;
                usableLength = lastSlash;
            }

            int components = 1;
            for (int i = 0; i < usableLength; i++)
            {
                if (relative[i] == '\\')
                {
                    components++;
                    if (components > branchDepth)
                        return relative.Substring(0, i);
                }
            }

            if (usableLength == relative.Length) return relative;
            return relative.Substring(0, usableLength);
        }

        private static MutableStat GetDepartment(LocalAccumulator acc, string label, string topFolder)
        {
            string key = label + "\u001F" + (topFolder ?? "[ROOT]");
            MutableStat stat;
            if (!acc.Departments.TryGetValue(key, out stat))
            {
                stat = new MutableStat
                {
                    Label = label,
                    TopFolder = String.IsNullOrWhiteSpace(topFolder) ? "[ROOT]" : topFolder
                };
                acc.Departments.Add(key, stat);
            }
            return stat;
        }

        private static DepartmentSampleBucket GetDepartmentSamples(
            LocalAccumulator acc,
            string label,
            string topFolder)
        {
            string normalizedTopFolder =
                String.IsNullOrWhiteSpace(topFolder) ? "[ROOT]" : topFolder;

            string key = label + "\u001F" + normalizedTopFolder;

            DepartmentSampleBucket bucket;
            if (!acc.DepartmentSamples.TryGetValue(key, out bucket))
            {
                bucket = new DepartmentSampleBucket
                {
                    Label = label,
                    TopFolder = normalizedTopFolder
                };

                acc.DepartmentSamples.Add(key, bucket);
            }

            return bucket;
        }

        private static MutableStat GetRoot(LocalAccumulator acc, string label)
        {
            MutableStat stat;
            if (!acc.Roots.TryGetValue(label, out stat))
            {
                stat = new MutableStat
                {
                    Label = label,
                    TopFolder = "[ROOT]"
                };
                acc.Roots.Add(label, stat);
            }
            return stat;
        }

        private static MutableBranchStat GetBranch(
            LocalAccumulator acc,
            string label,
            string topFolder,
            string branch)
        {
            string key = label + "\u001F" + (topFolder ?? "[ROOT]") + "\u001F" + branch;
            MutableBranchStat stat;
            if (!acc.Branches.TryGetValue(key, out stat))
            {
                stat = new MutableBranchStat
                {
                    Label = label,
                    TopFolder = String.IsNullOrWhiteSpace(topFolder) ? "[ROOT]" : topFolder,
                    Branch = branch
                };
                acc.Branches.Add(key, stat);
            }
            return stat;
        }

        private static int CompareSample(Sample a, Sample b, Func<Sample, int> keySelector)
        {
            return keySelector(b).CompareTo(keySelector(a));
        }

        private static void KeepTop(
            List<Sample> list,
            Sample sample,
            int limit,
            Func<Sample, int> keySelector)
        {
            if (limit <= 0) return;

            int value = keySelector(sample);

            if (list.Count >= limit)
            {
                Sample last = list[list.Count - 1];
                if (value <= keySelector(last)) return;
            }

            int lo = 0;
            int hi = list.Count;
            while (lo < hi)
            {
                int mid = lo + ((hi - lo) / 2);
                if (keySelector(list[mid]) >= value) lo = mid + 1;
                else hi = mid;
            }

            list.Insert(lo, sample);
            if (list.Count > limit) list.RemoveAt(list.Count - 1);
        }

        private static void MergeTop(
            List<Sample> target,
            IEnumerable<Sample> source,
            int limit,
            Func<Sample, int> keySelector)
        {
            foreach (Sample s in source)
                KeepTop(target, s, limit, keySelector);
        }

        private static void MergeDepartmentSamples(
            Dictionary<string, DepartmentSampleBucket> target,
            Dictionary<string, DepartmentSampleBucket> source)
        {
            foreach (var pair in source)
            {
                DepartmentSampleBucket existing;
                if (!target.TryGetValue(pair.Key, out existing))
                {
                    existing = new DepartmentSampleBucket
                    {
                        Label = pair.Value.Label,
                        TopFolder = pair.Value.TopFolder
                    };

                    target.Add(pair.Key, existing);
                }

                MergeTop(
                    existing.Longest,
                    pair.Value.Longest,
                    DepartmentSampleLimit,
                    x => x.RiskPathLength);

                MergeTop(
                    existing.LongNamesTop,
                    pair.Value.LongNamesTop,
                    DepartmentSampleLimit,
                    x => x.NameLength);

                MergeTop(
                    existing.Deepest,
                    pair.Value.Deepest,
                    DepartmentSampleLimit,
                    x => x.Depth);
            }
        }

        private static void RegisterItem(
            LocalAccumulator acc,
            DirWork work,
            string name,
            string relative,
            string topFolder,
            bool isDirectory,
            uint attributes,
            ulong sizeBytes,
            DateTime? lastWriteTime,
            int depth,
            ScanOptions opt,
            BlockingCollection<DirWork> queue)
        {
            int serverLen = UserPathLength(work.Root.ServerUNC, relative);
            int dfsLen = UserPathLength(work.Root.DFSPath, relative);
            int riskLen = Math.Max(serverLen, dfsLen);

            string severity = Severity(riskLen, opt);
            int nameLen = name.Length;

            bool longName = nameLen > opt.LongNameLength;
            bool tooDeep = depth > opt.MaxDepth;
            bool pathProblem = severity != "OK";
            bool isProblem = pathProblem || longName || tooDeep;
            string cause = PrimaryCause(pathProblem, longName, tooDeep);
            int criticalAgeBucket = CriticalAgeBucket(isDirectory, severity, lastWriteTime);

            MutableStat department = GetDepartment(acc, work.Root.Label, topFolder);
            MutableStat root = GetRoot(acc, work.Root.Label);

            department.Register(
                isDirectory, severity, isProblem, longName, tooDeep,
                cause, criticalAgeBucket, riskLen, depth, relative);

            root.Register(
                isDirectory, severity, isProblem, longName, tooDeep,
                cause, criticalAgeBucket, riskLen, depth, relative);

            string branch = BuildBranch(relative, isDirectory, opt.BranchDepth);
            if (!String.IsNullOrWhiteSpace(branch))
            {
                MutableBranchStat branchStat =
                    GetBranch(acc, work.Root.Label, topFolder, branch);

                branchStat.Register(
                    isDirectory, severity, isProblem, longName, tooDeep,
                    cause, criticalAgeBucket, riskLen, depth, relative,
                    opt.WarningPathLength);
            }

            if (!isDirectory)
                RegisterExtension(acc, name, severity, isProblem);

            // Cheap structural anomaly heuristics. They are diagnostic, not policy.
            // Avoid parent-name substring allocation for the common short-file case.
            string parentLeaf = (isDirectory || name.Length >= 30)
                ? ParentLeaf(work.Relative)
                : "";

            bool repeated = isDirectory &&
                !String.IsNullOrWhiteSpace(parentLeaf) &&
                String.Equals(parentLeaf, name, StringComparison.OrdinalIgnoreCase);

            bool placeholder = IsPlaceholderName(name);
            bool versionChaos = IsVersionChaos(name);

            bool redundantParent =
                name.Length >= 30 &&
                !String.IsNullOrWhiteSpace(parentLeaf) &&
                parentLeaf.Length >= 16 &&
                name.IndexOf(parentLeaf, StringComparison.OrdinalIgnoreCase) >= 0;

            if (repeated)
            {
                department.AnomalyRepeatedSegment++;
                root.AnomalyRepeatedSegment++;
                AddAnomalySample(acc,opt,"REPEATED_SEGMENT",work,topFolder,relative,name,
                    "Имя совпадает с родительской папкой.",riskLen);
            }

            if (placeholder)
            {
                department.AnomalyPlaceholderName++;
                root.AnomalyPlaceholderName++;
                AddAnomalySample(acc,opt,"PLACEHOLDER_NAME",work,topFolder,relative,name,
                    "Шаблонное/временное имя.",riskLen);
            }

            if (versionChaos)
            {
                department.AnomalyVersionChaos++;
                root.AnomalyVersionChaos++;
                AddAnomalySample(acc,opt,"VERSION_CHAOS",work,topFolder,relative,name,
                    "Имя похоже на ручное версионирование final/финал/итог.",riskLen);
            }

            if (redundantParent && !repeated)
            {
                department.AnomalyRedundantParent++;
                root.AnomalyRedundantParent++;
                AddAnomalySample(acc,opt,"REDUNDANT_PARENT",work,topFolder,relative,name,
                    "Имя объекта повторяет длинное имя родительской папки.",riskLen);
            }

            Sample sample = null;

            // Existing global samples are preserved exactly as before.
            bool candidateLongest =
                riskLen > opt.WarningPathLength &&
                (acc.Longest.Count < opt.TopLongest ||
                 riskLen > acc.Longest[acc.Longest.Count - 1].RiskPathLength);

            bool candidateName =
                longName &&
                (acc.LongNamesTop.Count < opt.TopLongNames ||
                 nameLen > acc.LongNamesTop[acc.LongNamesTop.Count - 1].NameLength);

            bool candidateDepth =
                tooDeep &&
                (acc.Deepest.Count < opt.TopDeepest ||
                 depth > acc.Deepest[acc.Deepest.Count - 1].Depth);

            // Stage 4.3 departmental samples are independent from policy
            // thresholds. Even a clean department gets representative TOPs.
            DepartmentSampleBucket departmentSamples =
                GetDepartmentSamples(acc, work.Root.Label, topFolder);

            bool candidateDepartmentLongest =
                departmentSamples.Longest.Count < DepartmentSampleLimit ||
                riskLen >
                    departmentSamples.Longest[
                        departmentSamples.Longest.Count - 1].RiskPathLength;

            bool candidateDepartmentName =
                departmentSamples.LongNamesTop.Count < DepartmentSampleLimit ||
                nameLen >
                    departmentSamples.LongNamesTop[
                        departmentSamples.LongNamesTop.Count - 1].NameLength;

            bool candidateDepartmentDepth =
                departmentSamples.Deepest.Count < DepartmentSampleLimit ||
                depth >
                    departmentSamples.Deepest[
                        departmentSamples.Deepest.Count - 1].Depth;

            if (candidateLongest ||
                candidateName ||
                candidateDepth ||
                candidateDepartmentLongest ||
                candidateDepartmentName ||
                candidateDepartmentDepth ||
                (opt.CaptureAllProblems && isProblem))
            {
                sample = new Sample
                {
                    Label = work.Root.Label,
                    TopFolder = String.IsNullOrWhiteSpace(topFolder) ? "[ROOT]" : topFolder,
                    Type = isDirectory ? "Directory" : "File",
                    Severity = severity,
                    RiskPathLength = riskLen,
                    ServerUNCLength = serverLen,
                    DFSLength = dfsLen,
                    NameLength = nameLen,
                    Depth = depth,
                    RelativePath = relative,
                    LastWriteTime = lastWriteTime,
                    SizeBytes = sizeBytes
                };
            }

            if (candidateLongest)
                KeepTop(acc.Longest, sample, opt.TopLongest, x => x.RiskPathLength);

            if (candidateName)
                KeepTop(acc.LongNamesTop, sample, opt.TopLongNames, x => x.NameLength);

            if (candidateDepth)
                KeepTop(acc.Deepest, sample, opt.TopDeepest, x => x.Depth);

            if (candidateDepartmentLongest)
                KeepTop(
                    departmentSamples.Longest,
                    sample,
                    DepartmentSampleLimit,
                    x => x.RiskPathLength);

            if (candidateDepartmentName)
                KeepTop(
                    departmentSamples.LongNamesTop,
                    sample,
                    DepartmentSampleLimit,
                    x => x.NameLength);

            if (candidateDepartmentDepth)
                KeepTop(
                    departmentSamples.Deepest,
                    sample,
                    DepartmentSampleLimit,
                    x => x.Depth);

            if (opt.CaptureAllProblems && isProblem)
                acc.AllProblems.Add(sample);

            Interlocked.Increment(ref _processed);
            MaybeProgress(opt.ProgressEvery, queue, opt.Workers);
        }

        private static void AddError(
            LocalAccumulator acc,
            DirWork work,
            string relative,
            string operation,
            int code)
        {
            acc.Errors.Add(new ScanError
            {
                Label = work.Root.Label,
                TopFolder = String.IsNullOrWhiteSpace(work.TopFolder) ? "[ROOT]" : work.TopFolder,
                RelativePath = relative,
                Operation = operation,
                Win32Code = code,
                Error = ErrorMessage(code)
            });
        }

        private static void ProcessDirectory(
            DirWork work,
            LocalAccumulator acc,
            BlockingCollection<DirWork> queue,
            ScanOptions opt)
        {
            string pattern = Join(work.LocalWin32, "*");
            WIN32_FIND_DATA data;
            IntPtr h = OpenFind(pattern, out data);

            if (h == INVALID_HANDLE_VALUE)
            {
                int code = NativeMethods.LastError();
                if (code != ERROR_FILE_NOT_FOUND && code != ERROR_PATH_NOT_FOUND)
                    AddError(acc, work, work.Relative, "FindFirstFileExW", code);
                return;
            }

            try
            {
                bool more = true;
                while (more)
                {
                    string name = data.cFileName;

                    if (!String.IsNullOrEmpty(name) && name != "." && name != "..")
                    {
                        uint attr = data.dwFileAttributes;
                        bool isDir = (attr & FILE_ATTRIBUTE_DIRECTORY) != 0;
                        bool isReparse = (attr & FILE_ATTRIBUTE_REPARSE_POINT) != 0;

                        string relative = Join(work.Relative, name);
                        string topFolder =
                            String.IsNullOrWhiteSpace(work.TopFolder)
                                ? name
                                : work.TopFolder;

                        int depth = work.Depth + 1;

                        RegisterItem(
                            acc,
                            work,
                            name,
                            relative,
                            topFolder,
                            isDir,
                            attr,
                            NativeMethods.FileSize(data),
                            NativeMethods.LastWriteTime(data),
                            depth,
                            opt,
                            queue);

                        if (isDir)
                        {
                            if (isReparse && !opt.FollowReparsePoints)
                            {
                                GetDepartment(acc, work.Root.Label, topFolder)
                                    .ReparsePointsSkipped++;
                                GetRoot(acc, work.Root.Label)
                                    .ReparsePointsSkipped++;
                            }
                            else
                            {
                                Interlocked.Increment(ref _pendingDirectories);

                                queue.Add(new DirWork
                                {
                                    Root = work.Root,
                                    LocalDisplay = Join(work.LocalDisplay, name),
                                    LocalWin32 = Join(work.LocalWin32, name),
                                    Relative = relative,
                                    TopFolder = topFolder,
                                    Depth = depth
                                });
                            }
                        }
                    }

                    WIN32_FIND_DATA next;
                    more = NativeMethods.FindNextFileW(h, out next);
                    if (more)
                    {
                        data = next;
                    }
                    else
                    {
                        int code = NativeMethods.LastError();
                        if (code != ERROR_NO_MORE_FILES)
                            AddError(acc, work, work.Relative, "FindNextFileW", code);
                    }
                }
            }
            finally
            {
                NativeMethods.FindClose(h);
            }
        }

        private static void MergeStats(
            Dictionary<string, Stat> target,
            Dictionary<string, MutableStat> source)
        {
            foreach (var pair in source)
            {
                Stat existing;
                if (!target.TryGetValue(pair.Key, out existing))
                {
                    existing = new Stat
                    {
                        Label = pair.Value.Label,
                        TopFolder = pair.Value.TopFolder
                    };
                    target.Add(pair.Key, existing);
                }
                existing.MergeFrom(pair.Value);
            }
        }

        private static void MergeBranches(
            Dictionary<string, BranchStat> target,
            Dictionary<string, MutableBranchStat> source)
        {
            foreach (var pair in source)
            {
                BranchStat existing;
                if (!target.TryGetValue(pair.Key, out existing))
                {
                    existing = new BranchStat
                    {
                        Label = pair.Value.Label,
                        TopFolder = pair.Value.TopFolder,
                        Branch = pair.Value.Branch
                    };
                    target.Add(pair.Key, existing);
                }
                existing.MergeFrom(pair.Value);

                foreach (var h in pair.Value.ProblemLengthHistogram)
                {
                    long count;
                    if (!existing.ProblemLengthHistogram.TryGetValue(h.Key, out count))
                        count = 0;
                    existing.ProblemLengthHistogram[h.Key] = count + h.Value;
                }
            }
        }

        private static void MergeExtensions(
            Dictionary<string, ExtensionStat> target,
            Dictionary<string, ExtensionStat> source)
        {
            foreach (var pair in source)
            {
                ExtensionStat existing;
                if (!target.TryGetValue(pair.Key, out existing))
                {
                    existing = new ExtensionStat { Extension = pair.Value.Extension };
                    target.Add(pair.Key, existing);
                }
                existing.MergeFrom(pair.Value);
            }
        }

        public static ScanResult Scan(RootMap[] roots, ScanOptions opt)
        {
            if (roots == null || roots.Length == 0)
                throw new ArgumentException("At least one RootMap is required.");

            if (opt == null)
                throw new ArgumentNullException("opt");

            _processed = 0;
            _directoriesProcessed = 0;
            _activeWorkers = 0;
            _peakActiveWorkers = 0;
            _nextProgress = opt.ProgressEvery;

            DateTime start = DateTime.Now;
            _scanNow = start;
            Stopwatch sw = Stopwatch.StartNew();

            var queue = new BlockingCollection<DirWork>(
                new ConcurrentQueue<DirWork>());

            _pendingDirectories = 0;

            foreach (RootMap root in roots)
            {
                if (root == null || String.IsNullOrWhiteSpace(root.LocalPath))
                    continue;

                Interlocked.Increment(ref _pendingDirectories);
                queue.Add(new DirWork
                {
                    Root = root,
                    LocalDisplay = root.LocalPath.TrimEnd('\\'),
                    LocalWin32 = ToWin32(root.LocalPath.TrimEnd('\\')),
                    Relative = "",
                    TopFolder = null,
                    Depth = 0
                });
            }

            if (Interlocked.Read(ref _pendingDirectories) == 0)
                throw new InvalidOperationException("No valid roots were queued.");

            var accumulators = new LocalAccumulator[opt.Workers];
            var tasks = new Task[opt.Workers];

            for (int i = 0; i < opt.Workers; i++)
            {
                int workerIndex = i;
                accumulators[workerIndex] = new LocalAccumulator();

                tasks[workerIndex] = Task.Factory.StartNew(
                    () =>
                    {
                        Thread.CurrentThread.Name =
                            "FileStructureAuditor-" + workerIndex.ToString();

                        LocalAccumulator acc = accumulators[workerIndex];

                        foreach (DirWork work in queue.GetConsumingEnumerable())
                        {
                            int active = Interlocked.Increment(ref _activeWorkers);
                            UpdatePeak(active);

                            try
                            {
                                ProcessDirectory(work, acc, queue, opt);
                            }
                            catch (Exception ex)
                            {
                                acc.Errors.Add(new ScanError
                                {
                                    Label = work.Root.Label,
                                    TopFolder = String.IsNullOrWhiteSpace(work.TopFolder)
                                        ? "[ROOT]" : work.TopFolder,
                                    RelativePath = work.Relative,
                                    Operation = "WorkerUnhandled",
                                    Win32Code = 0,
                                    Error = ex.ToString()
                                });
                            }
                            finally
                            {
                                Interlocked.Decrement(ref _activeWorkers);
                                Interlocked.Increment(ref _directoriesProcessed);

                                if (Interlocked.Decrement(ref _pendingDirectories) == 0)
                                {
                                    try { queue.CompleteAdding(); }
                                    catch { }
                                }
                            }
                        }
                    },
                    CancellationToken.None,
                    TaskCreationOptions.LongRunning,
                    TaskScheduler.Default);
            }

            Task.WaitAll(tasks);
            sw.Stop();

            var dep = new Dictionary<string, Stat>(StringComparer.OrdinalIgnoreCase);
            var rootStats = new Dictionary<string, Stat>(StringComparer.OrdinalIgnoreCase);
            var branchStats = new Dictionary<string, BranchStat>(StringComparer.OrdinalIgnoreCase);

            var longest = new List<Sample>();
            var longNames = new List<Sample>();
            var deepest = new List<Sample>();
            var extensionStats = new Dictionary<string, ExtensionStat>(StringComparer.OrdinalIgnoreCase);

            var departmentSamples =
                new Dictionary<string, DepartmentSampleBucket>(
                    StringComparer.OrdinalIgnoreCase);

            var anomalies = new List<AnomalySample>();
            var errors = new List<ScanError>();
            var allProblems = opt.CaptureAllProblems ? new List<Sample>() : null;

            foreach (LocalAccumulator acc in accumulators)
            {
                MergeStats(dep, acc.Departments);
                MergeStats(rootStats, acc.Roots);
                MergeBranches(branchStats, acc.Branches);

                MergeTop(longest, acc.Longest, opt.TopLongest, x => x.RiskPathLength);
                MergeTop(longNames, acc.LongNamesTop, opt.TopLongNames, x => x.NameLength);
                MergeTop(deepest, acc.Deepest, opt.TopDeepest, x => x.Depth);
                MergeDepartmentSamples(departmentSamples, acc.DepartmentSamples);
                MergeExtensions(extensionStats, acc.Extensions);

                if (acc.Anomalies.Count > 0)
                    anomalies.AddRange(acc.Anomalies);

                errors.AddRange(acc.Errors);

                if (opt.CaptureAllProblems && acc.AllProblems.Count > 0)
                    allProblems.AddRange(acc.AllProblems);
            }

            var result = new ScanResult
            {
                StartTime = start,
                EndTime = DateTime.Now,
                Duration = sw.Elapsed,
                Workers = opt.Workers,
                PeakActiveWorkers = _peakActiveWorkers,
                DirectoriesProcessed = Interlocked.Read(ref _directoriesProcessed),

                Departments = dep.Values
                    .OrderByDescending(x => x.CriticalPaths)
                    .ThenByDescending(x => x.ProblemObjects)
                    .ToList(),

                Roots = rootStats.Values
                    .OrderBy(x => x.Label)
                    .ToList(),

                Branches = branchStats.Values
                    .Where(x => x.ProblemObjects > 0)
                    .OrderByDescending(x => x.CriticalPaths)
                    .ThenByDescending(x => x.ProblemObjects)
                    .ToList(),

                Longest = longest,
                LongNamesTop = longNames,
                Deepest = deepest,

                DepartmentLongest = departmentSamples.Values
                    .OrderBy(x => x.Label)
                    .ThenBy(x => x.TopFolder)
                    .SelectMany(x => x.Longest)
                    .ToList(),

                DepartmentLongNamesTop = departmentSamples.Values
                    .OrderBy(x => x.Label)
                    .ThenBy(x => x.TopFolder)
                    .SelectMany(x => x.LongNamesTop)
                    .ToList(),

                DepartmentDeepest = departmentSamples.Values
                    .OrderBy(x => x.Label)
                    .ThenBy(x => x.TopFolder)
                    .SelectMany(x => x.Deepest)
                    .ToList(),

                Extensions = extensionStats.Values
                    .OrderByDescending(x => x.CriticalFiles)
                    .ThenByDescending(x => x.ProblemFiles)
                    .ToList(),

                Anomalies = anomalies
                    .OrderByDescending(x => x.RiskPathLength)
                    .Take(opt.TopAnomalies)
                    .ToList(),

                Errors = errors,
                AllProblems = allProblems
            };

            foreach (Stat s in result.Roots)
            {
                result.TotalFiles += s.TotalFiles;
                result.TotalDirectories += s.TotalDirectories;
                result.TotalObjects += s.TotalObjects;

                result.NormalPaths += s.NormalPaths;
                result.WarningPaths += s.WarningPaths;
                result.BadPaths += s.BadPaths;
                result.CriticalPaths += s.CriticalPaths;

                result.ProblemObjects += s.ProblemObjects;
                result.LongNames += s.LongNames;
                result.ExcessiveDepth += s.ExcessiveDepth;
                result.ReparsePointsSkipped += s.ReparsePointsSkipped;

                if (s.MaxRiskPathLength > result.MaxRiskPathLength)
                {
                    result.MaxRiskPathLength = s.MaxRiskPathLength;
                    result.MaxRiskLabel = s.Label;
                    result.MaxRiskRelativePath = s.MaxRiskRelativePath;

                    Stat depMatch = result.Departments
                        .Where(d => d.Label == s.Label &&
                            !String.IsNullOrWhiteSpace(s.MaxRiskRelativePath) &&
                            s.MaxRiskRelativePath.StartsWith(
                                d.TopFolder + "\\",
                                StringComparison.OrdinalIgnoreCase))
                        .OrderByDescending(d => d.TopFolder.Length)
                        .FirstOrDefault();

                    result.MaxRiskTopFolder =
                        depMatch != null ? depMatch.TopFolder : "[ROOT]";
                }

                if (s.MaxDepth > result.MaxDepth)
                {
                    result.MaxDepth = s.MaxDepth;
                    result.MaxDepthLabel = s.Label;
                    result.MaxDepthRelativePath = s.MaxDepthRelativePath;

                    Stat depMatch = result.Departments
                        .Where(d => d.Label == s.Label &&
                            !String.IsNullOrWhiteSpace(s.MaxDepthRelativePath) &&
                            s.MaxDepthRelativePath.StartsWith(
                                d.TopFolder + "\\",
                                StringComparison.OrdinalIgnoreCase))
                        .OrderByDescending(d => d.TopFolder.Length)
                        .FirstOrDefault();

                    result.MaxDepthTopFolder =
                        depMatch != null ? depMatch.TopFolder : "[ROOT]";
                }
            }

            return result;
        }

        public static bool SelfTestLongPath()
        {
            string basePath = Path.Combine(
                Path.GetTempPath(),
                "LongPathAuditV6_" + Guid.NewGuid().ToString("N"));

            string current = basePath;
            var created = new List<string>();

            try
            {
                string baseWin32 = ToWin32(basePath);
                if (!NativeMethods.CreateDirectoryW(baseWin32, IntPtr.Zero))
                {
                    int baseCode = NativeMethods.LastError();
                    if (baseCode != 183)
                        throw new Win32Exception(baseCode);
                }
                created.Add(baseWin32);

                for (int i = 0; i < 9; i++)
                {
                    current = Path.Combine(
                        current,
                        "LongPathSegment_" + i.ToString("00") + "_" +
                        new string((char)('A' + (i % 20)), 24));

                    string w = ToWin32(current);
                    if (!NativeMethods.CreateDirectoryW(w, IntPtr.Zero))
                    {
                        int code = NativeMethods.LastError();
                        if (code != 183)
                            throw new Win32Exception(code);
                    }
                    created.Add(w);
                }

                if (current.Length <= 260)
                    throw new Exception("Self-test did not create a path longer than 260 characters.");

                WIN32_FIND_DATA data;
                IntPtr h = OpenFind(ToWin32(current) + "\\*", out data);
                if (h == INVALID_HANDLE_VALUE)
                {
                    int code = NativeMethods.LastError();
                    if (code != ERROR_FILE_NOT_FOUND)
                        throw new Win32Exception(code);
                }
                else
                {
                    NativeMethods.FindClose(h);
                }

                return true;
            }
            finally
            {
                for (int i = created.Count - 1; i >= 0; i--)
                {
                    try { NativeMethods.RemoveDirectoryW(created[i]); }
                    catch { }
                }

            }
        }
    }
}
