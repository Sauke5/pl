using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace Auditor.Api.Auth;

public sealed record GatewaySettings(bool Enabled, string PathBase, byte[] Key)
{
    public static GatewaySettings Load(IConfiguration configuration, IHostEnvironment environment)
    {
        var configuredEnabled = configuration.GetValue<bool?>("Gateway:Enabled");
        if (!environment.IsDevelopment() && configuredEnabled == false)
            throw new InvalidOperationException("Gateway authentication can only be disabled in development.");

        var enabled = configuredEnabled != false;
        if (!enabled)
            return new GatewaySettings(false, string.Empty, Array.Empty<byte>());

        var pathBase = configuration["Gateway:PathBase"];
        if (pathBase is not ("/audit" or "/audit-arch"))
            throw new InvalidOperationException("Gateway:PathBase must be /audit or /audit-arch.");

        var keyFile = configuration["Gateway:KeyFile"];
        if (string.IsNullOrWhiteSpace(keyFile) || !Path.IsPathFullyQualified(keyFile))
            throw new InvalidOperationException("Gateway:KeyFile must name an absolute file path.");

        var key = File.ReadAllBytes(keyFile);
        if (key.Length != 32)
            throw new InvalidOperationException("Gateway key file must contain exactly 32 raw bytes.");

        return new GatewaySettings(true, pathBase, key);
    }
}
