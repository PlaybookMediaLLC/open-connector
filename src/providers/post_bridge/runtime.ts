import type { ApiKeyProviderContext, ProviderFetch, ProviderRuntimeHandler } from "../provider-runtime.ts";

import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import { ProviderRequestError, providerUserAgent, readTransitFileInput } from "../provider-runtime.ts";

const apiBaseUrl = "https://api.post-bridge.com";
const validationPath = "/v1/social-accounts";
const supportedMediaMimeTypes = new Set(["image/png", "image/jpeg", "video/mp4", "video/quicktime", "application/pdf"]);

type PostBridgeActionHandler = ProviderRuntimeHandler<ApiKeyProviderContext>;
type PostBridgeRequestMode = "execute" | "validate";
type PostBridgeQueryValue = boolean | number | string | readonly string[] | undefined;

interface PostBridgeRequestOptions {
  context: Pick<ApiKeyProviderContext, "apiKey" | "fetcher" | "signal">;
  path: string;
  mode: PostBridgeRequestMode;
  method?: "DELETE" | "GET" | "PATCH" | "POST";
  query?: Record<string, PostBridgeQueryValue>;
  body?: Record<string, unknown>;
}

export const postBridgeActionHandlers: Record<string, PostBridgeActionHandler> = {
  list_social_accounts(input, context) {
    return requestPostBridge({
      path: "/v1/social-accounts",
      query: paginationAndFilters(input, ["platform", "username"]),
      context,
      mode: "execute",
    });
  },
  get_social_account(input, context) {
    return requestPostBridge({ path: `/v1/social-accounts/${socialAccountId(input)}`, context, mode: "execute" });
  },
  list_posts(input, context) {
    return requestPostBridge({
      path: "/v1/posts",
      query: paginationAndFilters(input, ["platform", "status"]),
      context,
      mode: "execute",
    });
  },
  create_post(input, context) {
    return requestPostBridge({ path: "/v1/posts", method: "POST", body: postBody(input), context, mode: "execute" });
  },
  get_post(input, context) {
    return requestPostBridge({ path: `/v1/posts/${resourceId(input)}`, context, mode: "execute" });
  },
  update_post(input, context) {
    const body = { ...input };
    delete body.id;
    return requestPostBridge({
      path: `/v1/posts/${resourceId(input)}`,
      method: "PATCH",
      body: postBody(body),
      context,
      mode: "execute",
    });
  },
  delete_post(input, context) {
    return requestPostBridge({ path: `/v1/posts/${resourceId(input)}`, method: "DELETE", context, mode: "execute" });
  },
  list_media(input, context) {
    return requestPostBridge({
      path: "/v1/media",
      query: paginationAndFilters(input, ["post_id", "type"]),
      context,
      mode: "execute",
    });
  },
  get_media(input, context) {
    return requestPostBridge({ path: `/v1/media/${resourceId(input)}`, context, mode: "execute" });
  },
  create_upload_url(input, context) {
    return requestPostBridge({
      path: "/v1/media/create-upload-url",
      method: "POST",
      body: input,
      context,
      mode: "execute",
    });
  },
  upload_media(input, context) {
    return uploadMedia(input, context);
  },
  delete_media(input, context) {
    return requestPostBridge({ path: `/v1/media/${resourceId(input)}`, method: "DELETE", context, mode: "execute" });
  },
  list_post_results(input, context) {
    return requestPostBridge({
      path: "/v1/post-results",
      query: paginationAndFilters(input, ["post_id", "platform"]),
      context,
      mode: "execute",
    });
  },
  get_post_result(input, context) {
    return requestPostBridge({ path: `/v1/post-results/${resourceId(input)}`, context, mode: "execute" });
  },
  list_analytics(input, context) {
    return requestPostBridge({
      path: "/v1/analytics",
      query: paginationAndFilters(input, ["platform", "post_result_id", "timeframe"]),
      context,
      mode: "execute",
    });
  },
  get_analytics(input, context) {
    return requestPostBridge({ path: `/v1/analytics/${resourceId(input)}`, context, mode: "execute" });
  },
  get_daily_analytics(input, context) {
    return requestPostBridge({ path: `/v1/analytics/${resourceId(input)}/daily`, context, mode: "execute" });
  },
  sync_analytics(input, context) {
    return requestPostBridge({
      path: "/v1/analytics/sync",
      method: "POST",
      query: { platform: optionalString(input.platform) },
      context,
      mode: "execute",
    });
  },
};

export async function validatePostBridgeCredential(
  apiKey: string,
  fetcher: ProviderFetch,
  signal?: AbortSignal,
): Promise<{
  profile: { accountId: string; displayName: string; grantedScopes: string[] };
  grantedScopes: string[];
  metadata: Record<string, unknown>;
}> {
  const payload = await requestPostBridge({
    path: validationPath,
    query: { limit: 1 },
    context: { apiKey, fetcher, signal },
    mode: "validate",
  });
  const record = optionalRecord(payload);
  const accounts = Array.isArray(record?.data) ? record.data : [];
  return {
    profile: { accountId: "post_bridge", displayName: "Post Bridge API Key", grantedScopes: [] },
    grantedScopes: [],
    metadata: { validationEndpoint: validationPath, connectedAccountCount: accounts.length },
  };
}

