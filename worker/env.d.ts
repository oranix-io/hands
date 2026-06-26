/**
 * Workaround for ADMIN_API_TOKEN being a Cloudflare Worker secret binding
 * (not in `vars`), so wrangler types doesn't include it. We declare it
 * explicitly here as `string | undefined`.
 */

import "@cloudflare/workers-types";

declare global {
  interface Env {
    ADMIN_API_TOKEN?: string;
  }
}

export {};