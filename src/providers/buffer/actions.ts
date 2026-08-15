import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "buffer";

const idSchema = s.nonEmptyString("Buffer resource ID.");
const rawObjectSchema = (description: string) => s.looseObject(description);
const assetSchema = s.oneOf(
  ["image", "video", "document", "link"].map((kind) =>
    s.object(
      `A Buffer ${kind} asset. Exactly one asset type is allowed per entry.`,
      {
        [kind]: s.object(
          `Buffer ${kind} asset details.`,
          { url: s.url(`Public ${kind} URL.`), metadata: s.looseObject("Optional asset metadata.") },
          { required: ["url"], optional: ["metadata"] },
        ),
      },
      { required: [kind] },
    ),
  ),
  { description: "A single image, video, document, or link asset." },
);

export const bufferActions: readonly ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "get_account",
    description: "Get the account associated with the Buffer API key.",
    requiredScopes: [],
    inputSchema: s.object("No input is required.", {}),
    outputSchema: s.object("Buffer account.", { id: idSchema, email: s.email("Account email address.") }),
  }),
  defineProviderAction(service, {
    name: "list_organizations",
    description: "List Buffer organizations available to the authenticated account.",
    requiredScopes: [],
    inputSchema: s.object("No input is required.", {}),
    outputSchema: s.array("Buffer organizations.", rawObjectSchema("Buffer organization.")),
  }),
  defineProviderAction(service, {
    name: "list_channels",
    description: "List connected social channels in a Buffer organization.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input for listing channels.",
      { organizationId: idSchema },
      { required: ["organizationId"] },
    ),
    outputSchema: s.array("Buffer channels.", rawObjectSchema("Buffer channel.")),
  }),
  defineProviderAction(service, {
    name: "get_channel",
    description: "Get one Buffer social channel by ID.",
    requiredScopes: [],
    inputSchema: s.object("Input for reading a channel.", { channelId: idSchema }, { required: ["channelId"] }),
    outputSchema: s.object("Buffer channel.", {
      id: idSchema,
      name: s.string("Channel name."),
      displayName: s.string("Channel display name."),
      service: s.string("Social service name."),
      avatar: s.url("Channel avatar URL."),
      isQueuePaused: s.boolean("Whether the publishing queue is paused."),
    }),
  }),
  defineProviderAction(service, {
    name: "list_posts",
    description: "List Buffer posts in an organization with cursor pagination.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input for listing posts.",
      {
        organizationId: idSchema,
        after: idSchema,
        first: s.positiveInteger("Maximum number of posts to return."),
      },
      { required: ["organizationId"], optional: ["after", "first"] },
    ),
    outputSchema: rawObjectSchema("Buffer post connection with pageInfo and edges."),
  }),
  defineProviderAction(service, {
    name: "get_post",
    description: "Get one Buffer post and its available metrics.",
    requiredScopes: [],
    inputSchema: s.object("Input for reading a post.", { postId: idSchema }, { required: ["postId"] }),
    outputSchema: rawObjectSchema("Buffer post."),
  }),
  defineProviderAction(service, {
    name: "create_post",
    description: "Create a Buffer text or media post, optionally as a draft or scheduled post.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input for creating a Buffer post.",
      {
        channelId: idSchema,
        text: s.string("Post text."),
        schedulingType: s.stringEnum("Scheduling behavior.", ["automatic", "notification"]),
        mode: s.stringEnum("Publishing behavior.", ["addToQueue", "shareNow", "shareNext"]),
        dueAt: s.dateTime("Scheduled publish date and time in UTC ISO 8601 format."),
        assets: s.array("Ordered public media assets.", assetSchema),
        metadata: s.looseObject("Network-specific post metadata, such as threaded-post content."),
        needsApproval: s.boolean("Whether the post requires approval."),
        saveToDraft: s.boolean("Whether to save the post as a draft."),
      },
      {
        required: ["channelId", "text", "schedulingType", "mode"],
        optional: ["dueAt", "assets", "metadata", "needsApproval", "saveToDraft"],
      },
    ),
    outputSchema: rawObjectSchema("Buffer create-post result. It contains either a created post or a mutation error."),
  }),
];