async function requestPostBridge(input: PostBridgeRequestOptions): Promise<unknown> {
  const url = new URL(input.path, apiBaseUrl);
  setQuery(url, input.query);
  let response: Response;
  try {
    response = await input.context.fetcher(url, {
      method: input.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.context.apiKey}`,
        ...(input.body ? { "content-type": "application/json" } : {}),
        "user-agent": providerUserAgent,
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: input.context.signal,
    });
  } catch (error) {
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `Post Bridge request failed: ${error.message}` : "Post Bridge request failed",
    );
  }

  const payload = await parseResponsePayload(response);
  if (!response.ok) throw toPostBridgeError(response.status, payload, input.mode);
  if (payload === undefined) throw new ProviderRequestError(502, "Post Bridge returned an empty response body");
  return payload;
}

function postBody(input: Record<string, unknown>): Record<string, unknown> {
  const body = { ...input };
  if (Array.isArray(body.media_urls)) {
    body.media_urls = body.media_urls.map((value) =>
      assertPublicHttpUrl(requiredString(value, "media_urls item", inputError), {
        fieldName: "media_urls item",
        createError: inputError,
      }).toString(),
    );
  }
  return body;
}

async function uploadMedia(input: Record<string, unknown>, context: ApiKeyProviderContext): Promise<unknown> {
  const source = await readTransitFileInput(input.file, context);
  if (!supportedMediaMimeTypes.has(source.mimeType)) {
    throw inputError(`file.mimeType must be one of ${Array.from(supportedMediaMimeTypes).join(", ")}`);
  }

  const uploadPayload = optionalRecord(
    await requestPostBridge({
      path: "/v1/media/create-upload-url",
      method: "POST",
      body: { mime_type: source.mimeType, size_bytes: source.sizeBytes, name: source.name },
      context,
      mode: "execute",
    }),
  );
  const mediaId = requiredString(uploadPayload?.media_id, "Post Bridge media_id", providerResponseError);
  const uploadUrl = assertPublicHttpUrl(
    requiredString(uploadPayload?.upload_url, "Post Bridge upload_url", providerResponseError),
    {
      fieldName: "Post Bridge upload_url",
      createError: providerResponseError,
    },
  );

  let response: Response;
  try {
    response = await context.fetcher(uploadUrl, {
      method: "PUT",
      headers: { "content-type": source.mimeType, "user-agent": providerUserAgent },
      body: source.file,
      signal: context.signal,
    });
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `Post Bridge media upload failed: ${error.message}` : "Post Bridge media upload failed",
    );
  }
  if (!response.ok) {
    throw new ProviderRequestError(
      response.status >= 500 ? 502 : 400,
      `Post Bridge media upload failed with status ${response.status}`,
    );
  }

  return { media_id: mediaId, name: optionalString(uploadPayload?.name) ?? source.name };
}

function paginationAndFilters(
  input: Record<string, unknown>,
  filters: readonly string[],
): Record<string, PostBridgeQueryValue> {
  return {
    offset: typeof input.offset === "number" ? input.offset : undefined,
    limit: typeof input.limit === "number" ? input.limit : undefined,
    ...Object.fromEntries(filters.map((name) => [name, queryValue(input[name])])),
  };
}

function queryValue(value: unknown): PostBridgeQueryValue {
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function setQuery(url: URL, query: Record<string, PostBridgeQueryValue> | undefined): void {
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(name, item);
    } else {
      url.searchParams.set(name, String(value));
    }
  }
}

async function parseResponsePayload(response: Response): Promise<unknown | undefined> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toPostBridgeError(status: number, payload: unknown, mode: PostBridgeRequestMode): ProviderRequestError {
  const record = optionalRecord(payload);
  const message =
    optionalString(record?.message) ??
    optionalString(record?.error) ??
    (typeof payload === "string" && payload.trim() ? payload : `Post Bridge request failed with status ${status}`);
  if (status === 429) return new ProviderRequestError(429, message, payload);
  if (mode === "validate" && status >= 400 && status < 500) return new ProviderRequestError(400, message, payload);
  if (status === 401 || status === 403 || status === 404) return new ProviderRequestError(status, message, payload);
  return new ProviderRequestError(status >= 500 ? 502 : 400, message, payload);
}

function resourceId(input: Record<string, unknown>): string {
  return encodeURIComponent(requiredString(input.id, "id", inputError));
}

function socialAccountId(input: Record<string, unknown>): string {
  const id = input.id;
  if (typeof id === "number" && Number.isInteger(id) && id > 0) return String(id);
  throw inputError("id must be a positive integer");
}

function inputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

function providerResponseError(message: string): ProviderRequestError {
  return new ProviderRequestError(502, `Post Bridge returned invalid upload data: ${message}`);
}
