import { readFile, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const path = new URL("../.env.production", import.meta.url);
let content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error;
  return readFile(new URL("../.env.production.example", import.meta.url), "utf8");
});
function set(name: string, value: string, onlyIfMissing = false) {
  const pattern = new RegExp(`^${name}=.*$`, "m");
  const previous = content
    .match(pattern)?.[0]
    .slice(name.length + 1)
    .trim();
  if (onlyIfMissing && previous && previous !== '""' && previous !== "''") return;
  const line = `${name}=${value}`;
  content = pattern.test(content) ? content.replace(pattern, line) : `${content}\n${line}\n`;
}
if (process.argv[2]) {
  const origin = new URL(process.argv[2]);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Use an HTTPS origin, for example https://brief.example.com.");
  set("APP_DOMAIN", origin.hostname);
  set("APP_ORIGIN", origin.origin);
}
for (const name of [
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "SESSION_SECRET",
  "JOURNAL_ENCRYPTION_KEY",
])
  set(name, randomBytes(32).toString("hex"), true);
await writeFile(path, content, { mode: 0o600 });
await chmod(path, 0o600);
console.info("Production configuration prepared; existing secrets preserved.");
