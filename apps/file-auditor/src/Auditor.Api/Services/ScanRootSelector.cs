using Auditor.Api.Options;

namespace Auditor.Api.Services;

public sealed class InvalidScanRootsException(string message) : Exception(message);

public static class ScanRootSelector
{
    public static IReadOnlyList<AuditRootOptions> Select(
        IReadOnlyList<AuditRootOptions> configured,
        IReadOnlyList<string>? requested)
    {
        var available = configured
            .Where(root => !string.IsNullOrWhiteSpace(root.Name) &&
                !string.IsNullOrWhiteSpace(root.LocalPath))
            .ToArray();
        if (available.Length == 0)
            throw new InvalidScanRootsException("No scan roots are configured.");

        var byName = new Dictionary<string, AuditRootOptions>(StringComparer.OrdinalIgnoreCase);
        foreach (var root in available)
        {
            if (!byName.TryAdd(root.Name, root))
                throw new InvalidScanRootsException("Configured scan root names must be unique.");
        }

        if (requested is null)
            return available.Select(Copy).ToArray();
        if (requested.Count == 0 || requested.Count > available.Length)
            throw new InvalidScanRootsException("Choose at least one configured scan root.");

        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in requested)
        {
            if (string.IsNullOrWhiteSpace(name) || !names.Add(name) || !byName.ContainsKey(name))
                throw new InvalidScanRootsException("Scan root selection contains an unknown or duplicate name.");
        }

        return available.Where(root => names.Contains(root.Name)).Select(Copy).ToArray();
    }

    private static AuditRootOptions Copy(AuditRootOptions source) => new()
    {
        Name = source.Name,
        LocalPath = source.LocalPath,
        ServerUNC = source.ServerUNC,
        DfsPath = source.DfsPath,
    };
}
