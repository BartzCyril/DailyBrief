import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { AppError } from "./errors";

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}
export async function validateRemoteUrl(value: string): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError(400, "URL invalide.", "INVALID_URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hostname.toLowerCase() === "localhost" || url.hostname.endsWith(".local"))
    throw new AppError(400, "Cette URL n'est pas autorisée.", "UNSAFE_URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try { addresses = ipaddr.isValid(host) ? [{ address: host, family: ipaddr.parse(host).kind() === "ipv4" ? 4 : 6 }] : await lookup(host, { all: true }); }
  catch { throw new AppError(502, "Domaine inaccessible.", "NETWORK_ERROR"); }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new AppError(400, "Adresses privées et locales interdites.", "UNSAFE_URL");
  return { url, ...addresses[0]! };
}
export type FetchText = (url: string) => Promise<string>;
export const fetchRemoteText: FetchText = async value => {
  const deadline = Date.now() + 15000;
  for (let redirect = 0; redirect <= 4; redirect++) {
    const target = await validateRemoteUrl(value);
    if (Date.now() >= deadline) throw new AppError(504, "Le site a mis trop de temps à répondre.", "TIMEOUT");
    const response = await new Promise<{ text?: string; location?: string }>((resolve, reject) => {
      const send = target.url.protocol === "https:" ? httpsRequest : httpRequest;
      // Pin the validated DNS result to prevent rebinding between validation and connection.
      const req = send(target.url, { headers: { "User-Agent": "DailyBrief/1.0", "Accept-Encoding": "identity" }, lookup: (_host, options, callback) => {
        if (options.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      } }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) { res.resume(); resolve({ location: res.headers.location }); return; }
        if ((res.statusCode ?? 500) >= 400) { res.resume(); reject(new AppError(502, "Le site a retourné une erreur HTTP.", "UPSTREAM_ERROR")); return; }
        let size = 0; const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) { req.destroy(new AppError(413, "Réponse distante trop volumineuse.", "RESPONSE_TOO_LARGE")); } else chunks.push(chunk); });
        res.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      });
      const timer = setTimeout(() => req.destroy(new AppError(504, "Délai de récupération dépassé.", "TIMEOUT")), Math.max(1, deadline - Date.now()));
      req.on("close", () => clearTimeout(timer));
      req.on("error", error => reject(error instanceof AppError ? error : new AppError(502, "Site inaccessible.", "NETWORK_ERROR")));
      req.end();
    });
    if (response.text !== undefined) return response.text;
    value = new URL(response.location!, target.url).href;
  }
  throw new AppError(502, "Trop de redirections.", "REDIRECT_LIMIT");
};
