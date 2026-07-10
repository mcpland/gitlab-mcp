import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server
} from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { fetchDownloadWithSafeRedirects } from "../src/lib/safe-redirect-fetch.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe("fetchDownloadWithSafeRedirects", () => {
  it("strips credentials permanently after a cross-origin redirect", async () => {
    const targetHeaders: Headers[] = [];
    const target = await listen((req, res) => {
      targetHeaders.push(toHeaders(req.headers));
      if (req.url === "/hop") {
        res.statusCode = 302;
        res.setHeader("Location", "/asset");
        res.end();
        return;
      }
      res.statusCode = 200;
      res.end("redirected-download");
    });
    let sourceHeaders: Headers | undefined;
    const source = await listen((req, res) => {
      sourceHeaders = toHeaders(req.headers);
      res.statusCode = 302;
      res.setHeader("Location", `${target.origin}/hop`);
      res.end();
    });

    const response = await fetchDownloadWithSafeRedirects(new URL(`${source.origin}/download`), {
      method: "GET",
      headers: {
        Authorization: "Bearer oauth-secret",
        "PRIVATE-TOKEN": "pat-secret",
        "JOB-TOKEN": "job-secret",
        Cookie: "_gitlab_session=cookie-secret",
        "X-Request-Id": "safe-metadata"
      }
    });

    expect(await response.text()).toBe("redirected-download");
    expect(sourceHeaders?.get("authorization")).toBe("Bearer oauth-secret");
    expect(sourceHeaders?.get("private-token")).toBe("pat-secret");
    expect(sourceHeaders?.get("job-token")).toBe("job-secret");
    expect(sourceHeaders?.get("cookie")).toBe("_gitlab_session=cookie-secret");
    expect(targetHeaders).toHaveLength(2);
    for (const headers of targetHeaders) {
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("private-token")).toBeNull();
      expect(headers.get("job-token")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-request-id")).toBe("safe-metadata");
    }
  });

  it("preserves credentials across same-origin redirects", async () => {
    let assetHeaders: Headers | undefined;
    const server = await listen((req, res) => {
      if (req.url === "/start") {
        res.statusCode = 307;
        res.setHeader("Location", "/asset");
        res.end();
        return;
      }
      assetHeaders = toHeaders(req.headers);
      res.statusCode = 200;
      res.end("same-origin-download");
    });

    const response = await fetchDownloadWithSafeRedirects(new URL(`${server.origin}/start`), {
      method: "GET",
      headers: {
        Authorization: "Bearer oauth-secret",
        "PRIVATE-TOKEN": "pat-secret",
        "JOB-TOKEN": "job-secret",
        Cookie: "_gitlab_session=cookie-secret"
      }
    });

    expect(await response.text()).toBe("same-origin-download");
    expect(assetHeaders?.get("authorization")).toBe("Bearer oauth-secret");
    expect(assetHeaders?.get("private-token")).toBe("pat-secret");
    expect(assetHeaders?.get("job-token")).toBe("job-secret");
    expect(assetHeaders?.get("cookie")).toBe("_gitlab_session=cookie-secret");
  });

  it("fails on redirect loops, unsafe protocols, and more than five redirects", async () => {
    let redirectRequests = 0;
    const server = await listen((req, res) => {
      if (req.url === "/loop-a") {
        res.statusCode = 302;
        res.setHeader("Location", "/loop-b");
      } else if (req.url === "/loop-b") {
        res.statusCode = 302;
        res.setHeader("Location", "/loop-a");
      } else if (req.url === "/unsafe") {
        res.statusCode = 302;
        res.setHeader("Location", "file:///tmp/secret");
      } else {
        redirectRequests += 1;
        const hop = Number.parseInt(req.url?.split("/").pop() ?? "0", 10);
        res.statusCode = 302;
        res.setHeader("Location", `/limit/${String(hop + 1)}`);
      }
      res.end();
    });

    await expect(
      fetchDownloadWithSafeRedirects(new URL(`${server.origin}/loop-a`), { method: "GET" })
    ).rejects.toThrow("loop");
    await expect(
      fetchDownloadWithSafeRedirects(new URL(`${server.origin}/unsafe`), { method: "GET" })
    ).rejects.toThrow("HTTP or HTTPS");
    await expect(
      fetchDownloadWithSafeRedirects(new URL(`${server.origin}/limit/0`), { method: "GET" })
    ).rejects.toThrow("maximum of 5 redirects");
    expect(redirectRequests).toBe(6);
  });
});

async function listen(handler: RequestListener): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unexpected test server address");
  }
  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
}

function toHeaders(headers: IncomingHttpHeaders): Headers {
  const normalized = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalized.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  return normalized;
}
