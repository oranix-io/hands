/**
 * OrgSwitcher — top-bar dropdown for switching between orgs the user is in.
 *
 * v1: most users are in a single org (Raft server). The dropdown is a
 * no-op for them. When the user is in 2+ orgs (multi-Raft-server case),
 * the chevron appears in the Org nav link and clicking opens a dropdown
 * listing the orgs.
 *
 * P5.4.6 follow-up (task #23): when switching orgs, the SPA invalidates
 * the entire TanStack Query cache so apps / channels / releases / audit
 * logs for the previous org don't leak into the new org's view.
 */

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listOrgs, type Org } from "../lib/api";

export function OrgSwitcher({
  currentOrgId,
  buttonLabel,
  onClose,
  onSwitch,
}: {
  currentOrgId: string | null;
  buttonLabel: string;
  onClose: () => void;
  onSwitch?: (org: Org) => void;
}) {
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ["orgs"], queryFn: () => listOrgs() });
  const ref = useRef<HTMLDivElement>(null);

  // Click outside to close
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-1 w-72 bg-white border border-slate-200 rounded-md shadow-lg z-30"
    >
      <div className="text-xs text-slate-500 px-3 py-2 border-b border-slate-100">
        {buttonLabel}
      </div>
      <div className="py-1 max-h-64 overflow-y-auto">
        {orgs.isLoading && (
          <p className="text-xs text-slate-400 px-3 py-2">Loading…</p>
        )}
        {orgs.error && (
          <p className="text-xs text-red-600 px-3 py-2">
            Failed: {(orgs.error as Error).message}
          </p>
        )}
        {orgs.data?.orgs.map((o: Org) => {
          const isCurrent = o.id === currentOrgId;
          return (
            <Link
              key={o.id}
              to={`/orgs/${o.id}`}
              onClick={() => {
                // Invalidate the entire query cache on org switch so apps
                // / channels / releases / members / audit / etc. don't
                // leak across org boundaries. The destination page will
                // re-fetch what it needs.
                if (onSwitch && !isCurrent) onSwitch(o);
                onClose();
              }}
              className={`flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 ${
                isCurrent ? "bg-slate-50 font-medium" : ""
              }`}
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{
                  backgroundColor:
                    o.external_provider === "raft" ? "#3b82f6" : "#6b7280",
                }}
              />
              <span className="flex-1 truncate">
                <div>{o.name}</div>
                {o.slug && (
                  <div className="text-xs text-slate-500 font-mono">{o.slug}</div>
                )}
              </span>
              {isCurrent && <span className="text-xs text-blue-600">●</span>}
            </Link>
          );
        })}
      </div>
      <div className="text-xs text-slate-400 px-3 py-2 border-t border-slate-100">
        Multi-org: switching invalidates cache and reloads.
      </div>
    </div>
  );
}

// Re-export so callers can use the same QueryClient ref pattern.
export function useClearOrgCache() {
  const qc = useQueryClient();
  return (org: Org) => {
    // Wipe the entire query cache for the previous org. This includes:
    //   - orgs list (will refetch with the new org at the top)
    //   - org-members / invites / audit-logs / webhooks
    //   - apps list + per-app detail / channels / releases / builds / audit
    //   - auth-me (org_id / org_role may change)
    qc.removeQueries();
    // Re-prefetch the orgs list + auth-me in the background so the
    // new-org landing page doesn't show stale top bar.
    qc.prefetchQuery({ queryKey: ["auth-me"], queryFn: () => fetch("/api/auth/me").then((r) => r.json()) });
    qc.prefetchQuery({ queryKey: ["orgs"], queryFn: () => listOrgs() });
    void org; // currently unused — kept for future per-org cache logic
  };
}