import { describe, expect, it } from "vitest";
import { postBridgeActionHandlers, validatePostBridgeCredential } from "./runtime.ts";

describe("Post Bridge runtime", () => {
  it("validates an API key with the social-accounts endpoint", async () => {
    const result = await validatePostBridgeCredential("post-bridge-key", async (url, init) => {
      expect(url.toString()).toBe("https://api.post-bridge.com/v1/social-accounts?limit=1");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer post-bridge-key");
      return Response.json({ data: [{ id: 1 }] });
    });

    expect(result).toEqual({
      profile: { accountId: "post_bridge", displayName: "Post Bridge API Key", grantedScopes: [] },
      grantedScopes: [],
      metadata: { validationEndpoint: "/v1/social-accounts", connectedAccountCount: 1 },
    });
  });

  it("encodes repeated post filters as repeated query parameters", async () => {
    await postBridgeActionHandlers.list_posts!(
      { offset: 4, limit: 2, platform: ["instagram", "tiktok"], status: ["scheduled"] },
      {
        apiKey: "post-bridge-key",
        fetcher: async (url, init) => {
          expect(url.toString()).toBe(
            "https://api.post-bridge.com/v1/posts?offset=4&limit=2&platform=instagram&platform=tiktok&status=scheduled",
          );
          expect(init?.method).toBe("GET");
          return Response.json({ data: [], meta: { total: 0, offset: 4, limit: 2, next: null } });
        },
      },
    );
  });

  it("does not send the local post ID in an update body", async () => {
    await postBridgeActionHandlers.update_post!(
      { id: "post_123", caption: "Updated post", media_urls: ["https://cdn.example.com/photo.jpg"] },
      {
        apiKey: "post-bridge-key",
        fetcher: async (url, init) => {
          expect(url.toString()).toBe("https://api.post-bridge.com/v1/posts/post_123");
          expect(init?.method).toBe("PATCH");
          expect(JSON.parse(String(init?.body))).toEqual({
            caption: "Updated post",
            media_urls: ["https://cdn.example.com/photo.jpg"],
          });
          return Response.json({ id: "post_123" });
        },
      },
    );
  });

  it("uploads a transit file through the documented signed upload URL", async () => {
    const file = new File(["image bytes"], "photo.jpg", { type: "image/jpeg" });
    const output = await postBridgeActionHandlers.upload_media!(
      { file: { fileId: "file_123" } },
      {
        apiKey: "post-bridge-key",
        transitFiles: {
          maxBytes: 1_000,
          create: async () => ({
            fileId: "unused",
            downloadUrl: "https://files.example.com/unused",
            sizeBytes: 0,
            name: "unused",
            mimeType: "application/octet-stream",
          }),
          read: async (fileId) => {
            expect(fileId).toBe("file_123");
            return { file, sizeBytes: file.size, name: file.name, mimeType: file.type };
          },
          delete: async () => false,
        },
        fetcher: async (url, init) => {
          if (url.toString() === "https://api.post-bridge.com/v1/media/create-upload-url") {
            expect(JSON.parse(String(init?.body))).toEqual({
              mime_type: "image/jpeg",
              size_bytes: file.size,
              name: "photo.jpg",
            });
            return Response.json({ media_id: "media_123", upload_url: "https://uploads.example.com/photo.jpg" });
          }
          expect(url.toString()).toBe("https://uploads.example.com/photo.jpg");
          expect(init?.method).toBe("PUT");
          expect(new Headers(init?.headers).get("content-type")).toBe("image/jpeg");
          expect(init?.body).toBe(file);
          return new Response(null, { status: 200 });
        },
      },
    );

    expect(output).toEqual({ media_id: "media_123", name: "photo.jpg" });
  });

  it("rejects private media URLs before sending a post request", async () => {
    const fetcher = async (): Promise<Response> => Response.json({ id: "post_123" });

    expect(() =>
      postBridgeActionHandlers.create_post!(
        { caption: "Unsafe media", social_accounts: [1], media_urls: ["http://127.0.0.1/private.jpg"] },
        { apiKey: "post-bridge-key", fetcher },
      ),
    ).toThrow("media_urls item must not target private or reserved IP addresses");
  });
});
