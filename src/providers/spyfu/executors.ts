import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";
import type { ApiKeyProviderContext, ProviderRuntimeHandler } from "../provider-runtime.ts";

import { defineApiKeyProviderExecutors, defineProviderProxy } from "../provider-runtime.ts";
import { spyfuActionHandlers, spyfuProxyBaseUrl, validateSpyfuCredential } from "./runtime.ts";

const handlers = Object.fromEntries(
  Object.entries(spyfuActionHandlers).map(([name, handler]) => [
    name,
    ((input, context) =>
      handler(input, context.fetcher, context.apiKey)) satisfies ProviderRuntimeHandler<ApiKeyProviderContext>,
  ]),
);

export const executors: ProviderExecutors = defineApiKeyProviderExecutors("spyfu", handlers, {
  skipDnsValidation: true,
});

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service: "spyfu",
  baseUrl: spyfuProxyBaseUrl,
  auth: { type: "api_key_query", name: "api_key" },
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher }) {
    return validateSpyfuCredential({ apiKey: input.apiKey }, fetcher).then((result) => ({
      profile: { accountId: `spyfu:${input.apiKey.slice(-8)}`, displayName: result.accountLabel },
      metadata: result.providerMetadata,
    }));
  },
};
