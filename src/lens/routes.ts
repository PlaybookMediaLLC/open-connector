import type { LensRuntime } from "./runtime.ts";
import type { Context, Hono } from "hono";

import { sha256Hex } from "./canonical.ts";
import { parseLensPolicy } from "./policy.ts";

export interface LensRoutesOptions {
  runtime: LensRuntime;
  adminToken?: string;
}

/**
 * Mounts the lens control-plane API under /lens (rfc/0001, rfc/0004).
 * Approval resolution requires console (admin) authentication; runtime
 * tokens are never sufficient to approve an action.
 */
export function registerLensRoutes(app: Hono, options: LensRoutesOptions): void {
  const requireAdmin = async (context: Context): Promise<Response | undefined> => {
    if (!options.adminToken) {
      return undefined;
    }
    const header = context.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    // Digest comparison keeps the check timing-independent of the token contents.
    if (token && (await sha256Hex(token)) === (await sha256Hex(options.adminToken))) {
      return undefined;
    }
    return context.json({ success: false, errorCode: "unauthorized", message: "Admin authentication required." }, 401);
  };

  app.get("/lens/api/approvals", async (context) => {
    const denied = await requireAdmin(context);
    if (denied) {
      return denied;
    }
    const state = context.req.query("state");
    const approvals = await options.runtime.approvals.list(
      state as Parameters<LensRuntime["approvals"]["list"]>[0],
      new Date().toISOString(),
    );
    return context.json({
      success: true,
      data: approvals.map((approval) => ({
        id: approval.id,
        principalId: approval.principalId,
        subjectId: approval.subjectId,
        tokenId: approval.tokenId,
        actionId: approval.actionId,
        providerId: approval.providerId,
        connectionName: approval.connectionName,
        state: approval.state,
        requestedAt: approval.requestedAt,
        expiresAt: approval.expiresAt,
        resolvedAt: approval.resolvedAt,
        resolvedBy: approval.resolvedBy,
        resolutionReason: approval.resolutionReason,
        runId: approval.runId,
        inputDigest: approval.inputDigest,
        policySnapshotId: approval.policySnapshotId,
      })),
    });
  });

  app.post("/lens/api/approvals/:id/approve", async (context) => {
    const denied = await requireAdmin(context);
    if (denied) {
      return denied;
    }
    const body = await readJsonBody(context);
    const result = await options.runtime.resolveApproval(
      context.req.param("id"),
      "console",
      typeof body.reason === "string" ? body.reason : undefined,
    );
    return context.json({ success: result.ok, data: result }, result.ok ? 200 : 409);
  });

  app.post("/lens/api/approvals/:id/deny", async (context) => {
    const denied = await requireAdmin(context);
    if (denied) {
      return denied;
    }
    const body = await readJsonBody(context);
    const result = await options.runtime.denyApproval(
      context.req.param("id"),
      "console",
      typeof body.reason === "string" ? body.reason : undefined,
    );
    return context.json({ success: result.ok, data: result }, result.ok ? 200 : 409);
  });

  app.post("/lens/api/policies/simulate", async (context) => {
    const denied = await requireAdmin(context);
    if (denied) {
      return denied;
    }
    const body = await readJsonBody(context);
    if (typeof body.actionId !== "string") {
      return context.json({ success: false, errorCode: "invalid_input", message: "actionId is required." }, 400);
    }
    const result = await options.runtime.simulate(
      typeof body.tokenId === "string" ? body.tokenId : "",
      body.actionId,
      body.input,
    );
    return context.json({ success: true, data: result });
  });

  app.get("/lens/api/tokens/:id/effective-policy", async (context) => {
    const denied = await requireAdmin(context);
    if (denied) {
      return denied;
    }
    const resolved = await options.runtime.resolve(context.req.param("id"));
    return context.json({
      success: true,
      data: { policy: resolved.policy, snapshotId: resolved.snapshotId, principal: resolved.principal },
    });
  });

  app.put("/lens/api/tokens/:id/policy", async (context) => {
    const denied = await requireAdmin(context);
    if (denied) {
      return denied;
    }
    let policy;
    try {
      policy = parseLensPolicy(await readJsonBody(context), "token policy");
    } catch (error) {
      return context.json(
        { success: false, errorCode: "invalid_input", message: error instanceof Error ? error.message : "invalid" },
        400,
      );
    }
    const record = await options.runtime.tokenPolicies.put(context.req.param("id"), policy, new Date().toISOString());
    return context.json({ success: true, data: { version: record.version } });
  });

  app.put("/lens/api/principals/:tokenId", async (context) => {
    const denied = await requireAdmin(context);
    if (denied) {
      return denied;
    }
    const body = await readJsonBody(context);
    if (typeof body.principalId !== "string" || body.principalId.length === 0) {
      return context.json({ success: false, errorCode: "invalid_input", message: "principalId is required." }, 400);
    }
    await options.runtime.principals.put(
      context.req.param("tokenId"),
      {
        principalId: body.principalId,
        subjectId: typeof body.subjectId === "string" ? body.subjectId : undefined,
        label: typeof body.label === "string" ? body.label : undefined,
      },
      new Date().toISOString(),
    );
    return context.json({ success: true, data: null });
  });

  app.get("/lens/api/decisions", async (context) => {
    const denied = await requireAdmin(context);
    if (denied) {
      return denied;
    }
    const rows = await options.runtime.evidence.list({
      principalId: context.req.query("principalId") || undefined,
      limit: Number(context.req.query("limit")) || undefined,
    });
    return context.json({ success: true, data: rows });
  });

  app.get("/lens/approvals", (context) => context.html(approvalsPage));
}

async function readJsonBody(context: Context): Promise<Record<string, unknown>> {
  try {
    const body = (await context.req.json()) as unknown;
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Minimal self-contained approvals console. The full console page arrives with the web/ rebuild. */
const approvalsPage = `<!doctype html>
<meta charset="utf-8"><title>Lens Approvals</title>
<style>
body{font:14px system-ui;margin:2rem;max-width:60rem}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}
button{margin-right:.4rem}input{width:100%;margin-bottom:1rem;padding:.4rem}
</style>
<h1>Lens Approvals</h1>
<input id="tok" type="password" placeholder="Admin token (leave empty if admin auth is disabled)">
<table><thead><tr><th>Action</th><th>Principal</th><th>Requested</th><th>Expires</th><th>State</th><th></th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
const headers = () => {
  const t = document.getElementById("tok").value;
  return t ? { authorization: "Bearer " + t, "content-type": "application/json" } : { "content-type": "application/json" };
};
async function load() {
  const res = await fetch("/lens/api/approvals?state=pending", { headers: headers() });
  const body = await res.json();
  const rows = document.getElementById("rows");
  rows.innerHTML = "";
  for (const a of body.data ?? []) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td>" + a.actionId + "</td><td>" + a.principalId + "</td><td>" + a.requestedAt +
      "</td><td>" + a.expiresAt + "</td><td>" + a.state + "</td><td></td>";
    for (const kind of ["approve", "deny"]) {
      const b = document.createElement("button");
      b.textContent = kind;
      b.onclick = async () => {
        await fetch("/lens/api/approvals/" + a.id + "/" + kind, { method: "POST", headers: headers(), body: "{}" });
        load();
      };
      tr.lastChild.append(b);
    }
    rows.append(tr);
  }
}
document.getElementById("tok").addEventListener("change", load);
load();
</script>`;
