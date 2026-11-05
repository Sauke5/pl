using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Auditor.Api.Auth;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Primitives;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

namespace Auditor.Tests.Api;

public sealed class GatewayAssertionTests
{
    private static readonly byte[] PrimaryKey = Enumerable.Range(0, 32).Select(x => (byte)x).ToArray();
    private static readonly byte[] SecondaryKey = Enumerable.Range(32, 32).Select(x => (byte)x).ToArray();
    private static readonly string Csrf = Encode(Enumerable.Range(64, 32).Select(x => (byte)x).ToArray());

    [Fact]
    public async Task AcceptsPublishedPlatformV2ReadVector()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "auditor-v2-vectors.json")));
        var fixture = doc.RootElement.GetProperty("vectors")[0];
        var uri = fixture.GetProperty("uri").GetString()!;
        var context = Request("GET", uri);
        context.Request.Headers["X-PL-Gateway-Assertion"] = fixture.GetProperty("assertion").GetString()!;
        context.Request.Headers["X-PL-Gateway-Signature"] = fixture.GetProperty("signature").GetString()!;
        var verifier = new GatewayAssertionVerifier(new GatewaySettings(true, "/audit", PrimaryKey), new FixtureClock());
        Assert.Equal(200, (await verifier.VerifyAsync(context, TestContext.Current.CancellationToken)).Status);
    }

    [Theory]
    [InlineData("/audit", "/audit/api/instance")]
    [InlineData("/audit-arch", "/audit-arch/api/findings?page=2&kind=Longest")]
    public async Task ValidReadAssertionUsesExactPrefixAndRawQuery(string prefix, string uri)
    {
        var context = Request("GET", uri);
        Sign(context, PrimaryKey, Claim("GET", uri));
        var result = await Verifier(PrimaryKey, prefix).VerifyAsync(context, TestContext.Current.CancellationToken);

        Assert.Equal(200, result.Status);
        Assert.Equal("portal-user-1", result.Claims!.Subject);
        Assert.False(result.Claims.Admin);
    }

    [Fact]
    public async Task SignedStaticAssetIsAvailableOnlyUnderItsInstancePrefix()
    {
        var asset = Request("GET", "/audit/assets/index-123.js");
        Sign(asset, PrimaryKey, Claim("GET", "/audit/assets/index-123.js"));
        Assert.Equal(200, (await Verifier(PrimaryKey, "/audit").VerifyAsync(asset, TestContext.Current.CancellationToken)).Status);

        var outside = Request("GET", "/assets/index-123.js");
        Sign(outside, PrimaryKey, Claim("GET", "/assets/index-123.js"));
        Assert.Equal(401, (await Verifier(PrimaryKey, "/audit").VerifyAsync(outside, TestContext.Current.CancellationToken)).Status);
    }

    [Fact]
    public async Task MissingAndForgedAssertionsDenyDirectApiAndStaticRoot()
    {
        var verifier = Verifier(PrimaryKey, "/audit");
        Assert.Equal(401, (await verifier.VerifyAsync(Request("GET", "/api/scans"), TestContext.Current.CancellationToken)).Status);
        Assert.Equal(401, (await verifier.VerifyAsync(Request("GET", "/"), TestContext.Current.CancellationToken)).Status);

        var forged = Request("GET", "/audit/api/instance");
        Sign(forged, SecondaryKey, Claim("GET", "/audit/api/instance"));
        Assert.Equal(401, (await verifier.VerifyAsync(forged, TestContext.Current.CancellationToken)).Status);
    }

    [Fact]
    public async Task PrimaryAssertionCannotBeReusedForSecondaryKeyOrPrefix()
    {
        var primary = Request("GET", "/audit/api/instance");
        Sign(primary, PrimaryKey, Claim("GET", "/audit/api/instance"));
        Assert.Equal(401, (await Verifier(SecondaryKey, "/audit-arch").VerifyAsync(primary, TestContext.Current.CancellationToken)).Status);

        var secondaryPathWithPrimarySignature = Request("GET", "/audit-arch/api/instance");
        Sign(secondaryPathWithPrimarySignature, PrimaryKey, Claim("GET", "/audit/api/instance"));
        Assert.Equal(401, (await Verifier(PrimaryKey, "/audit-arch").VerifyAsync(secondaryPathWithPrimarySignature, TestContext.Current.CancellationToken)).Status);
    }

    [Fact]
    public async Task ExpiredAssertionAndChangedRawUriAreRejected()
    {
        var uri = "/audit/api/findings?q=a%2Fb&sort=length";
        var expired = Request("GET", uri);
        var old = Claim("GET", uri);
        old["iat"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 100;
        old["exp"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 70;
        Sign(expired, PrimaryKey, old);
        Assert.Equal(401, (await Verifier(PrimaryKey, "/audit").VerifyAsync(expired, TestContext.Current.CancellationToken)).Status);

        var changed = Request("GET", "/audit/api/findings?sort=length&q=a%2Fb");
        Sign(changed, PrimaryKey, Claim("GET", uri));
        Assert.Equal(401, (await Verifier(PrimaryKey, "/audit").VerifyAsync(changed, TestContext.Current.CancellationToken)).Status);
    }

    [Fact]
    public async Task OnlyAdminScanScopeCanStartAScan()
    {
        var uri = "/audit/api/scans";
        var viewer = Request("POST", uri);
        viewer.Request.Headers["X-CSRF-Token"] = Csrf;
        Sign(viewer, PrimaryKey, Claim("POST", uri, admin: false));
        Assert.Equal(403, (await Verifier(PrimaryKey, "/audit").VerifyAsync(viewer, TestContext.Current.CancellationToken)).Status);

        var admin = Request("POST", uri);
        admin.Request.Headers["X-CSRF-Token"] = Csrf;
        Sign(admin, PrimaryKey, Claim("POST", uri, admin: true));
        Assert.Equal(200, (await Verifier(PrimaryKey, "/audit").VerifyAsync(admin, TestContext.Current.CancellationToken)).Status);
    }

    [Fact]
    public async Task UnsafeReplayIsRejected()
    {
        var verifier = Verifier(PrimaryKey, "/audit");
        var requests = Enumerable.Range(0, 2).Select(_ =>
        {
            var context = Request("POST", "/audit/api/scans");
            context.Request.Headers["X-CSRF-Token"] = Csrf;
            Sign(context, PrimaryKey, Claim("POST", "/audit/api/scans", admin: true));
            return context;
        }).ToArray();
        var results = await Task.WhenAll(requests.Select(x => verifier.VerifyAsync(x, TestContext.Current.CancellationToken)));
        Assert.Equal(new[] { 200, 409 }, results.Select(x => x.Status).OrderBy(x => x));
    }

    [Fact]
    public async Task BodyContentTypeAndCsrfAreBoundToUnsafeAssertion()
    {
        var uri = "/audit/api/scans";
        var body = Encoding.UTF8.GetBytes("{\"start\":true}");
        var cases = new[] { "body", "type", "csrf", "idempotency", "encoding" };
        foreach (var change in cases)
        {
            var context = Request("POST", uri, body);
            context.Request.Headers["Content-Type"] = "application/json";
            context.Request.Headers["X-CSRF-Token"] = Csrf;
            var claims = Claim("POST", uri, admin: true, body: body, contentType: "application/json");
            if (change == "body") context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes("{\"start\":false}"));
            if (change == "type") context.Request.Headers["Content-Type"] = "text/plain";
            if (change == "csrf") context.Request.Headers["X-CSRF-Token"] = "wrong";
            if (change == "idempotency") context.Request.Headers["Idempotency-Key"] = "other-request";
            if (change == "encoding") context.Request.Headers["Content-Encoding"] = "gzip";
            Sign(context, PrimaryKey, claims);
            var result = await Verifier(PrimaryKey, "/audit").VerifyAsync(context, TestContext.Current.CancellationToken);
            Assert.Equal(change == "csrf" ? 403 : 401, result.Status);
        }
    }

    [Fact]
    public async Task DuplicateHeadersAndDuplicateJsonKeysAreRejected()
    {
        var uri = "/audit/api/instance";
        var duplicates = Request("GET", uri);
        Sign(duplicates, PrimaryKey, Claim("GET", uri));
        duplicates.Request.Headers["X-PL-Gateway-Assertion"] = new StringValues(["a", "b"]);
        Assert.Equal(401, (await Verifier(PrimaryKey, "/audit").VerifyAsync(duplicates, TestContext.Current.CancellationToken)).Status);

        var json = JsonSerializer.Serialize(Claim("GET", uri));
        var duplicateJson = json[..^1] + ",\"aud\":\"auditor\"}";
        var context = Request("GET", uri);
        SignRaw(context, PrimaryKey, duplicateJson);
        Assert.Equal(401, (await Verifier(PrimaryKey, "/audit").VerifyAsync(context, TestContext.Current.CancellationToken)).Status);
    }

    [Fact]
    public async Task MiddlewareExposesOnlyExactHealthWithoutAssertion()
    {
        var called = 0;
        var settings = new GatewaySettings(true, "/audit", PrimaryKey);
        var middleware = new GatewayAssertionMiddleware(_ => { called++; return Task.CompletedTask; }, settings,
            new GatewayAssertionVerifier(settings));
        var health = Request("GET", "/health");
        await middleware.InvokeAsync(health);
        Assert.Equal(1, called);

        var root = Request("GET", "/");
        await middleware.InvokeAsync(root);
        Assert.Equal(401, root.Response.StatusCode);
        Assert.Equal(1, called);
    }

    [Fact]
    public void NonDevelopmentCannotStartWithoutExternalKeyOrDisableGateway()
    {
        var environment = new TestEnvironment("Production");
        var disabled = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Gateway:Enabled"] = "false"
        }).Build();
        Assert.Throws<InvalidOperationException>(() => GatewaySettings.Load(disabled, environment));

        var missing = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Gateway:PathBase"] = "/audit", ["Gateway:KeyFile"] = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))
        }).Build();
        Assert.Throws<FileNotFoundException>(() => GatewaySettings.Load(missing, environment));

        var keyFile = Path.GetTempFileName();
        try
        {
            File.WriteAllBytes(keyFile, PrimaryKey);
            var valid = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Gateway:PathBase"] = "/audit", ["Gateway:KeyFile"] = keyFile
            }).Build();
            var settings = GatewaySettings.Load(valid, environment);
            Assert.True(settings.Enabled);
            Assert.Equal("/audit", settings.PathBase);
            Assert.Equal(32, settings.Key.Length);
        }
        finally
        {
            File.Delete(keyFile);
        }
    }

    private static GatewayAssertionVerifier Verifier(byte[] key, string prefix) =>
        new(new GatewaySettings(true, prefix, key));

    private static DefaultHttpContext Request(string method, string uri, byte[]? body = null)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = uri.Split('?')[0];
        context.Request.QueryString = new QueryString(uri.Contains('?') ? uri[uri.IndexOf('?')..] : "");
        context.Features.Get<IHttpRequestFeature>()!.RawTarget = uri;
        context.Request.Body = new MemoryStream(body ?? []);
        return context;
    }

    private static Dictionary<string, object> Claim(string method, string uri, bool admin = false,
        byte[]? body = null, string contentType = "")
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        return new Dictionary<string, object>
        {
            ["v"] = 2, ["aud"] = "auditor", ["iat"] = now, ["exp"] = now + 30,
            ["nonce"] = Encode(Enumerable.Range(0, 32).Select(x => (byte)x).ToArray()),
            ["sub"] = "portal-user-1", ["name"] = "Test User", ["admin"] = admin,
            ["scopes"] = admin ? new[] { "auditor:read", "auditor:scan" } : new[] { "auditor:read" },
            ["method"] = method, ["uri"] = uri, ["content_type"] = contentType,
            ["body_sha256"] = Convert.ToHexString(SHA256.HashData(body ?? [])).ToLowerInvariant(),
            ["idempotency_key"] = "", ["source_ip"] = "192.0.2.10", ["csrf_token"] = Csrf,
            ["csrf_verified"] = method == "POST"
        };
    }

    private static void Sign(DefaultHttpContext context, byte[] key, Dictionary<string, object> claims) =>
        SignRaw(context, key, JsonSerializer.Serialize(claims));

    private static void SignRaw(DefaultHttpContext context, byte[] key, string json)
    {
        var assertion = Encode(Encoding.UTF8.GetBytes(json));
        var mac = HMACSHA256.HashData(key, Encoding.ASCII.GetBytes("pl-gateway-v2\n" + assertion));
        context.Request.Headers["X-PL-Gateway-Assertion"] = assertion;
        context.Request.Headers["X-PL-Gateway-Signature"] = Encode(mac);
    }

    private static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private sealed class FixtureClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.FromUnixTimeSeconds(1790000005);
    }

    private sealed class TestEnvironment(string environmentName) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = environmentName;
        public string ApplicationName { get; set; } = "Auditor.Tests";
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
