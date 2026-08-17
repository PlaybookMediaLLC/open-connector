import type { ActionPolicyService } from "../core/action-policy.ts";
import type { RuntimeLogger } from "../core/types.ts";
import type { ActionRunner } from "../server/actions/action-runner.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { RuntimeDatabase } from "../server/storage/runtime-database.ts";
import type { Hono } from "hono";

import { join } from "node:path";
import { SqliteLensDb } from "./db-sqlite.ts";
import { bootstrapLensSchema } from "./db.ts";
import { parseLensPolicyEnv } from "./policy.ts";
import { registerLensRoutes } from "./routes.ts";
import { LensRuntime } from "./runtime.ts";

export interface LensInstallation {
  wrapActionRunner?: (actions: ActionRunner) => ActionRunner;
  registerRoutes: (app: Hono) => void;
}

export interface LensNodeInstallOptions {
  dataDir: string;
  env: Record<string, string | undefined>;
  secretCodec: ISecretCodec;
  runtimeDatabase: RuntimeDatabase;
  actionPolicy?: ActionPolicyService;
  adminToken?: string;
  logger?: RuntimeLogger;
}

export const inertLensInstallation: LensInstallation = { registerRoutes: () => {} };

/**
 * Node entry for the lens control plane. Opens a lens-owned SQLite database
 * beside the upstream one and self-bootstraps the lens_ schema (rfc/0004).
 * A malformed LENS_POLICY throws here, so the runtime never starts half-configured.
 */
export async function installLens(options: LensNodeInstallOptions): Promise<LensInstallation> {
  if (options.env.LENS_DISABLED === "1" || options.env.LENS_DISABLED === "true") {
    return inertLensInstallation;
  }
  const db = new SqliteLensDb(join(options.dataDir, "lens.sqlite"));
  await bootstrapLensSchema(db);
  const runtime = new LensRuntime({
    db,
    secretCodec: options.secretCodec,
    deploymentPolicy: parseLensPolicyEnv(options.env.LENS_POLICY),
    upstream: {
      actionPolicy: options.actionPolicy,
      tokenStore: options.runtimeDatabase.runtimeTokenStore,
      policyStore: options.runtimeDatabase.runtimePolicyStore,
    },
    logger: options.logger,
  });
  return {
    wrapActionRunner: (actions) => runtime.wrap(actions),
    registerRoutes: (app) => registerLensRoutes(app, { runtime, adminToken: options.adminToken }),
  };
}
