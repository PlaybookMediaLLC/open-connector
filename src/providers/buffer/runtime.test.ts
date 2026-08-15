import { describe, expect, it } from "vitest";
import { bufferActionHandlers, validateBufferCredential } from "./runtime.ts";

describe("Buffer runtime", () => {
  it("validates an API key with the account query", async () => {
    const result = await validateBufferCredential("buffer-key", async (url, init) => {
      expect(url.toString()).toBe("https://api.buffer.com");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer buffer-key");
      expect(JSON.parse(String(init?.body))).toEqual({ query: "query { account { id email } }", variables: {} });
      return Response.json({ data: { account: { id: "account_1", email: "owner@example.com" } } });
    });

    expect(result.profile).toEqual({ accountId: "account_1", displayName: "owner@example.com", grantedScopes: [] });
  });

  it("rejects private Buffer asset URLs before creating a post", async () => {
    await expect(
      bufferActionHandlers.create_post!(
        {
          channelId: "channel_1",
          text: "Unsafe asset",
          schedulingType: "automatic",
          mode: "addToQueue",
          assets: [{ image: { url: "http://127.0.0.1/image.png" } }],
        },
        { apiKey: "buffer-key", fetcher: async () => Response.json({}) },
      ),
    ).rejects.toThrow("assets image url must not target private or reserved IP addresses");
  });
});
