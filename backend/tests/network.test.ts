import { test, expect, beforeAll, afterAll } from "bun:test";
import { strict as assert } from "node:assert";
import { createServer, get, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { gzipSync, deflateSync, brotliCompressSync, zstdCompressSync } from "node:zlib";
import { readRemoteResponse, MAX_REMOTE_BYTES } from "../src/remote-response";
import { parseRss } from "../src/rss";
import { browserRequestHeaders, remoteConnectionError } from "../src/network";
import { OllamaClient } from "../src/ai";
import { readConfig } from "../src/config";
import { OllamaSelectorAnalysisProvider } from "../src/selector-analysis";

const xml = readFileSync(new URL("./fixtures/vie-publique.xml", import.meta.url));
const routes = new Map<string, { body: Buffer; headers?: IncomingHttpHeaders }>([
  [
    "/html-meta-latin",
    {
      body: Buffer.from(
        '<!DOCTYPE html><html><head><meta charset="iso-8859-1"></head><body><div id="main"><article><h2><a href="/article">Données du cloud en été</a></h2></article></div></body></html>',
        "latin1",
      ),
      headers: { "content-type": "text/html" },
    },
  ],
  [
    "/html-meta-equiv",
    {
      body: Buffer.from(
        "<html><head><meta content='text/html; charset=windows-1252' http-equiv='Content-Type'></head><body>Été déjà annoncé</body></html>",
        "latin1",
      ),
      headers: { "content-type": "text/html" },
    },
  ],
  [
    "/html-meta-inert",
    {
      body: Buffer.from(
        '<html><head><!-- <meta charset="utf-8"> --><script>const text="<meta charset=\'utf-8\'>";</script><meta charset=iso-8859-1></head><body>Été annoncé</body></html>',
        "latin1",
      ),
      headers: { "content-type": "text/html" },
    },
  ],
  [
    "/html-meta-header",
    {
      body: Buffer.from(
        '<html><head><meta charset="iso-8859-1"></head><body>Été et données</body></html>',
        "utf8",
      ),
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  ],
  [
    "/html-meta-bom",
    {
      body: Buffer.from(
        '\uFEFF<html><head><meta charset="iso-8859-1"></head><body>Été et données</body></html>',
        "utf8",
      ),
      headers: { "content-type": "text/html" },
    },
  ],
  [
    "/html-meta-utf16",
    {
      body: Buffer.from(
        '<html><head><meta charset="utf-16"></head><body>Été et données</body></html>',
        "utf8",
      ),
      headers: { "content-type": "text/html" },
    },
  ],
  [
    "/xml-fake-meta",
    {
      body: Buffer.from(
        '<rss><channel><description>&lt;meta charset="iso-8859-1"&gt;</description><item><title>Été et données</title></item></channel></rss>',
        "utf8",
      ),
    },
  ],
  ["/plain", { body: xml }],
  ["/gzip", { body: gzipSync(xml), headers: { "content-encoding": "gzip" } }],
  ["/gzip-no-header", { body: gzipSync(xml) }],
  ["/gzip-identity", { body: gzipSync(xml), headers: { "content-encoding": "identity" } }],
  ["/deflate", { body: deflateSync(xml), headers: { "content-encoding": "deflate" } }],
  ["/br", { body: brotliCompressSync(xml), headers: { "content-encoding": "br" } }],
  ["/zstd", { body: zstdCompressSync(xml), headers: { "content-encoding": "zstd" } }],
  [
    "/stacked",
    { body: gzipSync(brotliCompressSync(xml)), headers: { "content-encoding": "br, gzip" } },
  ],
  ["/corrupt", { body: Buffer.from("not gzip"), headers: { "content-encoding": "gzip" } }],
  ["/truncated", { body: gzipSync(xml).subarray(0, 30), headers: { "content-encoding": "gzip" } }],
  ["/unsupported", { body: xml, headers: { "content-encoding": "unsupported" } }],
  [
    "/bomb",
    {
      body: gzipSync(Buffer.alloc(MAX_REMOTE_BYTES + 1, 97)),
      headers: { "content-encoding": "gzip" },
    },
  ],
  ["/oversized", { body: Buffer.alloc(MAX_REMOTE_BYTES + 1, 97) }],
  [
    "/latin-header",
    {
      body: Buffer.from(
        "<rss><channel><item><title>Loi été</title></item></channel></rss>",
        "latin1",
      ),
      headers: { "content-type": 'application/rss+xml; charset="ISO-8859-1"' },
    },
  ],
  [
    "/latin-declaration",
    {
      body: Buffer.from(
        '<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><item><title>Loi été</title></item></channel></rss>',
        "latin1",
      ),
    },
  ],
  [
    "/utf16-le",
    {
      body: Buffer.from(
        '\uFEFF<?xml version="1.0" encoding="utf-16"?><rss><channel><item><title>Loi été</title></item></channel></rss>',
        "utf16le",
      ),
    },
  ],
  [
    "/utf16-be",
    {
      body: Buffer.from(
        '\uFEFF<?xml version="1.0" encoding="utf-16"?><rss><channel><item><title>Loi été</title></item></channel></rss>',
        "utf16le",
      ).swap16(),
    },
  ],
  ["/invalid-text", { body: Buffer.from([0xff, 0x3c, 0x72, 0x73, 0x73]) }],
  [
    "/unsupported-charset",
    { body: xml, headers: { "content-type": "application/rss+xml; charset=unknown" } },
  ],
]);
const server = createServer((request, response) => {
  const fixture = routes.get(request.url!);
  if (!fixture) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/rss+xml", ...fixture.headers });
  // Chunk the response to exercise HTTP framing as well as decoding.
  response.write(fixture.body.subarray(0, 1));
  response.end(fixture.body.subarray(1));
});
let base = "";
beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
function read(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(
      base + path,
      { headers: { "User-Agent": "DailyBrief/1.0", "Accept-Encoding": "identity" } },
      (response) => {
        void readRemoteResponse(response).then(resolve, reject);
      },
    );
    request.on("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("Test request timed out")));
  });
}
test("reads real HTTP gzip, Brotli, deflate, zstd and stacked encodings before RSS parsing", async () => {
  for (const path of ["/plain", "/gzip", "/deflate", "/br", "/zstd", "/stacked"]) {
    const decoded = await read(path);
    expect(decoded).toBe(xml.toString("utf8"));
    expect(
      parseRss(decoded, "https://www.vie-publique.fr/lois-feeds.xml").articles[0]?.url,
    ).not.toBeNull();
  }
});
test("handles caches that send gzip despite identity negotiation or omit its header", async () => {
  expect(gzipSync(xml)[0]).toBe(0x1f);
  for (const path of ["/gzip-no-header", "/gzip-identity"])
    expect(
      parseRss(await read(path), "https://www.vie-publique.fr/lois-feeds.xml").articles,
    ).toHaveLength(2);
});
test("rejects corrupt and truncated compression with an HTTP decoding error", async () => {
  for (const path of ["/corrupt", "/truncated"])
    await expect(read(path)).rejects.toMatchObject({ code: "DECOMPRESSION_FAILED" });
  await expect(read("/unsupported")).rejects.toMatchObject({
    code: "UNSUPPORTED_CONTENT_ENCODING",
  });
});
test("enforces the 2 MiB limit on wire bytes and decompressed output", async () => {
  for (const path of ["/oversized", "/bomb"])
    await expect(read(path)).rejects.toMatchObject({ status: 413, code: "RESPONSE_TOO_LARGE" });
});
test("honors HTTP charset, XML declarations and UTF-16 BOMs", async () => {
  for (const path of ["/latin-header", "/latin-declaration", "/utf16-le", "/utf16-be"])
    expect(parseRss(await read(path), "https://example.com/feed").articles[0]?.title).toBe(
      "Loi été",
    );
  await expect(read("/invalid-text")).rejects.toMatchObject({ code: "INVALID_TEXT_ENCODING" });
  await expect(read("/unsupported-charset")).rejects.toMatchObject({
    code: "UNSUPPORTED_TEXT_ENCODING",
  });
});

test("legacy HTML reaches Chromium and selector AI with decoded titles and valid article links", async () => {
  const config = readConfig({
    DATABASE_URL: "postgresql://localhost/test",
    SESSION_SECRET: "x".repeat(32),
  });
  let calls = 0;
  const client = new OllamaClient(config, async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body)) as { prompt: string };
    expect(request.prompt).toContain("Données du cloud en été");
    expect(request.prompt).toContain('"id":"main"');
    return new Response(
      JSON.stringify({
        done: true,
        response: JSON.stringify({
          articleSelector: "article",
          titleSelector: "h2",
          linkSelector: "h2 a",
          mode: "SCROLL",
          scroll: { maxScrolls: 0, waitAfterScrollMs: 800 },
        }),
      }),
    );
  });
  const service = new OllamaSelectorAnalysisProvider(config, {
    client,
    fetchPage: async () => ({
      text: await read("/html-meta-latin"),
      contentType: "text/html",
      status: 200,
      cookies: [],
    }),
  });
  const result = await service.analyze({ kind: "SCRAPING", url: "https://publisher.example/" });
  expect(result.complete).toBe(true);
  assert(result.kind === "SCRAPING");
  expect(result.scrapingConfig?.linkSelector).toBe("h2 a");
  expect(calls).toBe(1);
}, 45000);

