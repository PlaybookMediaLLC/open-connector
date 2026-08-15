import { describe, expect, it } from "vitest";
import { postizActionHandlers, validatePostizCredential } from "./runtime.ts";

describe("Postiz runtime", () => {
  it("validates API keys with Postiz raw Authorization authentication", async () => {
    const result = await validatePostizCredential("postiz-key", async (url, init) => {
      expect(url.toString()).toBe("https://api.postiz.com/public/v1/is-connected");
      expect(new Headers(init?.headers).get("authorization")).toBe("postiz-key");
      return Response.json({ connected: true });
    });

    expect(result.profile).toEqual({ accountId: "postiz", displayName: "Postiz API Key", grantedScopes: [] });
  });

  it("rejects private media URLs before creating a post", () => {
    expect(() =>
      postizActionHandlers.create_post!(
        {
          type: "now",
          date: "2026-01-01T00:00:00Z",
          shortLink: false,
          tags: [],
          posts: [
            {
              integration: { id: "channel_1" },
              value: [{ content: "Unsafe", image: [{ id: "media_1", path: "http://127.0.0.1/image.png" }] }],
            },
          ],
        },
        { apiKey: "postiz-key", fetcher: async () => Response.json({}) },
      ),
    ).toThrow("posts image path must not target private or reserved IP addresses");
  });
});
