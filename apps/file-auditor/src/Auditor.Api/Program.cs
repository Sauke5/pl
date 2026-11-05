using Microsoft.Extensions.Hosting;
using System.Security.Cryptography.X509Certificates;
using System.Net;
using Auditor.Api.Services;
using Auditor.Api.Options;
using Auditor.Data;
using Microsoft.EntityFrameworkCore;
using Serilog;
using Auditor.Api.Auth;

var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);
builder.Host.UseWindowsService(
    options =>
        options.ServiceName =
            "FileStructureAuditor");

if (builder.Environment.IsProduction())
{
    var logFile = builder.Configuration.GetSection("Serilog:WriteTo").GetChildren()
        .Where(sink => string.Equals(sink["Name"], "File", StringComparison.OrdinalIgnoreCase))
        .Select(sink => sink["Args:path"])
        .FirstOrDefault();
    if (string.IsNullOrWhiteSpace(logFile) || !Path.IsPathFullyQualified(logFile))
        throw new InvalidOperationException("Production Serilog file path must be absolute.");
    Directory.CreateDirectory(Path.GetDirectoryName(logFile)!);

    var httpsPort = builder.Configuration.GetValue<int?>("Production:HttpsPort") ?? 443;
    var listenHttp = builder.Configuration.GetValue<bool?>("Production:ListenHttp") ?? true;
    if (httpsPort is < 1 or > 65535 || httpsPort == 80 && listenHttp)
        throw new InvalidOperationException("Production HTTPS port is invalid.");
    builder.WebHost.ConfigureKestrel(
        options =>
        {
            if (listenHttp)
                options.Listen(IPAddress.Any, 80);

            options.Listen(
                IPAddress.Any,
                httpsPort,
                listen =>
                {
                    var thumbprint =
                        builder.Configuration[
                            "Production:CertificateThumbprint"]
                        ?? throw new InvalidOperationException(
                            "Production certificate thumbprint is missing.");

                    using var store =
                        new X509Store(
                            StoreName.My,
                            StoreLocation.LocalMachine);

                    store.Open(
                        OpenFlags.ReadOnly);

                    var certificate =
                        store.Certificates
                            .Find(
                                X509FindType.FindByThumbprint,
                                thumbprint,
                                validOnly: false)
                            .OfType<X509Certificate2>()
                            .FirstOrDefault(x => x.HasPrivateKey &&
                                x.NotBefore <= DateTime.Now && x.NotAfter > DateTime.Now)
                        ?? throw new InvalidOperationException(
                            $"Production certificate {thumbprint} was not found.");

                    listen.UseHttps(
                        certificate);
                });
        });
}

builder.Services.AddHttpsRedirection(
    options =>
        options.HttpsPort = builder.Configuration.GetValue<int?>("Production:HttpsPort") ?? 443);


builder.Host.UseSerilog((context, cfg) =>
{
    cfg.ReadFrom.Configuration(context.Configuration);
    if (context.HostingEnvironment.IsDevelopment())
        cfg.WriteTo.Console();
});

builder.Services.AddControllers();

builder.Services.Configure<AuditorOptions>(builder.Configuration.GetSection("Auditor"));
builder.Services.AddSingleton<ScanService>();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddDbContext<AuditorDbContext>(options =>
    options.UseSqlite(builder.Configuration.GetConnectionString("SQLite")));

var gatewaySettings = GatewaySettings.Load(builder.Configuration, builder.Environment);
builder.Services.AddSingleton(gatewaySettings);
if (gatewaySettings.Enabled)
    builder.Services.AddSingleton<GatewayAssertionVerifier>();

var app = builder.Build();
await ScanScopeSchema.EnsureCreatedAsync(app.Services);
var interruptedRuns = await ScanRunRecovery.MarkInterruptedAsync(app.Services);
if (interruptedRuns > 0)
    app.Logger.LogWarning("Marked {Count} interrupted scan runs as failed on startup.", interruptedRuns);
app.UseMiddleware<GatewayAssertionMiddleware>();
if (gatewaySettings.Enabled)
    app.UsePathBase(gatewaySettings.PathBase);
app.UseRouting();
if (app.Environment.IsProduction())
{
    app.UseHttpsRedirection();
}

app.UseDefaultFiles();
app.UseStaticFiles();

app.UseSerilogRequestLogging();
if (app.Environment.IsDevelopment()) { app.UseSwagger(); app.UseSwaggerUI(); }
app.MapControllers();
app.MapFallbackToFile(
    "index.html");
app.Run();