test("decodes HTML meta charsets used by legacy public pages without corrupting accents", async () => {
  expect(await read("/html-meta-latin")).toContain("Données du cloud en été");
  expect(await read("/html-meta-equiv")).toContain("Été déjà annoncé");
  expect(await read("/html-meta-inert")).toContain("Été annoncé");
});

test("HTTP charset and BOM win over HTML metadata and XML content cannot declare HTML encoding", async () => {
  for (const path of ["/html-meta-header", "/html-meta-bom", "/html-meta-utf16", "/xml-fake-meta"])
    expect(await read(path)).toContain("Été et données");
});

test("browser metadata forwarding excludes credentials and transport headers", () => {
  expect(
    browserRequestHeaders({
      "Accept-Language": "fr-FR,fr;q=0.9",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "upgrade-insecure-requests": "1",
      Authorization: "Bearer private-token",
      Cookie: "session=private-cookie",
      "Proxy-Authorization": "private-proxy",
      Host: "127.0.0.1",
      Referer: "https://private.example/?token=private-token",
      Origin: "http://127.0.0.1",
      "X-Forwarded-For": "127.0.0.1",
      "Accept-Encoding": "gzip",
    }),
  ).toEqual({
    "accept-language": "fr-FR,fr;q=0.9",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "upgrade-insecure-requests": "1",
  });
});

test("safe connection diagnostics distinguish DNS, TLS and connectivity without leaking raw errors", () => {
  for (const [code, reason] of [
    ["ENOTFOUND", "DNS"],
    ["CERT_HAS_EXPIRED", "TLS"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "TLS"],
    ["ECONNREFUSED", "CONNECT"],
    ["ENETUNREACH", "CONNECT"],
    ["ECONNRESET", "RESET"],
    ["UNKNOWN", "UNKNOWN"],
  ]) {
    const failure = remoteConnectionError({
      code,
      message: "private-token",
      address: "private-address",
    });
    expect(failure).toMatchObject({ code: "NETWORK_ERROR", reason });
    expect(String(failure)).not.toContain("private-token");
    expect(String(failure)).not.toContain("private-address");
  }
});
