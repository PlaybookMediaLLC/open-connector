import type { ProviderDefinition } from "../../core/types.ts";

import { postBridgeActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "post_bridge",
  displayName: "Post Bridge",
  description: "Create, schedule, and measure social media posts across connected social accounts.",
  categories: ["Social", "Marketing"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "API Key",
      placeholder: "POST_BRIDGE_API_KEY",
      description:
        "Post Bridge API key used with the Authorization Bearer header. Create it in Settings > API: https://www.post-bridge.com/dashboard/api-keys",
    },
  ],
  homepageUrl: "https://www.post-bridge.com",
  actions: postBridgeActions,
};
