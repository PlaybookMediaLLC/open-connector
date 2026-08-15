import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";

import { defineApiKeyProviderExecutors, defineProviderProxy } from "../provider-runtime.ts";
import { postizActionHandlers, validatePostizCredential } from "./runtime.ts";

const service = "postiz";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, postizActionHandlers);

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validatePostizCredential(input.apiKey, fetcher, signal);
  },
};

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: "https://api.postiz.com/public/v1",
  auth: { type: "api_key_authorization", prefix: "" },
});
