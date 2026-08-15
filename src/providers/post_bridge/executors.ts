import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";

import { defineApiKeyProviderExecutors, defineProviderProxy } from "../provider-runtime.ts";
import { postBridgeActionHandlers, validatePostBridgeCredential } from "./runtime.ts";

const service = "post_bridge";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, postBridgeActionHandlers);

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validatePostBridgeCredential(input.apiKey, fetcher, signal);
  },
};

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: "https://api.post-bridge.com",
  auth: { type: "api_key_authorization", prefix: "Bearer " },
});
