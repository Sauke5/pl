using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Primitives;

namespace Auditor.Api.Auth;

public sealed record GatewayClaims(string Subject, string Name, bool Admin,
    IReadOnlyList<string> Scopes, string SourceIp);

public sealed record GatewayVerification(int Status, string Code, GatewayClaims? Claims = null)
{
    public static GatewayVerification Ok(GatewayClaims claims) => new(200, "ok", claims);
    public static GatewayVerification Invalid(string code) => new(401, code);
    public static GatewayVerification Denied(string code) => new(403, code);
}

public sealed class GatewayAssertionVerifier
{
    public const string ClaimsItemKey = "pl.gateway.claims";
    private const int MaxBody = 2 * 1024 * 1024;
    private const int MaxNonces = 10_000;
    private const string Domain = "pl-gateway-v2\n";
    private static readonly byte[] DomainBytes = Encoding.ASCII.GetBytes(Domain);
    private static readonly string EmptyDigest = Convert.ToHexString(SHA256.HashData(Array.Empty<byte>())).ToLowerInvariant();
    private static readonly HashSet<string> ClaimNames = new(StringComparer.Ordinal)
    {
        "v", "aud", "iat", "exp", "nonce", "sub", "name", "admin", "scopes", "method", "uri",
        "content_type", "body_sha256", "idempotency_key", "source_ip", "csrf_token", "csrf_verified"
    };
    private static readonly string[] AdminScopes = ["auditor:read", "auditor:scan"];
    private static readonly string[] ReaderScopes = ["auditor:read"];
    private static readonly string[] ProtectedHeaders =
    [
        "X-PL-Gateway-Assertion", "X-PL-Gateway-Signature", "Content-Type", "Idempotency-Key",
        "X-CSRF-Token", "Content-Encoding"
    ];
    private readonly byte[] _key;
    private readonly string _pathBase;
    private readonly TimeProvider _clock;
    private readonly Dictionary<string, long> _nonces = new(StringComparer.Ordinal);
    private readonly object _nonceLock = new();

    public GatewayAssertionVerifier(GatewaySettings settings, TimeProvider? clock = null)
    {
        if (!settings.Enabled || settings.Key.Length != 32)
            throw new ArgumentException("A 32-byte gateway key is required.", nameof(settings));
        _key = settings.Key.ToArray();
        _pathBase = settings.PathBase;
        _clock = clock ?? TimeProvider.System;
    }

