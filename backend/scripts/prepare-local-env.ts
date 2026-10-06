import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const path = new URL("../../.env", import.meta.url);
let content = await readFile(path, "utf8").catch(async (error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error;
  return readFile(new URL("../../.env.example", import.meta.url), "utf8");
});
function configured(name: string): boolean {
  const value = content
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .trim();
  return Boolean(process.env[name] || value?.replace(/^(["'])(.*)\1$/, "$2"));
}
function addDefault(name: string, value: string) {
  if (configured(name)) return;
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  content = pattern.test(content) ? content.replace(pattern, line) : `${content}\n${line}\n`;
}
addDefault("SESSION_SECRET", randomBytes(32).toString("hex"));
if (process.argv[2]) addDefault("CHROMIUM_EXECUTABLE_PATH", process.argv[2]);
await writeFile(path, content, { mode: 0o600 });
console.info("Local environment prepared; existing values preserved.");
