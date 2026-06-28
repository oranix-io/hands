/**
 * `quiver whoami` — print the current authenticated account.
 */

import type { Command } from "commander";
import { apiRequest, QuiverApiError, getApiBase } from "../lib/api.js";
import { resolveSessionCookie } from "../lib/config.js";

interface MeResponse {
  account?: {
    id: string;
    provider: string;
    provider_subject: string;
    server_id: string;
    server_slug: string | null;
    principal_type: "human" | "agent";
    server_role: string | null;
    username: string | null;
    display_name: string;
    avatar_url: string | null;
    org_id: string | null;
    org_role: "owner" | "admin" | "member" | "viewer" | null;
  };
}

export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("Print the currently authenticated account + roles.")
    .option("--json", "Output machine-readable JSON.", false)
    .action(async (opts: { json?: boolean }) => {
      if (!resolveSessionCookie()) {
        console.error("Not logged in. Run `quiver login` first.");
        process.exit(1);
      }
      try {
        const me = await apiRequest<MeResponse>("/api/auth/me");
        if (!me.account) {
          console.error("Server returned no account info.");
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify(me, null, 2));
          return;
        }
        const a = me.account;
        console.log(`${a.display_name}  (${a.principal_type})`);
        console.log(`  server:  ${a.server_slug ?? a.server_id}`);
        console.log(`  username: @${a.username ?? "(none)"}`);
        console.log(`  org_id:  ${a.org_id ?? "(none)"}`);
        console.log(`  org_role: ${a.org_role ?? "(none)"}`);
        console.log(`  api:     ${getApiBase()}`);
      } catch (e) {
        if (e instanceof QuiverApiError && e.status === 401) {
          console.error("Not authenticated. Run `quiver login` to refresh.");
          process.exit(1);
        }
        throw e;
      }
    });
}
