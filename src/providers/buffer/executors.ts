import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";

import { defineApiKeyProviderExecutors, defineProviderProxy } from "../provider-runtime.ts";
import { bufferActionHandlers, validateBufferCredential } from "./runtime.ts";

const service = "buffer";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, bufferActionHandlers);

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validateBufferCredential(input.apiKey, fetcher, signal);
  },
};

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: "https://api.buffer.com",
  auth: { type: "api_key_authorization", prefix: "Bearer " },
});
