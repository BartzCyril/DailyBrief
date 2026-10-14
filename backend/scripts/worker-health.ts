export {};

const path = process.env.WORKER_HEALTH_FILE;
if (!path) process.exit(1);
try {
  const timestamp = Number(await Bun.file(path).text());
  const age = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || age < 0 || age > 45000) process.exit(1);
} catch {
  process.exit(1);
}
