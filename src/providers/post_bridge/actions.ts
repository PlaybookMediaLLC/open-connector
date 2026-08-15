import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "post_bridge";

const idSchema = s.nonEmptyString("Post Bridge resource ID.");
const socialAccountIdSchema = s.positiveInteger("Connected social-account ID.");
const paginationFields = {
  offset: s.nonNegativeInteger("Number of items to skip."),
  limit: s.positiveInteger("Maximum number of items to return."),
};
const postPlatformSchema = s.stringEnum("Social platform to filter.", [
  "bluesky",
  "facebook",
  "google_business",
  "instagram",
  "linkedin",
  "pinterest",
  "threads",
  "tiktok",
  "twitter",
  "youtube",
]);
const postStatusSchema = s.stringEnum("Post status to filter.", ["posted", "scheduled", "processing", "failed"]);
const mediaTypeSchema = s.stringEnum("Media type to filter.", ["image", "video"]);
const mediaIdSchema = s.nonEmptyString("Post Bridge media ID.");
const mediaIdsSchema = s.array("Media IDs.", mediaIdSchema);
const mediaUrlsSchema = s.array("Public media URLs. Post Bridge imports these URLs.", s.url("A public media URL."));
const captionAndMediaFields = {
  caption: s.string("Caption override for this platform."),
  media: mediaIdsSchema,
};
const instagramConfigurationSchema = s.object(
  "Instagram post configuration.",
  {
    ...captionAndMediaFields,
    video_cover_timestamp_ms: s.nonNegativeInteger("Video-cover timestamp in milliseconds."),
    cover_image: mediaIdSchema,
    placement: s.stringEnum("Instagram placement.", ["story"]),
    is_trial_reel: s.boolean("Whether to create an Instagram trial reel."),
    trial_graduation: s.stringEnum("Trial-reel graduation strategy.", ["MANUAL", "SS_PERFORMANCE"]),
    user_tags: s.array("Instagram usernames to tag.", s.nonEmptyString("Instagram username."), { maxItems: 20 }),
    collaborators: s.array("Instagram usernames to invite as collaborators.", s.nonEmptyString("Instagram username."), {
      maxItems: 3,
    }),
  },
  {
    optional: [
      "caption",
      "media",
      "video_cover_timestamp_ms",
      "cover_image",
      "placement",
      "is_trial_reel",
      "trial_graduation",
      "user_tags",
      "collaborators",
    ],
  },
);
const tiktokConfigurationSchema = s.object(
  "TikTok post configuration.",
  {
    ...captionAndMediaFields,
    title: s.string("TikTok post title override."),
    video_cover_timestamp_ms: s.nonNegativeInteger("Video-cover timestamp in milliseconds."),
    draft: s.boolean("Whether TikTok should save the post as a draft."),
    is_aigc: s.boolean("Whether to label the video as AI-generated content."),
  },
  { optional: ["caption", "media", "title", "video_cover_timestamp_ms", "draft", "is_aigc"] },
);
const pinterestConfigurationSchema = s.object(
  "Pinterest post configuration.",
  {
    ...captionAndMediaFields,
    board_ids: s.array("Pinterest board IDs.", s.nonEmptyString("Pinterest board ID.")),
    link: s.url("Pinterest destination URL."),
    video_cover_timestamp_ms: s.nonNegativeInteger("Video-cover timestamp in milliseconds."),
    title: s.string("Pinterest post title."),
  },
  { optional: ["caption", "media", "board_ids", "link", "video_cover_timestamp_ms", "title"] },
);
const platformConfigurationsSchema = s.object(
  "Platform-specific overrides for the post.",
  {
    instagram: instagramConfigurationSchema,
    tiktok: tiktokConfigurationSchema,
    pinterest: pinterestConfigurationSchema,
    youtube: s.object(
      "YouTube post configuration.",
      {
        ...captionAndMediaFields,
        title: s.string("YouTube video title override."),
        contains_synthetic_media: s.boolean("Whether the video contains altered or synthetic media."),
        thumbnail: mediaIdSchema,
      },
      { optional: ["caption", "media", "title", "contains_synthetic_media", "thumbnail"] },
    ),
    twitter: s.object(
      "X post configuration.",
      { ...captionAndMediaFields, first_comment: s.string("Reply to publish after the main post.") },
      { optional: ["caption", "media", "first_comment"] },
    ),
    facebook: s.object(
      "Facebook post configuration.",
      { ...captionAndMediaFields, placement: s.stringEnum("Facebook placement.", ["story"]) },
      { optional: ["caption", "media", "placement"] },
    ),
    linkedin: s.object(
      "LinkedIn post configuration.",
      { ...captionAndMediaFields, document_title: s.string("LinkedIn document title.") },
      { optional: ["caption", "media", "document_title"] },
    ),
    threads: s.object(
      "Threads post configuration.",
      { ...captionAndMediaFields, location: s.stringEnum("Threads placement.", ["reels", "timeline"]) },
      { optional: ["caption", "media", "location"] },
    ),
    bluesky: s.object("Bluesky post configuration.", captionAndMediaFields, { optional: ["caption", "media"] }),
    google_business: s.object(
      "Google Business Profile post configuration.",
      {
        ...captionAndMediaFields,
        cta_action_type: s.stringEnum("Google Business Profile call-to-action type.", [
          "BOOK",
          "ORDER",
          "SHOP",
          "LEARN_MORE",
          "SIGN_UP",
          "CALL",
        ]),
        cta_url: s.url("Google Business Profile call-to-action URL."),
        language_code: s.nonEmptyString("BCP-47 language code."),
      },
      { optional: ["caption", "media", "cta_action_type", "cta_url", "language_code"] },
    ),
  },
  {
    optional: [
      "instagram",
      "tiktok",
      "pinterest",
      "youtube",
      "twitter",
      "facebook",
      "linkedin",
      "threads",
      "bluesky",
      "google_business",
    ],
  },
);
const accountConfigurationsSchema = s.object(
  "Per-account caption and media overrides.",
  {
    account_configurations: s.array(
      "Overrides for individual social accounts.",
      s.object(
        "One account-specific override.",
        { account_id: socialAccountIdSchema, caption: s.string("Caption override."), media: mediaIdsSchema },
        { optional: ["caption", "media"] },
      ),
    ),
  },
  { optional: ["account_configurations"] },
);
const useQueueSchema = s.union(
  [
    s.boolean("Use the saved Post Bridge queue timezone."),
    s.object("Use the queue with an explicit IANA timezone.", { timezone: s.nonEmptyString("IANA timezone.") }),
  ],
  { description: "Automatically schedule the post to the next queue slot. Do not use it with scheduled_at." },
);
const postFields = {
  caption: s.string("Post caption."),
  scheduled_at: s.nullable(s.dateTime("ISO 8601 scheduled time. Set null to post immediately.")),
  platform_configurations: platformConfigurationsSchema,
  account_configurations: accountConfigurationsSchema,
  media: mediaIdsSchema,
  media_urls: mediaUrlsSchema,
  social_accounts: s.array("Connected social-account IDs to publish to.", socialAccountIdSchema, { minItems: 1 }),
  is_draft: s.boolean("Whether to save the post as a draft."),
  processing_enabled: s.boolean("Whether Post Bridge should process video files before publishing."),
};
const paginationOutputSchema = s.looseRequiredObject("A paginated Post Bridge response.", {
  data: s.array("Returned records.", s.looseObject("A Post Bridge record.")),
  meta: s.looseRequiredObject("Pagination information.", {
    total: s.number("Total records available."),
    offset: s.number("Records skipped."),
    limit: s.number("Maximum records returned."),
    next: s.nullableString("Next-page URL, or null."),
  }),
});
const recordOutputSchema = s.looseObject("The Post Bridge response object.");

