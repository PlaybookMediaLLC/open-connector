import type { CredentialValidationResult } from "../../core/types.ts";
import type { ApiKeyProviderContext, ProviderFetch, ProviderRuntimeHandler } from "../provider-runtime.ts";

import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import { providerUserAgent, ProviderRequestError, readProviderJsonBody } from "../provider-runtime.ts";

const apiUrl = "https://api.buffer.com";

type BufferActionHandler = ProviderRuntimeHandler<ApiKeyProviderContext>;

export const bufferActionHandlers: Record<string, BufferActionHandler> = {
  async get_account(_input, context): Promise<unknown> {
    return bufferField(context, "account", "query { account { id email } }");
  },
  async list_organizations(_input, context): Promise<unknown> {
    const account = optionalRecord(
      await bufferField(context, "account", "query { account { organizations { id name ownerEmail } } }"),
    );
    if (!Array.isArray(account?.organizations)) throw providerResponseError("account organizations");
    return account.organizations;
  },
  async list_channels(input, context): Promise<unknown> {
    return bufferField(
      context,
      "channels",
      "query ListChannels($organizationId: ID!) { channels(input: { organizationId: $organizationId }) { id name displayName service avatar isQueuePaused } }",
      { organizationId: requiredString(input.organizationId, "organizationId", inputError) },
    );
  },
  async get_channel(input, context): Promise<unknown> {
    return bufferField(
      context,
      "channel",
      "query GetChannel($id: ID!) { channel(input: { id: $id }) { id name displayName service avatar isQueuePaused } }",
      { id: requiredString(input.channelId, "channelId", inputError) },
    );
  },
  async list_posts(input, context): Promise<unknown> {
    return bufferField(
      context,
      "posts",
      "query ListPosts($organizationId: ID!, $after: String, $first: Int) { posts(after: $after, first: $first, input: { organizationId: $organizationId }) { pageInfo { startCursor endCursor hasNextPage } edges { node { id text createdAt channelId } } } }",
      {
        organizationId: requiredString(input.organizationId, "organizationId", inputError),
        after: optionalString(input.after),
        first: typeof input.first === "number" ? input.first : undefined,
      },
    );
  },
  async get_post(input, context): Promise<unknown> {
    return bufferField(
      context,
      "post",
      "query GetPost($id: ID!) { post(input: { id: $id }) { id text channelId metrics { type name value unit } metricsUpdatedAt } }",
      { id: requiredString(input.postId, "postId", inputError) },
    );
  },
  async create_post(input, context): Promise<unknown> {
    validateAssetUrls(input.assets);
    return bufferField(
      context,
      "createPost",
      "mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id text channelId createdAt assets { id mimeType } } } ... on MutationError { message } } }",
      { input },
    );
  },
};

export async function validateBufferCredential(
  apiKey: string,
  fetcher: ProviderFetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const data = await bufferRequest({ apiKey, fetcher, signal }, "query { account { id email } }");
  const account = optionalRecord(data.account);
  const accountId = requiredString(account?.id, "Buffer account id", providerResponseError);
  const email = optionalString(account?.email) ?? "Buffer API Key";
  return {
    profile: { accountId, displayName: email, grantedScopes: [] },
    grantedScopes: [],
    metadata: { apiUrl, validationOperation: "account" },
  };
}

async function bufferField(
  context: ApiKeyProviderContext,
  field: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  const data = await bufferRequest(context, query, variables);
  if (!(field in data)) throw providerResponseError(field);
  return data[field];
}

async function bufferRequest(
  context: Pick<ApiKeyProviderContext, "apiKey" | "fetcher" | "signal">,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await context.fetcher(apiUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${context.apiKey}`,
      "content-type": "application/json",
      "user-agent": providerUserAgent,
    },
    body: JSON.stringify({ query, variables }),
    signal: context.signal,
  });
  const payload = await readProviderJsonBody(response, {
    emptyBody: {},
    invalidJsonMessage: "Buffer returned an invalid JSON response.",
    invalidJsonFallback: (text) => text,
  });
  const record = optionalRecord(payload);
  const errors = Array.isArray(record?.errors) ? record.errors : [];
  if (!response.ok || errors.length > 0) {
    const message = errors.map((error) => optionalString(optionalRecord(error)?.message)).find(Boolean);
    throw new ProviderRequestError(
      response.status >= 400 ? response.status : 400,
      message ?? "Buffer request failed.",
      payload,
    );
  }
  const data = optionalRecord(record?.data);
  if (!data) throw providerResponseError("response data");
  return data;
}

function validateAssetUrls(input: unknown): void {
  if (!Array.isArray(input)) return;
  for (const asset of input) {
    const record = optionalRecord(asset);
    for (const kind of ["image", "video", "document", "link"]) {
      const details = optionalRecord(record?.[kind]);
      if (!details) continue;
      assertPublicHttpUrl(requiredString(details.url, `assets ${kind} url`, inputError), {
        fieldName: `assets ${kind} url`,
        createError: inputError,
      });
    }
  }
}

function inputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

function providerResponseError(field: string): ProviderRequestError {
  return new ProviderRequestError(502, `Buffer returned invalid ${field}.`);
}
