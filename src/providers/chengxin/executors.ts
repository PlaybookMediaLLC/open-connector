import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { ApiKeyProviderContext, ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { ChengxinActionName } from "./actions.ts";

import { defineApiKeyProviderExecutors } from "../provider-runtime.ts";
import { chengxinActions } from "./actions.ts";
import { executeChengxinAction, validateChengxinCredential } from "./runtime.ts";

const handlers = Object.fromEntries(
  chengxinActions.map((action) => [
    action.name,
    ((input, context) =>
      executeChengxinAction(
        action.name as ChengxinActionName,
        input,
        context.apiKey,
        context.fetcher,
      )) satisfies ProviderRuntimeHandler<ApiKeyProviderContext>,
  ]),
);

export const executors: ProviderExecutors = defineApiKeyProviderExecutors("chengxin", handlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher }) {
    return validateChengxinCredential({ apiKey: input.apiKey }, fetcher).then((result) => ({
      profile: { accountId: `chengxin:${input.apiKey.slice(-8)}`, displayName: result.accountLabel },
      metadata: result.providerMetadata,
    }));
  },
};
