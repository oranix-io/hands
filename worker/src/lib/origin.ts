import type { Context } from "hono";

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

export function requestOrigin(c: Context<any>): string {
  const url = new URL(c.req.url);
  let scheme = headerScheme(c) ?? url.protocol.replace(/:$/, "");
  if (scheme === "http" && !isLocalHost(url.hostname)) {
    scheme = "https";
  }
  return `${scheme}://${url.host}`;
}

export function isSecureRequest(c: Context<any>): boolean {
  return requestOrigin(c).startsWith("https://");
}
