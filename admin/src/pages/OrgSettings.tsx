/**
 * OrgSettings — per-organization admin page.
 *
 * Tabs: General | Members | Invites | Audit
 *
 * General tab pulls from /api/auth/me (org_id, org_role, principal_type
 * etc. are now in the session). Other tabs show "endpoint not yet wired"
 * placeholders — will be replaced when expert lands org/members/invites
 * endpoints (Phase 5.3 invites, Phase 5.4 org API).
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAuthMe } from "../lib/api";

type Tab = "general" | "members" | "invites" | "audit";

export function OrgSettings({ orgId }: { orgId: string }) {
  const [tab, setTab] = useState<Tab>("general");
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });

  const account = me.data?.account;
  const currentOrgId = account?.org_id ?? null;
  const currentRole = account?.org_role ?? null;
  const isOwnerOrAdmin = currentRole === "owner" || currentRole === "admin";

  // Only render the page if the URL's orgId matches the current account's
  // org (a principal can't access other orgs).
  const isCurrentOrg = currentOrgId === orgId;

  return (
    <div className="p-4">
      <div className="mb-6">
        <div className="text-sm text-slate-500">Organization</div>
        <h1 className="text-2xl font-bold">
          {account
            ? `${account.server_slug ?? account.server_id} · Raft org`
            : "Settings"}
        </h1>
        <div className="text-sm text-slate-500 font-mono">{orgId}</div>
      </div>

      {me.isLoading && <p className="text-slate-500">Loading…</p>}
      {me.error && (
        <p className="text-red-600">Failed: {(me.error as Error).message}</p>
      )}

      {!isCurrentOrg && currentOrgId && (
        <div className="card !p-4 bg-yellow-50 border-yellow-200 text-yellow-800 text-sm mb-4">
          ⚠ The org in the URL ({orgId}) doesn't match your current org (
          {currentOrgId}). Multi-org support deferred to v2.
        </div>
      )}

      <div className="flex gap-2 mb-4 border-b border-slate-200">
        {(["general", "members", "invites", "audit"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm ${
              tab === t
                ? "border-b-2 border-blue-600 font-medium text-slate-900"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t === "general"
              ? "General"
              : t === "members"
                ? "Members"
                : t === "invites"
                  ? "Invites"
                  : "Audit"}
          </button>
        ))}
      </div>

      {tab === "general" && (
        <div className="card !p-4 text-sm space-y-2">
          <Row k="External provider" v={account?.provider ?? "?"} />
          <Row k="External ID (Raft server_id)" v={account?.server_id ?? "?"} />
          <Row k="Server slug" v={account?.server_slug ?? "—"} />
          <Row
            k="Your principal type"
            v={
              account?.principal_type === "agent"
                ? "agent (Raft)"
                : account?.principal_type === "human"
                  ? "human (Raft)"
                  : "—"
            }
          />
          <Row k="Your org_id" v={currentOrgId ?? "—"} mono />
          <Row
            k="Your org_role"
            v={currentRole ?? "—"}
            color={
              currentRole === "owner"
                ? "#a855f7"
                : currentRole === "admin"
                  ? "#3b82f6"
                  : undefined
            }
          />
          <Row
            k="Your server_role (from Raft)"
            v={account?.server_role ?? "—"}
          />
          <p className="text-xs text-slate-500 pt-3 border-t border-slate-100">
            Future: editable org name + slug, danger zone (archive org),
            sign-up mode (open vs invite-only).
          </p>
        </div>
      )}

      {tab === "members" && (
        <div className="card !p-4 text-sm text-slate-600">
          <p className="mb-2">
            <strong>Members tab scaffold.</strong> Will show table:
          </p>
          <ul className="text-xs text-slate-500 list-disc list-inside space-y-1">
            <li>Avatar + display name (humans + agents distinguished by badge)</li>
            <li>Email (humans) or agent manifest URL (agents)</li>
            <li>Role: owner / admin / member / viewer (dropdown to change)</li>
            <li>Joined at, invited by</li>
            <li>Last login at (from raft_accounts.last_login_at)</li>
            <li>Actions: change role, remove member</li>
          </ul>
          <EndpointNote endpoint="GET /api/orgs/:orgId/members" />
          {!isOwnerOrAdmin && (
            <p className="text-xs text-yellow-700 mt-2">
              ⚠ Your current role is "{currentRole ?? "—"}" — members
              management requires owner / admin.
            </p>
          )}
        </div>
      )}

      {tab === "invites" && (
        <div className="card !p-4 text-sm text-slate-600">
          <p className="mb-2">
            <strong>Invites tab scaffold.</strong> Will show:
          </p>
          <ul className="text-xs text-slate-500 list-disc list-inside space-y-1">
            <li>Pending invites table (email + role + expires + invited_by)</li>
            <li>Resend / Revoke actions</li>
            <li>"+ Invite member" button → modal: email + role + optional message</li>
            <li>For self-hosted: server-only mode (no invites, all same-server logins auto-join)</li>
          </ul>
          <EndpointNote endpoint="GET /api/orgs/:orgId/invites" />
          <p className="mt-3 text-xs text-slate-500">
            Per @artin's design: same-Raft-server logins auto-join the org,
            so invites are mostly for cross-org (rare). Most of the time the
            members tab is what matters.
          </p>
        </div>
      )}

      {tab === "audit" && (
        <div className="card !p-4 text-sm text-slate-600">
          <p className="mb-2">
            <strong>Audit tab scaffold.</strong> Will show filtered audit_logs
            scoped to this org (cross-app aggregation). Each row: actor +
            actor_type (human/agent/system) + action + target + timestamp.
          </p>
          <EndpointNote endpoint="GET /api/orgs/:orgId/audit-logs" />
          <p className="text-xs text-slate-500">
            Per docs/account-org-invite.md §6.2 — audit is org-level view of
            all app_member + channel + version + release events.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({
  k,
  v,
  mono,
  color,
}: {
  k: string;
  v: string;
  mono?: boolean | undefined;
  color?: string | undefined;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-48 text-xs text-slate-500">{k}</div>
      <div
        className={mono ? "font-mono text-xs" : "text-sm"}
        style={{ color }}
      >
        {v}
      </div>
    </div>
  );
}

function EndpointNote({ endpoint }: { endpoint: string }) {
  return (
    <p className="text-xs text-slate-500 pt-3 mt-3 border-t border-slate-100">
      Will call <code className="text-xs">{endpoint}</code> when that
      endpoint ships (currently being implemented by @Codex-Kuikly-KMP专家 on
      task #12 + #13).
    </p>
  );
}