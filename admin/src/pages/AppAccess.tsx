/**
 * AppAccess — per-app member management.
 *
 * Tab on AppDetail ("Access"). Shows app_members (humans + agents
 * granted per-app roles). Owner / admin only.
 *
 * Scaffold: shows current principal's effective role + endpoint placeholder
 * for the real /api/apps/:appId/members + /api/apps/:appId/invites
 * (Phase 5.3 invite endpoints, expert's #12 work).
 */

import { useQuery } from "@tanstack/react-query";
import { getAuthMe } from "../lib/api";

export function AppAccess({ appId }: { appId: string }) {
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const account = me.data?.account;
  const orgRole = account?.org_role ?? null;
  const isOrgOwnerOrAdmin = orgRole === "owner" || orgRole === "admin";

  return (
    <div className="space-y-4">
      <div className="card !p-4 text-sm">
        <div className="text-slate-600 mb-2">
          <strong>App Access tab scaffold.</strong> Will show per-app members
          (humans + agents) with their roles:
        </div>
        <ul className="text-xs text-slate-500 list-disc list-inside space-y-1">
          <li>Avatar + display name (humans + agents distinguished by badge)</li>
          <li>Principal type (human / agent)</li>
          <li>Per-app role: admin / publisher / viewer</li>
          <li>Joined at, invited by</li>
          <li>Actions: change role, remove (admin only)</li>
          <li>"+ Invite to this app" button (admin only) → modal: email + role</li>
        </ul>
        <p className="text-xs text-slate-500 mt-3 pt-3 border-t border-slate-100">
          Will call <code className="text-xs">
            GET /api/apps/{appId}/members
          </code>{" "}
          + <code className="text-xs">POST /api/apps/{appId}/members</code>{" "}
          (admin only) when those endpoints ship (expert's task #12 work +
          task #13 for per-route RBAC enforcement).
        </p>
      </div>

      <div className="card !p-4 text-sm">
        <div className="text-xs text-slate-500 mb-1">Your current access</div>
        <div className="space-y-1">
          <div>
            <span className="text-slate-500 mr-2">org_role:</span>
            <span
              className="text-sm font-medium"
              style={{
                color:
                  orgRole === "owner"
                    ? "#a855f7"
                    : orgRole === "admin"
                      ? "#3b82f6"
                      : undefined,
              }}
            >
              {orgRole ?? "—"}
            </span>
          </div>
          <div className="text-xs text-slate-500">
            {isOrgOwnerOrAdmin
              ? "✓ You can manage app members (owner/admin of org)"
              : "⚠ Owner/admin of org required to manage app members"}
          </div>
        </div>
      </div>
    </div>
  );
}