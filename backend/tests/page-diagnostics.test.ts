import { test, expect } from "bun:test";
import { strict as assert } from "node:assert";
import { diagnosePage } from "../scripts/diagnose-page";
import { RemoteConnectionError } from "../src/network";
import { AppError, UpstreamHttpError } from "../src/errors";

test("page diagnostics report successful public loading without returning page content or cookies", async () => {
  const result = await diagnosePage(
    "https://publisher.example/public?token=private-token",
    async () => ({
      status: 200,
      cookies: ["private-cookie"],
      text: "private-html",
      contentType: "text/html",
    }),
    async (url) => ({ url, html: "private-html" }),
  );
  expect(result.map((item) => item.success)).toEqual([true, true]);
  expect(result[0]?.httpStatus).toBe(200);
  expect(JSON.stringify(result)).not.toMatch(/private-(token|html|cookie)/);
});

test("page diagnostics distinguish a denied HTTP request from TLS and decoding failures", async () => {
  for (const error of [
    new UpstreamHttpError(403, "https://publisher.example/?token=private-token"),
    new RemoteConnectionError("TLS"),
    new AppError(502, "private-token", "INVALID_TEXT_ENCODING"),
    new Error("private-token"),
  ]) {
    const result = await diagnosePage(
      "https://publisher.example/public",
      async () => {
        throw error;
      },
      async () => {
        throw error;
      },
    );
    expect(result.every((item) => !item.success)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-token");
    if (error instanceof UpstreamHttpError) expect(result[0]?.httpStatus).toBe(403);
    if (error instanceof RemoteConnectionError) expect(result[0]?.networkReason).toBe("TLS");
    if (error instanceof AppError) expect(result[0]?.errorCode).toBe(error.code);
  }
});

test("page diagnostics reject URL credentials before any request", async () => {
  let requests = 0;
  await assert.rejects(
    diagnosePage(
      "https://user:private-password@publisher.example",
      async () => {
        requests++;
        throw new Error();
      },
      async () => {
        requests++;
        throw new Error();
      },
    ),
    { code: "UNSAFE_URL" },
  );
  expect(requests).toBe(0);
});