    public async Task<GatewayVerification> VerifyAsync(HttpContext context, CancellationToken cancellationToken)
    {
        var request = context.Request;
        var rawTarget = context.Features.Get<IHttpRequestFeature>()?.RawTarget;
        if (string.IsNullOrEmpty(rawTarget) || rawTarget.Length > 4096 ||
            rawTarget.Any(c => c is < '!' or > '~'))
            return GatewayVerification.Invalid("gateway_request_mismatch");

        var queryAt = rawTarget.IndexOf('?');
        var rawPath = queryAt < 0 ? rawTarget : rawTarget[..queryAt];
        if (!rawPath.StartsWith(_pathBase + "/", StringComparison.Ordinal) ||
            rawPath.Contains('%') || rawPath.Contains('\\') || rawPath.Contains("//", StringComparison.Ordinal) ||
            rawPath.Split('/').Any(part => part is "." or "..") ||
            !string.Equals(request.Path.Value, rawPath, StringComparison.Ordinal))
            return GatewayVerification.Invalid("gateway_request_mismatch");

        var method = request.Method;
        var safe = method is "GET" or "HEAD";
        var scanStart = method == "POST" && rawPath == _pathBase + "/api/scans";
        if (!safe && !scanStart || request.Headers.ContainsKey("Upgrade"))
            return GatewayVerification.Invalid("gateway_request_mismatch");

        foreach (var name in ProtectedHeaders)
            if (request.Headers.TryGetValue(name, out StringValues values) && values.Count != 1)
                return GatewayVerification.Invalid("duplicate_gateway_header");

        var assertion = Header(request, "X-PL-Gateway-Assertion");
        var signatureText = Header(request, "X-PL-Gateway-Signature");
        if (assertion.Length is 0 or > 8192 || !TryDecode(signatureText, out var signature) || signature.Length != 32)
            return GatewayVerification.Invalid("invalid_gateway_assertion");

        var message = new byte[DomainBytes.Length + assertion.Length];
        DomainBytes.CopyTo(message, 0);
        Encoding.ASCII.GetBytes(assertion).CopyTo(message, DomainBytes.Length);
        var expected = HMACSHA256.HashData(_key, message);
        if (!CryptographicOperations.FixedTimeEquals(signature, expected))
            return GatewayVerification.Invalid("invalid_gateway_signature");

        if (!TryDecode(assertion, out var jsonBytes) || !TryReadClaims(jsonBytes, out var claims))
            return GatewayVerification.Invalid("invalid_gateway_json");

        var now = _clock.GetUtcNow().ToUnixTimeSeconds();
        if (claims.Version != 2 || claims.Audience != "auditor" || claims.IssuedAt <= 0 ||
            claims.ExpiresAt <= claims.IssuedAt || claims.ExpiresAt - claims.IssuedAt > 30 ||
            claims.IssuedAt > now + 5 || claims.ExpiresAt < now - 5)
            return GatewayVerification.Invalid("expired_gateway_assertion");

        var expectedScopes = claims.Admin ? AdminScopes : ReaderScopes;
        if (!claims.Scopes.SequenceEqual(expectedScopes, StringComparer.Ordinal))
            return GatewayVerification.Denied("gateway_scope_denied");
        if (scanStart && (!claims.Admin || !claims.Scopes.Contains("auditor:scan")))
            return GatewayVerification.Denied("gateway_scope_denied");

        if (!ValidString(claims.Subject, 256) || !ValidString(claims.Name, 512) ||
            !ValidAscii(claims.Uri, 4096) || !ValidAscii(claims.ContentType, 256) ||
            !ValidAscii(claims.IdempotencyKey, 128) ||
            !IPAddress.TryParse(claims.SourceIp, out _) ||
            !TryDecode(claims.Nonce, out var nonceBytes) || nonceBytes.Length is < 16 or > 64 ||
            !TryDecode(claims.CsrfToken, out var csrfBytes) || csrfBytes.Length != 32 ||
            !Regex.IsMatch(claims.BodySha256, "^[0-9a-f]{64}$", RegexOptions.CultureInvariant))
            return GatewayVerification.Invalid("invalid_gateway_claim");

        if (request.ContentLength > MaxBody)
            return new GatewayVerification(413, "request_body_too_large");
        byte[] body;
        try
        {
            request.EnableBuffering(bufferThreshold: 64 * 1024, bufferLimit: MaxBody + 1);
            using var buffer = new MemoryStream();
            var chunk = new byte[8192];
            int count;
            while ((count = await request.Body.ReadAsync(chunk, cancellationToken)) != 0)
            {
                if (buffer.Length + count > MaxBody)
                    return new GatewayVerification(413, "request_body_too_large");
                buffer.Write(chunk, 0, count);
            }
            body = buffer.ToArray();
            request.Body.Position = 0;
        }
        catch (IOException)
        {
            return new GatewayVerification(413, "request_body_too_large");
        }

        var bodyDigest = body.Length == 0 ? EmptyDigest : Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant();
        if (claims.Method != method || claims.Uri != rawTarget ||
            claims.ContentType != Header(request, "Content-Type") ||
            claims.IdempotencyKey != Header(request, "Idempotency-Key") ||
            claims.BodySha256 != bodyDigest ||
            Header(request, "Content-Encoding") is not ("" or "identity"))
            return GatewayVerification.Invalid("gateway_request_mismatch");

        if (safe)
        {
            if (body.Length != 0 || claims.CsrfVerified)
                return GatewayVerification.Denied("invalid_gateway_csrf");
        }
        else
        {
            var submitted = Header(request, "X-CSRF-Token");
            if (!claims.CsrfVerified || submitted.Length != claims.CsrfToken.Length ||
                !CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(submitted), Encoding.ASCII.GetBytes(claims.CsrfToken)))
                return GatewayVerification.Denied("invalid_gateway_csrf");

            lock (_nonceLock)
            {
                foreach (var expired in _nonces.Where(pair => pair.Value < now).Select(pair => pair.Key).ToArray())
                    _nonces.Remove(expired);
                if (_nonces.ContainsKey(claims.Nonce))
                    return new GatewayVerification(409, "gateway_replay");
                if (_nonces.Count >= MaxNonces)
                    return new GatewayVerification(503, "gateway_replay_cache_full");
                _nonces.Add(claims.Nonce, claims.ExpiresAt + 5);
            }
        }

