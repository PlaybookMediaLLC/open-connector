import type { ProviderDefinition } from "../../core/types.ts";

import { bufferActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "buffer",
  displayName: "Buffer",
  description: "Create, schedule, and inspect social-media posts through Buffer.",
  categories: ["Social", "Marketing"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "API Key",
      placeholder: "BUFFER_API_KEY",
      description:
        "Buffer API key sent as a Bearer token. Create it in Settings > API: https://publish.buffer.com/settings/api",
    },
  ],
  homepageUrl: "https://buffer.com",
  actions: bufferActions,
};
