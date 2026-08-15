import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "postiz";

const idSchema = s.nonEmptyString("Postiz resource ID.");
const mediaSchema = s.object(
  "A Postiz media file returned by upload_file or upload_from_url.",
  {
    id: s.nonEmptyString("Postiz media file ID."),
    path: s.url("Public URL of the uploaded file."),
  },
  { required: ["id", "path"] },
);
const postContentSchema = s.object(
  "One item in a post or thread.",
  {
    content: s.string("Post text content."),
    id: s.nonEmptyString("Existing post-content ID when updating content."),
    image: s.array("Media files to attach to this item.", mediaSchema),
  },
  { required: ["content"], optional: ["id", "image"] },
);
const postItemSchema = s.object(
  "A post for one connected social channel.",
  {
    integration: s.object("The target connected channel.", { id: idSchema }, { required: ["id"] }),
    value: s.array("Post or thread items for this channel.", postContentSchema, { minItems: 1 }),
    group: idSchema,
    settings: s.looseObject(
      "Settings for the target social platform. Use get_integration_settings to discover its shape.",
    ),
  },
  { required: ["integration", "value"], optional: ["group", "settings"] },
);
const tagSchema = s.object(
  "A Postiz tag.",
  { value: s.nonEmptyString("Tag value."), label: s.nonEmptyString("Tag label.") },
  { required: ["value", "label"] },
);
const postCreationSchema = s.object(
  "A Postiz post or schedule request.",
  {
    type: s.stringEnum("Whether to save as a draft, schedule, or publish now.", ["draft", "schedule", "now"]),
    date: s.dateTime("Publish date and time in UTC ISO 8601 format."),
    shortLink: s.boolean("Whether Postiz should shorten links."),
    tags: s.array("Postiz tags to attach.", tagSchema),
    posts: s.array("Posts for connected channels. Required unless type is draft.", postItemSchema, { minItems: 1 }),
    order: s.string("Order for related posts."),
    inter: s.number("Interval between related posts."),
  },
  { required: ["type", "date", "shortLink", "tags"], optional: ["posts", "order", "inter"] },
);
const rawObjectSchema = (description: string) => s.looseObject(description);

export const postizActions: readonly ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_integrations",
    description: "List connected social-media channels, optionally limited to one Postiz group.",
    requiredScopes: [],
    inputSchema: s.object("Filters for Postiz integrations.", { group: idSchema }, { optional: ["group"] }),
    outputSchema: s.array("Connected social-media channels.", rawObjectSchema("Postiz integration.")),
  }),
  defineProviderAction(service, {
    name: "list_groups",
    description: "List Postiz groups (customers) available to the API key.",
    requiredScopes: [],
    inputSchema: s.object("No input is required.", {}),
    outputSchema: s.array("Postiz groups.", rawObjectSchema("Postiz group.")),
  }),
  defineProviderAction(service, {
    name: "get_integration_settings",
    description: "Get the platform-specific settings schema for a connected social channel.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input for reading integration settings.",
      { integrationId: idSchema },
      { required: ["integrationId"] },
    ),
    outputSchema: rawObjectSchema("Platform-specific Postiz settings."),
  }),
  defineProviderAction(service, {
    name: "find_next_slot",
    description: "Get the next available publishing time for a connected social channel.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input for finding a publishing slot.",
      { integrationId: idSchema },
      { required: ["integrationId"] },
    ),
    outputSchema: s.object("The next available publishing time.", {
      date: s.dateTime("Next available UTC publish time."),
    }),
  }),
  defineProviderAction(service, {
    name: "list_posts",
    description: "List Postiz posts in a UTC date range.",
    requiredScopes: [],
    inputSchema: s.object(
      "Filters for listing posts.",
      {
        startDate: s.dateTime("Start of the UTC date range."),
        endDate: s.dateTime("End of the UTC date range."),
        customer: idSchema,
      },
      { required: ["startDate", "endDate"], optional: ["customer"] },
    ),
    outputSchema: s.object("Postiz posts response.", {
      posts: s.array("Postiz posts.", rawObjectSchema("Postiz post.")),
    }),
  }),
  defineProviderAction(service, {
    name: "create_post",
    description: "Create, schedule, publish, or save a Postiz post as a draft.",
    requiredScopes: [],
    inputSchema: postCreationSchema,
    outputSchema: s.array("Created Postiz post records.", rawObjectSchema("Created post record.")),
  }),
  defineProviderAction(service, {
    name: "delete_post",
    description: "Delete a Postiz post and its related group posts.",
    requiredScopes: [],
    inputSchema: s.object("Input for deleting a post.", { id: idSchema }, { required: ["id"] }),
    outputSchema: s.object("Deleted Postiz post.", { id: idSchema }),
  }),
  defineProviderAction(service, {
    name: "update_post_status",
    description: "Move a Postiz post between draft and scheduled state without changing its date.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input for changing post status.",
      { id: idSchema, status: s.stringEnum("New post status.", ["draft", "schedule"]) },
      { required: ["id", "status"] },
    ),
    outputSchema: s.object("Updated Postiz post status.", {
      id: idSchema,
      state: s.stringEnum("Postiz internal post state.", ["DRAFT", "QUEUE"]),
    }),
  }),
  defineProviderAction(service, {
    name: "upload_file",
    description: "Upload a local transit file to Postiz for use in a post.",
    requiredScopes: [],
    inputSchema: s.object("Input for uploading a file.", { file: s.transitFile() }, { required: ["file"] }),
    outputSchema: mediaSchema,
  }),
  defineProviderAction(service, {
    name: "upload_from_url",
    description: "Import a publicly reachable media file into Postiz.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input for importing a media file.",
      { url: s.url("Public media URL to import.") },
      { required: ["url"] },
    ),
    outputSchema: mediaSchema,
  }),
  defineProviderAction(service, {
    name: "get_integration_analytics",
    description: "Get analytics for a connected social channel over a number of days.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input for integration analytics.",
      { integrationId: idSchema, days: s.nonEmptyString("Number of days to look back, such as 7 or 30.") },
      { required: ["integrationId", "days"] },
    ),
    outputSchema: s.array("Postiz integration analytics.", rawObjectSchema("Analytics series.")),
  }),
  defineProviderAction(service, {
    name: "get_post_analytics",
    description: "Get analytics for one published Postiz post over a number of days.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input for post analytics.",
      { postId: idSchema, days: s.nonEmptyString("Number of days to look back, such as 7 or 30.") },
      { required: ["postId", "days"] },
    ),
    outputSchema: s.array("Postiz post analytics.", rawObjectSchema("Analytics series.")),
  }),
];
