// Build the connection URL without exposing or misparsing a password containing @, / or #.
if (!process.env.DATABASE_URL) {
  const url = new URL("postgresql://postgres:5432/");
  url.username = process.env.POSTGRES_USER ?? "dailybrief";
  url.password = process.env.POSTGRES_PASSWORD ?? "";
  url.pathname = `/${process.env.POSTGRES_DB ?? "dailybrief"}`;
  process.env.DATABASE_URL = url.href;
}
if (!process.env.REDIS_URL) {
  const url = new URL("redis://redis:6379");
  url.password = process.env.REDIS_PASSWORD ?? "";
  process.env.REDIS_URL = url.href;
}
const roles: Record<string, string> = {
  api: "../src/server.ts",
  worker: "../src/worker.ts",
  migrate: "./migrate.ts",
};
const modulePath = roles[process.argv[2] ?? "api"];
if (!modulePath) throw new Error("Unknown container service role.");
await import(new URL(modulePath, import.meta.url).href);
