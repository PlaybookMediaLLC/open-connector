import type { CloudflareEnv } from "../server/cloudflare/cloudflare-env.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { D1LikeDatabase } from "./db.ts";
import type { LensInstallation } from "./install-node.ts";

import { ActionPolicyService, parseActionPolicyList } from "../core/action-policy.ts";
import { D1RuntimeDatabase } from "../server/storage/d1-runtime-store.ts";
import { D1LensDb, LazyLensDb } from "./db.ts";
import { parseLensPolicyEnv } from "./policy.ts";
import { registerLensRoutes } from "./routes.ts";
import { LensRuntime } from "./runtime.ts";

export interface LensWorkerInstallOptions {
  env: CloudflareEnv;
  secretCodec: ISecretCodec;
}

/**
 * Workers entry for the lens control plane. Uses the deployment's D1 binding
 * with lens_ prefixed tables and self-bootstraps the schema per isolate.
 * Builds its own upstream store handles from env so the cloudflare.ts seam
 * stays additive-only (rfc/0004).
 *
 * ponytail: the upstream worker app cache key does not include LENS_POLICY, so
 * a policy change applies when the isolate recycles; redeploy to force it.
 */
export async function installLensWorker(options: LensWorkerInstallOptions): Promise<LensInstallation> {
  const env = options.env;
  const lensEnv = env as { LENS_POLICY?: string; LENS_DISABLED?: string };
  if (lensEnv.LENS_DISABLED === "1" || lensEnv.LENS_DISABLED === "true" || !env.DB) {
    return { registerRoutes: () => {} };
  }
  // Lazy: upstream worker app creation must not touch D1; the schema
  // bootstraps on the first real lens read or write instead.
  const db = new LazyLensDb(new D1LensDb(env.DB as unknown as D1LikeDatabase));
  const upstreamDatabase = new D1RuntimeDatabase(env.DB, { secretCodec: options.secretCodec });
  const runtime = new LensRuntime({
    db,
    secretCodec: options.secretCodec,
    deploymentPolicy: parseLensPolicyEnv(lensEnv.LENS_POLICY),
    upstream: {
      actionPolicy: new ActionPolicyService({
        allowedActions: parseActionPolicyList(env.OOMOL_CONNECT_ALLOWED_ACTIONS),
        blockedActions: parseActionPolicyList(env.OOMOL_CONNECT_BLOCKED_ACTIONS),
        allowedProxies: parseActionPolicyList(env.OOMOL_CONNECT_ALLOWED_PROXIES),
        blockedProxies: parseActionPolicyList(env.OOMOL_CONNECT_BLOCKED_PROXIES),
      }),
      tokenStore: upstreamDatabase.runtimeTokenStore,
      policyStore: upstreamDatabase.runtimePolicyStore,
    },
  });
  return {
    wrapActionRunner: (actions) => runtime.wrap(actions),
    registerRoutes: (app) => registerLensRoutes(app, { runtime, adminToken: env.OOMOL_CONNECT_ADMIN_TOKEN }),
  };
}
