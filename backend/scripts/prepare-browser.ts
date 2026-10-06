import chromium from "@sparticuz/chromium";
import { copyFile, mkdir } from "node:fs/promises";
// An npm-distributed browser is useful when the Playwright CDN is unavailable.
// Copy the verified package's extracted binary to a persistent workspace cache.
const destination = process.argv[2] ?? "/workspace/.cache/dailybrief/chromium";
await mkdir(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
await copyFile(await chromium.executablePath(), destination);
console.info(`Chromium installed at ${destination}. Set CHROMIUM_EXECUTABLE_PATH to this path.`);
