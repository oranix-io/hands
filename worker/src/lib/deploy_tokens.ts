import type { AppRole } from "./permissions";

const TOKEN_PREFIX = "qvdt";

export type DeployTokenRole = Extract<AppRole, "publisher" | "viewer">;

export type AppDeployToken = {
  id: string;
  app_id: string;
  app_slug: string;
  name: string;
  token_prefix: string;
  app_role: DeployTokenRole;
  created_by: string | null;
  created_by_actor: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
};

export function isDeployTokenRole(value: unknown): value is DeployTokenRole {
  return value === "publisher" || value === "viewer";
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateDeployToken(): { token: string; token_prefix: string } {
  const prefixBytes = new Uint8Array(8);
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(prefixBytes);
  crypto.getRandomValues(secretBytes);
  const token_prefix = `${TOKEN_PREFIX}_${base64Url(prefixBytes)}`;
  return {
    token_prefix,
    token: `${token_prefix}_${base64Url(secretBytes)}`,
  };
}

export async function hashDeployToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export async function loadDeployToken(
  env: Env,
  token: string | undefined,
): Promise<AppDeployToken | null> {
  if (!token?.startsWith(`${TOKEN_PREFIX}_`)) return null;
  const tokenHash = await hashDeployToken(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT dt.id, dt.app_id, a.slug AS app_slug, dt.name, dt.token_prefix,
            dt.app_role, dt.created_by, dt.created_by_actor, dt.created_at,
            dt.expires_at, dt.last_used_at, dt.revoked_at
     FROM app_deploy_tokens dt
     JOIN apps a ON a.id = dt.app_id
     WHERE dt.token_hash = ?1
       AND dt.revoked_at IS NULL
       AND (dt.expires_at IS NULL OR dt.expires_at > ?2)
     LIMIT 1`,
  )
    .bind(tokenHash, now)
    .first<AppDeployToken>();

  if (!row) return null;

  await env.DB.prepare(
    "UPDATE app_deploy_tokens SET last_used_at = ?1 WHERE id = ?2",
  )
    .bind(now, row.id)
    .run();
  return { ...row, last_used_at: now };
}