export const postBridgeActions: ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_social_accounts",
    description: "List connected social accounts, with optional platform and username filters.",
    inputSchema: s.object(
      "Filters for connected social accounts.",
      {
        ...paginationFields,
        platform: s.array("Platforms to include.", s.nonEmptyString("Platform name.")),
        username: s.array("Usernames to include.", s.nonEmptyString("Account username.")),
      },
      { optional: ["offset", "limit", "platform", "username"] },
    ),
    outputSchema: paginationOutputSchema,
  }),
  defineProviderAction(service, {
    name: "get_social_account",
    description: "Get one connected social account.",
    inputSchema: s.object("The social account to retrieve.", { id: socialAccountIdSchema }),
    outputSchema: recordOutputSchema,
  }),
  defineProviderAction(service, {
    name: "list_posts",
    description: "List posts with optional platform and status filters.",
    inputSchema: s.object(
      "Filters for posts.",
      {
        ...paginationFields,
        platform: s.array("Platforms to include.", postPlatformSchema),
        status: s.array("Statuses to include.", postStatusSchema),
      },
      { optional: ["offset", "limit", "platform", "status"] },
    ),
    outputSchema: paginationOutputSchema,
  }),
  defineProviderAction(service, {
    name: "create_post",
    description: "Create a post to publish immediately, schedule, queue, or save as a draft.",
    inputSchema: s.object(
      "Post data.",
      { ...postFields, use_queue: useQueueSchema },
      {
        optional: [
          "scheduled_at",
          "platform_configurations",
          "account_configurations",
          "media",
          "media_urls",
          "is_draft",
          "processing_enabled",
          "use_queue",
        ],
      },
    ),
    outputSchema: recordOutputSchema,
  }),
  defineProviderAction(service, {
    name: "get_post",
    description: "Get a post by ID.",
    inputSchema: s.object("The post to retrieve.", { id: idSchema }),
    outputSchema: recordOutputSchema,
  }),
  defineProviderAction(service, {
    name: "update_post",
    description: "Update a scheduled or draft post. Include scheduled_at when changing a scheduled post.",
    inputSchema: s.object(
      "Post changes.",
      { id: idSchema, ...postFields },
      {
        optional: [
          "caption",
          "scheduled_at",
          "platform_configurations",
          "account_configurations",
          "media",
          "media_urls",
          "social_accounts",
          "is_draft",
          "processing_enabled",
        ],
      },
    ),
    outputSchema: recordOutputSchema,
  }),
  defineProviderAction(service, {
    name: "delete_post",
    description: "Delete a scheduled or draft post.",
    inputSchema: s.object("The post to delete.", { id: idSchema }),
    outputSchema: recordOutputSchema,
  }),
  defineProviderAction(service, {
    name: "list_media",
    description: "List uploaded media with optional post and media-type filters.",
    inputSchema: s.object(
      "Filters for media.",
      {
        ...paginationFields,
        post_id: s.array("Post IDs to include.", idSchema),
        type: s.array("Media types to include.", mediaTypeSchema),
      },
      { optional: ["offset", "limit", "post_id", "type"] },
    ),
    outputSchema: paginationOutputSchema,
  }),
  defineProviderAction(service, {
    name: "get_media",
    description: "Get uploaded media by ID.",
    inputSchema: s.object("The media to retrieve.", { id: idSchema }),
    outputSchema: recordOutputSchema,
  }),
  defineProviderAction(service, {
    name: "create_upload_url",
    description: "Create a signed URL for uploading media, then use its media_id when creating a post.",
    inputSchema: s.object("Media upload metadata.", {
      mime_type: s.stringEnum("Media MIME type.", [
        "image/png",
        "image/jpeg",
        "video/mp4",
        "video/quicktime",
        "application/pdf",
      ]),
      size_bytes: s.positiveInteger("Media file size in bytes."),
      name: s.nonEmptyString("Original file name."),
    }),
    outputSchema: s.looseRequiredObject("Signed media-upload details.", {
      media_id: mediaIdSchema,
      upload_url: s.url("Signed URL for uploading the media bytes."),
      name: s.nonEmptyString("Original file name."),
    }),
  }),
  defineProviderAction(service, {
    name: "upload_media",
    description: "Upload a local transit file to Post Bridge and return its media ID.",
    inputSchema: s.object("Media file to upload.", {
      file: s.transitFile("A PNG, JPEG, MP4, QuickTime video, or PDF transit file."),
    }),
    outputSchema: s.object("Uploaded media details.", {
      media_id: mediaIdSchema,
      name: s.nonEmptyString("Uploaded file name."),
    }),
  }),
  defineProviderAction(service, {
    name: "delete_media",
    description: "Delete uploaded media by ID.",
    inputSchema: s.object("The media to delete.", { id: idSchema }),
    outputSchema: recordOutputSchema,
  }),
  defineProviderAction(service, {
    name: "list_post_results",
    description: "List per-platform publishing results with optional post and platform filters.",
    inputSchema: s.object(
      "Filters for post results.",
      {
        ...paginationFields,
        post_id: s.array("Post IDs to include.", idSchema),
        platform: s.array("Platforms to include.", s.nonEmptyString("Platform name.")),
      },
      { optional: ["offset", "limit", "post_id", "platform"] },
    ),
    outputSchema: paginationOutputSchema,
  }),
  defineProviderAction(service, {
    name: "get_post_result",
    description: "Get a per-platform publishing result by ID.",
    inputSchema: s.object("The post result to retrieve.", { id: idSchema }),
    outputSchema: recordOutputSchema,
  }),
  defineProviderAction(service, {
    name: "list_analytics",
    description: "List post analytics with optional platform, result, and timeframe filters.",
    inputSchema: s.object(
      "Filters for post analytics.",
      {
        ...paginationFields,
        platform: s.nonEmptyString("Platform name."),
        post_result_id: s.array("Post-result IDs to include.", idSchema),
        timeframe: s.stringEnum("Analytics timeframe.", ["7d", "30d", "90d", "all"]),
      },
      { optional: ["offset", "limit", "platform", "post_result_id", "timeframe"] },
    ),
    outputSchema: paginationOutputSchema,
  }),
  defineProviderAction(service, {
    name: "get_analytics",
    description: "Get one analytics record by ID.",
    inputSchema: s.object("The analytics record to retrieve.", { id: idSchema }),
    outputSchema: recordOutputSchema,
  }),
  defineProviderAction(service, {
    name: "get_daily_analytics",
    description: "Get daily analytics snapshots and per-day deltas for one analytics record.",
    inputSchema: s.object("The analytics record to retrieve.", { id: idSchema }),
    outputSchema: recordOutputSchema,
  }),
  defineProviderAction(service, {
    name: "sync_analytics",
    description: "Start an analytics refresh for all supported accounts or one platform.",
    inputSchema: s.object(
      "Analytics sync options.",
      { platform: s.stringEnum("Platform to refresh.", ["tiktok", "youtube", "instagram"]) },
      { optional: ["platform"] },
    ),
    outputSchema: recordOutputSchema,
  }),
];
