import { test, expect, beforeAll, afterAll } from "bun:test";
import { createServer, get, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { gzipSync, deflateSync, brotliCompressSync, zstdCompressSync } from "node:zlib";
import { readRemoteResponse, MAX_REMOTE_BYTES } from "../src/remote-response";
import { parseRss } from "../src/rss";

const xml = readFileSync(new URL("./fixtures/vie-publique.xml", import.meta.url));
const routes = new Map<string, { body: Buffer; headers?: IncomingHttpHeaders }>([
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
