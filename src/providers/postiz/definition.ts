import type { ProviderDefinition } from "../../core/types.ts";

import { postizActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "postiz",
  displayName: "Postiz",
  description: "Create, schedule, and measure social-media posts through connected Postiz channels.",
  categories: ["Social", "Marketing"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "API Key",
      placeholder: "POSTIZ_API_KEY",
      description:
        "Postiz API key sent in the Authorization header. Create it in Postiz Settings: https://docs.postiz.com/public-api/introduction",
    },
  ],
  homepageUrl: "https://postiz.com",
  actions: postizActions,
};
