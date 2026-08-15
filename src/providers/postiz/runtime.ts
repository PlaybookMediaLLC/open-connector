import type { CredentialValidationResult } from "../../core/types.ts";
import type { ApiKeyProviderContext, ProviderFetch, ProviderRuntimeHandler } from "../provider-runtime.ts";

import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import {
  providerUserAgent,
  ProviderRequestError,
  readProviderJsonBody,
  readTransitFileInput,
} from "../provider-runtime.ts";

const apiBaseUrl = "https://api.postiz.com/public/v1";

type PostizActionHandler = ProviderRuntimeHandler<ApiKeyProviderContext>;
type PostizMethod = "DELETE" | "GET" | "POST" | "PUT";

interface PostizRequestOptions {
  context: Pick<ApiKeyProviderContext, "apiKey" | "fetcher" | "signal">;
  path: string;
  method?: PostizMethod;
  query?: Record<string, string | undefined>;
  body?: FormData | Record<string, unknown>;
}

export const postizActionHandlers: Record<string, PostizActionHandler> = {
  list_integrations(input, context) {
    return postizRequest({ context, path: "integrations", query: { group: optionalString(input.group) } });
  },
  list_groups(_input, context) {
    return postizRequest({ context, path: "groups" });
  },
  get_integration_settings(input, context) {
    return postizRequest({ context, path: `integration-settings/${id(input.integrationId, "integrationId")}` });
  },
  find_next_slot(input, context) {
    return postizRequest({ context, path: `find-slot/${id(input.integrationId, "integrationId")}` });
  },
  list_posts(input, context) {
    return postizRequest({
      context,
      path: "posts",
      query: {
        startDate: requiredString(input.startDate, "startDate", inputError),
        endDate: requiredString(input.endDate, "endDate", inputError),
        customer: optionalString(input.customer),
      },
    });
  },
  create_post(input, context) {
    validatePostMediaUrls(input);
    return postizRequest({ context, path: "posts", method: "POST", body: input });
  },
  delete_post(input, context) {
    return postizRequest({ context, path: `posts/${id(input.id, "id")}`, method: "DELETE" });
  },
  update_post_status(input, context) {
    return postizRequest({
      context,
      path: `posts/${id(input.id, "id")}/status`,
      method: "PUT",
      body: { status: requiredString(input.status, "status", inputError) },
    });
  },
  upload_file(input, context) {
    return uploadFile(input, context);
  },
  upload_from_url(input, context) {
    const url = assertPublicHttpUrl(requiredString(input.url, "url", inputError), {
      fieldName: "url",
      createError: inputError,
    });
    return postizRequest({ context, path: "upload-from-url", method: "POST", body: { url: url.toString() } });
  },
  get_integration_analytics(input, context) {
    return postizRequest({
      context,
      path: `analytics/${id(input.integrationId, "integrationId")}`,
      query: { date: requiredString(input.days, "days", inputError) },
    });
  },
  get_post_analytics(input, context) {
    return postizRequest({
      context,
      path: `analytics/post/${id(input.postId, "postId")}`,
      query: { date: requiredString(input.days, "days", inputError) },
    });
  },
};

export async function validatePostizCredential(
  apiKey: string,
  fetcher: ProviderFetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const payload = await postizRequest({ context: { apiKey, fetcher, signal }, path: "is-connected" });
  if (optionalRecord(payload)?.connected !== true) {
    throw new ProviderRequestError(401, "Postiz did not confirm this API key is connected.");
  }
  return {
    profile: { accountId: "postiz", displayName: "Postiz API Key", grantedScopes: [] },
    grantedScopes: [],
    metadata: { apiBaseUrl, validationEndpoint: "/is-connected" },
  };
}

async function uploadFile(input: Record<string, unknown>, context: ApiKeyProviderContext): Promise<unknown> {
  const source = await readTransitFileInput(input.file, context);
  const form = new FormData();
  form.set("file", source.file, source.name);
  return postizRequest({ context, path: "upload", method: "POST", body: form });
}

async function postizRequest(input: PostizRequestOptions): Promise<unknown> {
  const url = new URL(input.path, `${apiBaseUrl}/`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const isForm = input.body instanceof FormData;
  const body = input.body instanceof FormData ? input.body : input.body ? JSON.stringify(input.body) : undefined;
  const response = await input.context.fetcher(url, {
    method: input.method ?? "GET",
    headers: {
      accept: "application/json",
      authorization: input.context.apiKey,
      ...(input.body && !isForm ? { "content-type": "application/json" } : {}),
      "user-agent": providerUserAgent,
    },
    body,
    signal: input.context.signal,
  });
  const payload = await readProviderJsonBody(response, {
    emptyBody: {},
    invalidJsonMessage: "Postiz returned an invalid JSON response.",
    invalidJsonFallback: (text) => text,
  });
  if (!response.ok) {
    const record = optionalRecord(payload);
    const message =
      optionalString(record?.message) ??
      optionalString(record?.error) ??
      `Postiz request failed with status ${response.status}`;
    throw new ProviderRequestError(response.status, message, payload);
  }
  return payload;
}

function validatePostMediaUrls(input: Record<string, unknown>): void {
  if (!Array.isArray(input.posts)) return;
  for (const post of input.posts) {
    const values = optionalRecord(post)?.value;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const images = optionalRecord(value)?.image;
      if (!Array.isArray(images)) continue;
      for (const image of images) {
        assertPublicHttpUrl(requiredString(optionalRecord(image)?.path, "posts image path", inputError), {
          fieldName: "posts image path",
          createError: inputError,
        });
      }
    }
  }
}

function id(value: unknown, fieldName: string): string {
  return encodeURIComponent(requiredString(value, fieldName, inputError));
}

function inputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}
