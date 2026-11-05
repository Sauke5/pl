using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Auditor.Api.Controllers;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Auditor.Tests.Api;

public sealed class GatewayRoutingTests
{
    private static readonly byte[] Key = Enumerable.Range(0, 32).Select(value => (byte)value).ToArray();
    private static readonly string Csrf = Base64Url(Enumerable.Range(32, 32).Select(value => (byte)value).ToArray());

    [Theory]
    [InlineData("/audit")]
    [InlineData("/audit-arch")]
    public async Task SignedRequestsReachControllersAfterPathBaseIsApplied(string pathBase)
    {
        var directory = Path.Combine(Path.GetTempPath(), "auditor-routing-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var keyFile = Path.Combine(directory, "gateway.key");
        File.WriteAllBytes(keyFile, Key);

        try
        {
            using var factory = new WebApplicationFactory<InstanceController>().WithWebHostBuilder(builder =>
            {
                builder.UseEnvironment("Development");
                builder.UseSetting("Gateway:Enabled", "true");
                builder.UseSetting("Gateway:PathBase", pathBase);
                builder.UseSetting("Gateway:KeyFile", keyFile);
                builder.UseSetting("ConnectionStrings:SQLite", $"Data Source={Path.Combine(directory, "routing.db")}");
                builder.UseSetting("Auditor:Roots:0:Name", "Validation");
                builder.UseSetting("Auditor:Roots:0:LocalPath", directory);
                builder.ConfigureTestServices(services => services.AddSingleton<IStartupFilter, RawTargetStartupFilter>());
            });
            using var client = factory.CreateClient(new WebApplicationFactoryClientOptions
            {
                AllowAutoRedirect = false
            });

            using var instance = await client.SendAsync(Signed("GET", pathBase + "/api/instance", false),
                TestContext.Current.CancellationToken);
            Assert.True(instance.StatusCode == HttpStatusCode.OK,
                $"Expected JSON instance, received {(int)instance.StatusCode}: " +
                await instance.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
            Assert.Equal("application/json", instance.Content.Headers.ContentType?.MediaType);
            using var document = JsonDocument.Parse(
                await instance.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
            Assert.Equal("Validation", document.RootElement.GetProperty("roots")[0].GetProperty("name").GetString());

            const string invalidJson = "{";
            using var viewer = await client.SendAsync(Signed("POST", pathBase + "/api/scans", false, invalidJson),
                TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.Forbidden, viewer.StatusCode);

            using var admin = await client.SendAsync(Signed("POST", pathBase + "/api/scans", true, invalidJson),
                TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.BadRequest, admin.StatusCode);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static HttpRequestMessage Signed(string method, string uri, bool admin, string? body = null)
    {
        var bytes = Encoding.UTF8.GetBytes(body ?? string.Empty);
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var claims = new Dictionary<string, object>
        {
            ["v"] = 2,
            ["aud"] = "auditor",
            ["iat"] = now,
            ["exp"] = now + 30,
            ["nonce"] = Base64Url(RandomNumberGenerator.GetBytes(32)),
            ["sub"] = "routing-test-user",
            ["name"] = "Routing Test",
            ["admin"] = admin,
            ["scopes"] = admin ? new[] { "auditor:read", "auditor:scan" } : new[] { "auditor:read" },
            ["method"] = method,
            ["uri"] = uri,
            ["content_type"] = body is null ? string.Empty : "application/json",
            ["body_sha256"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            ["idempotency_key"] = string.Empty,
            ["source_ip"] = "192.0.2.10",
            ["csrf_token"] = Csrf,
            ["csrf_verified"] = method == "POST"
        };
        var assertion = Base64Url(JsonSerializer.SerializeToUtf8Bytes(claims));
        var signature = HMACSHA256.HashData(Key, Encoding.ASCII.GetBytes("pl-gateway-v2\n" + assertion));
        var request = new HttpRequestMessage(new HttpMethod(method), uri);
        request.Headers.Add("X-PL-Gateway-Assertion", assertion);
        request.Headers.Add("X-PL-Gateway-Signature", Base64Url(signature));
        if (body is not null)
        {
            request.Content = new ByteArrayContent(bytes);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            request.Headers.Add("X-CSRF-Token", Csrf);
        }
        return request;
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    // TestServer does not populate RawTarget; production Kestrel does.
    private sealed class RawTargetStartupFilter : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use((context, continuation) =>
            {
                context.Features.Get<IHttpRequestFeature>()!.RawTarget =
                    context.Request.Path + context.Request.QueryString;
                return continuation();
            });
            next(app);
        };
    }
}
