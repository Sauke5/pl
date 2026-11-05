using Microsoft.AspNetCore.Http.Features;

namespace Auditor.Api.Auth;

public sealed class GatewayAssertionMiddleware
{
    private readonly RequestDelegate _next;
    private readonly GatewaySettings _settings;
    private readonly GatewayAssertionVerifier? _verifier;

    public GatewayAssertionMiddleware(RequestDelegate next, GatewaySettings settings,
        GatewayAssertionVerifier? verifier = null)
    {
        _next = next;
        _settings = settings;
        _verifier = verifier;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        if (!_settings.Enabled)
        {
            await _next(context);
            return;
        }

        var rawTarget = context.Features.Get<IHttpRequestFeature>()?.RawTarget;
        if (context.Request.Method == HttpMethods.Get && rawTarget == "/health")
        {
            await _next(context);
            return;
        }

        var result = await (_verifier ?? throw new InvalidOperationException("Gateway verifier is missing."))
            .VerifyAsync(context, context.RequestAborted);
        if (result.Status != StatusCodes.Status200OK)
        {
            context.Response.StatusCode = result.Status;
            await context.Response.WriteAsJsonAsync(new { error = result.Code });
            return;
        }

        context.Items[GatewayAssertionVerifier.ClaimsItemKey] = result.Claims;
        await _next(context);
    }
}
