import { test, expect, vi } from "vitest";
import { dashboardApi } from "../dashboard/api";
import { emptyDashboard } from "./fixtures";

test("leaving the dashboard cancels detection before it can write settings from an obsolete request", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  const pending = dashboardApi.get(controller.signal);
  controller.abort();
  finish(new Response(JSON.stringify(emptyDashboard)));
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
