import type { Context } from "hono";

function configuredOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.pathname !== "/") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

type OriginFallback = string | (() => string);

function resolveFallback(fallback: OriginFallback | undefined): string | null {
  if (!fallback) return null;
  return typeof fallback === "function" ? fallback() : fallback;
}

export function businessOrigin(env: Env, fallback?: OriginFallback): string {
  const configured = configuredOrigin(env.BUSINESS_ORIGIN);
  if (configured) return configured;
  const resolvedFallback = resolveFallback(fallback);
  if (resolvedFallback) return resolvedFallback;
  if (String(env.ENVIRONMENT) !== "production") return "http://localhost";
  throw new Error("BUSINESS_ORIGIN is not configured");
}

export function dashboardOrigin(env: Env, fallback?: OriginFallback): string {
  const configured = configuredOrigin(env.DASHBOARD_ORIGIN);
  if (configured) return configured;
  const resolvedFallback = resolveFallback(fallback);
  if (resolvedFallback) return resolvedFallback;
  if (String(env.ENVIRONMENT) !== "production") return "http://localhost";
  throw new Error("DASHBOARD_ORIGIN is not configured");
}

export function configuredProductionHost(env: Env, hostname: string): boolean {
  const business = configuredOrigin(env.BUSINESS_ORIGIN);
  const dashboard = configuredOrigin(env.DASHBOARD_ORIGIN);
  return hostname === (business && new URL(business).hostname) ||
    hostname === (dashboard && new URL(dashboard).hostname);
}

export function sharedCookieDomain(env: Env): string | null {
  const business = configuredOrigin(env.BUSINESS_ORIGIN);
  return business ? new URL(business).hostname : null;
}

function headerScheme(c: Context<any>): string | null {
  const header = typeof c.req.header === "function" ? c.req.header.bind(c.req) : null;
  const cfVisitor = header?.("cf-visitor");
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor) as { scheme?: unknown };
      if (parsed.scheme === "http" || parsed.scheme === "https") {
        return parsed.scheme;
      }
    } catch {
      // Ignore malformed proxy metadata and fall back to the request URL.
    }
  }
  const forwarded = header?.("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "http" || forwarded === "https" ? forwarded : null;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function requestScheme(c: Context<any>, url: URL): string {
  return headerScheme(c) ?? url.protocol.replace(/:$/, "");
}

export function requestOrigin(c: Context<any>): string {
  const url = new URL(c.req.url);
  let scheme = requestScheme(c, url);
  if (scheme === "http" && !isLocalHost(url.hostname)) {
    scheme = "https";
  }
  return `${scheme}://${url.host}`;
}

export function isSecureRequest(c: Context<any>): boolean {
  return requestOrigin(c).startsWith("https://");
}

export function httpsRedirectUrl(c: Context<any>): string | null {
  const url = new URL(c.req.url);
  if (requestScheme(c, url) !== "http" || isLocalHost(url.hostname)) {
    return null;
  }
  url.protocol = "https:";
  return url.toString();
}
