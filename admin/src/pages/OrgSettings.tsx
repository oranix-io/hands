/**
 * OrgSettings — per-organization admin page.
 *
 * Tabs: General | Members | Invites | Audit
 *
 * Scaffold: page routes are wired + tab UI is laid out. Real data wiring
 * will land after expert completes P5.1 (org tables) and P5.2 (auth helpers).
 */

import { useState } from "react";

type Tab = "general" | "members" | "invites" | "audit";

export function OrgSettings({ orgId }: { orgId: string }) {
  const [tab, setTab] = useState<Tab>("general");

  return (
    <div className="p-4">
      <div className="mb-6">
        <div className="text-sm text-slate-500">Organization</div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <div className="text-sm text-slate-500 font-mono">{orgId}</div>
      </div>

      <div className="flex gap-2 mb-4 border-b border-slate-200">
        {(["general", "members", "invites", "audit"] as const).map((t) => (
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
        <div className="card !p-4 text-sm text-slate-600">
          <p className="mb-2">
            <strong>General tab scaffold.</strong> Will show org name, slug,
            external_provider (raft), external_id (server_id), created_at,
            archived status.
          </p>
          <p className="text-xs text-slate-500">
            Will populate when expert lands P5.1 schema + P5.2 auth helpers
            (org_id + org_role in session context).
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
          <p className="mt-3 text-xs text-slate-500">
            Per @artin's design: same-Raft-server logins auto-join the org, so
            invites are mostly for cross-org (rare). Most of the time the
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
          <p className="text-xs text-slate-500">
            Per docs/account-org-invite.md §6.2 — audit is org-level view of
            all app_member + channel + version + release events.
          </p>
        </div>
      )}
    </div>
  );
}