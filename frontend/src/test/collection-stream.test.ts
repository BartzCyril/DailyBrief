import { test, expect, vi, afterEach } from "vitest";
import type { CollectionEvent, CollectionProgress } from "@dailybrief/shared";
import { streamCollection } from "../dashboard/collection-stream";

afterEach(() => vi.unstubAllGlobals());
const progress: CollectionProgress = {
  stage: "ai",
  status: "running",
  message: "Envoi à l'IA : Bibliothèques",
  at: "2026-10-06T08:00:00Z",
  completed: 0,
  total: 10,
};
const result = {
  status: "SENT" as const,
  sourcesProcessed: 1,
  sourcesFailed: 0,
  articlesCollected: 10,
  newArticles: 10,
  articlesSummarized: 10,
  emailSent: true,
};
function response(events: CollectionEvent[], close = true) {
  const bytes = new TextEncoder().encode(
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        // Split in the middle of every UTF-8 sequence and JSON record.
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        if (close) controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson" } },
  );
}
test("decodes fragmented UTF-8 progress and returns the final result", async () => {
  const mock = vi.fn(async () =>
    response([
      { type: "progress", progress },
      { type: "result", result },
    ]),
  );
  vi.stubGlobal("fetch", mock);
  const observed = vi.fn();
  expect(await streamCollection(observed)).toEqual(result);
  expect(observed).toHaveBeenCalledWith(progress);
  expect(mock).toHaveBeenCalledWith(
    "/api/collection/run",
    expect.objectContaining({
      credentials: "include",
      headers: expect.objectContaining({ Accept: "application/x-ndjson" }),
    }),
  );
});
test("shows progress while the stream is still open", async () => {
  let controller!: ReadableStreamDefaultController;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              controller = c;
            },
          }),
          { headers: { "Content-Type": "application/x-ndjson" } },
        ),
    ),
  );
  const observed = vi.fn();
  let finished = false;
  const task = streamCollection(observed).then((value) => {
    finished = true;
    return value;
  });
  await vi.waitFor(() => expect(controller).toBeDefined());
  controller.enqueue(
    new TextEncoder().encode(JSON.stringify({ type: "progress", progress }) + "\n\n"),
  );
  await vi.waitFor(() => expect(observed).toHaveBeenCalledWith(progress));
  expect(finished).toBe(false);
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "result", result })));
  controller.close();
  expect(await task).toEqual(result);
});
test("surfaces stream errors and does not silently retry a possibly running collection", async () => {
  const mock = vi.fn(async () =>
    response([
      { type: "error", message: "Une collecte est déjà en cours.", code: "COLLECTION_BUSY" },
    ]),
  );
  vi.stubGlobal("fetch", mock);
  await expect(streamCollection(() => {})).rejects.toMatchObject({
    code: "COLLECTION_BUSY",
    message: "Une collecte est déjà en cours.",
  });
  expect(mock).toHaveBeenCalledTimes(1);
  mock.mockImplementation(async () => response([{ type: "progress", progress }]));
  await expect(streamCollection(() => {})).rejects.toThrow("La collecte peut continuer");
  expect(mock).toHaveBeenCalledTimes(2);
});
test("expired sessions still clear authentication when requesting a stream", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(JSON.stringify({ message: "Session expirée." }), { status: 401 }),
    ),
  );
  const expired = vi.fn();
  window.addEventListener("dailybrief:unauthenticated", expired);
  try {
    await expect(streamCollection(() => {})).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("dailybrief:unauthenticated", expired);
  }
});