        return GatewayVerification.Ok(new GatewayClaims(claims.Subject, claims.Name, claims.Admin,
            claims.Scopes, claims.SourceIp));
    }

    private static string Header(HttpRequest request, string name) =>
        request.Headers.TryGetValue(name, out var value) ? value.ToString() : string.Empty;

    private static bool ValidString(string value, int maxBytes) =>
        value.Length > 0 && Encoding.UTF8.GetByteCount(value) <= maxBytes && !value.Any(char.IsControl);

    private static bool ValidAscii(string value, int maxBytes) =>
        value.Length <= maxBytes && value.All(c => c is >= ' ' and <= '~');

    private static bool TryDecode(string value, out byte[] bytes)
    {
        bytes = Array.Empty<byte>();
        if (value.Length == 0 || value.Any(c => !(c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '-' or '_')))
            return false;
        try
        {
            bytes = Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/') + new string('=', (4 - value.Length % 4) % 4));
            return Encode(bytes) == value;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static bool TryReadClaims(byte[] bytes, out ParsedClaims claims)
    {
        claims = default!;
        try
        {
            var json = new UTF8Encoding(false, true).GetString(bytes);
            if (json.StartsWith('\uFEFF')) return false;
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return false;
            var properties = root.EnumerateObject().ToArray();
            if (properties.Length != ClaimNames.Count ||
                properties.Select(p => p.Name).ToHashSet(StringComparer.Ordinal).Count != ClaimNames.Count ||
                properties.Any(p => !ClaimNames.Contains(p.Name))) return false;

            static string S(JsonElement obj, string name) => obj.GetProperty(name).GetString()!;
            static long I(JsonElement obj, string name)
            {
                var el = obj.GetProperty(name);
                var raw = el.GetRawText();
                if (el.ValueKind != JsonValueKind.Number || !Regex.IsMatch(raw, "^-?(0|[1-9][0-9]*)$", RegexOptions.CultureInvariant))
                    throw new FormatException();
                return el.GetInt64();
            }
            static bool B(JsonElement obj, string name)
            {
                var el = obj.GetProperty(name);
                if (el.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new FormatException();
                return el.GetBoolean();
            }
            var scopes = root.GetProperty("scopes");
            if (scopes.ValueKind != JsonValueKind.Array) return false;
            var scopeValues = scopes.EnumerateArray().Select(x => x.GetString()!).ToArray();
            if (scopeValues.Any(x => x is null || x.Any(char.IsControl))) return false;
            claims = new ParsedClaims(I(root, "v"), S(root, "aud"), I(root, "iat"), I(root, "exp"),
                S(root, "nonce"), S(root, "sub"), S(root, "name"), B(root, "admin"), scopeValues,
                S(root, "method"), S(root, "uri"), S(root, "content_type"), S(root, "body_sha256"),
                S(root, "idempotency_key"), S(root, "source_ip"), S(root, "csrf_token"), B(root, "csrf_verified"));
            return new[] { claims.Audience, claims.Nonce, claims.Subject, claims.Name, claims.Method,
                claims.Uri, claims.ContentType, claims.BodySha256, claims.IdempotencyKey, claims.SourceIp,
                claims.CsrfToken }.All(x => x is not null && !x.Any(char.IsControl));
        }
        catch (Exception ex) when (ex is JsonException or DecoderFallbackException or FormatException or InvalidOperationException or OverflowException or ArgumentException)
        {
            return false;
        }
    }

    private sealed record ParsedClaims(long Version, string Audience, long IssuedAt, long ExpiresAt,
        string Nonce, string Subject, string Name, bool Admin, string[] Scopes, string Method,
        string Uri, string ContentType, string BodySha256, string IdempotencyKey, string SourceIp,
        string CsrfToken, bool CsrfVerified);
}
