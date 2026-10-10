import type { Dashboard, Source, SourcePage } from "@dailybrief/shared";
/** Simulates the paginated API, not browser-side list processing. */
export function sourcePageFixture(sources: Source[], url: string): SourcePage {
  const params = new URL(url, "http://localhost").searchParams;
  const type = params.get("type");
  const status = params.get("status") ?? "all";
  const query = (params.get("q") ?? "").trim().toLowerCase();
  const filtered = sources.filter(
    (source) =>
      (!type || source.type === type) &&
      (status === "all" || source.enabled === (status === "active")) &&
      source.url.toLowerCase().includes(query),
  );
  const total = filtered.length;
  const page = Math.min(Number(params.get("page") ?? 1), Math.max(1, Math.ceil(total / 5)));
  return { sources: filtered.slice((page - 1) * 5, page * 5), total, page, pageSize: 5 };
}
export const emptyDashboard: Dashboard = {
  sources: { total: 0, rss: 0, scraping: 0, enabled: 0 },
  collection: {
    enabled: false,
    time: "07:30",
    timezone: "Europe/Paris",
    lastRunAt: null,
    nextRunAt: null,
  },
};
