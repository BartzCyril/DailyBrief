import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { AppError, UpstreamHttpError } from "./errors";
import { readRemoteResponse } from "./remote-response";

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export async function validateRemoteUrl(
  value: string,
): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, "URL invalide.", "INVALID_URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hostname.toLowerCase() === "localhost" ||
    url.hostname.endsWith(".local")
  )
    throw new AppError(400, "Cette URL n'est pas autorisée.", "UNSAFE_URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = ipaddr.isValid(host)
      ? [{ address: host, family: ipaddr.parse(host).kind() === "ipv4" ? 4 : 6 }]
      : await lookup(host, { all: true });
  } catch {
    throw new AppError(502, "Domaine inaccessible.", "NETWORK_ERROR");
  }
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address)))
    throw new AppError(400, "Adresses privées et locales interdites.", "UNSAFE_URL");
  return { url, ...addresses[0]! };
}
export type FetchText = (url: string, options?: RemotePageOptions) => Promise<string>;
export type RemotePage = {
  url?: string;
  text: string;
  status: number;
  contentType?: string;
  location?: string;
  cookies: string[];
};
export type RemotePageOptions = {
  method?: "GET" | "POST";
  body?: string;
  contentType?: string;
  requestedWith?: string;
  referer?: string;
  userAgent?: string;
  cookie?: string;
  accept?: string;
  followRedirects?: boolean;
  allowedHostname?: string;
};
export type FetchPage = (url: string, options?: RemotePageOptions) => Promise<RemotePage>;
export const fetchRemotePage: FetchPage = async (value, options = {}) => {
  const deadline = Date.now() + 15000;
  let originalOrigin: string | undefined;
  let method = options.method ?? "GET";
  for (let redirect = 0; redirect <= 4; redirect++) {
    const target = await validateRemoteUrl(value);
    if (
      options.allowedHostname &&
      target.url.hostname.toLowerCase().replace(/\.$/, "") !== options.allowedHostname
    )
      throw new AppError(
        422,
        "L'article redirige vers un autre journal. Relancez le recensement avant de configurer cet accès.",
        "JOURNAL_REDIRECT_BLOCKED",
      );
    originalOrigin ??= target.url.origin;
    if (method === "POST" && target.url.origin !== originalOrigin)
      throw new AppError(
        400,
        "Redirection du chargement vers un autre site interdite.",
        "UNSAFE_URL",
      );
    if (Date.now() >= deadline)
      throw new AppError(504, "Le site a mis trop de temps à répondre.", "TIMEOUT");
    const response = await new Promise<RemotePage>((resolve, reject) => {
      const send = target.url.protocol === "https:" ? httpsRequest : httpRequest;
      // Pin the validated DNS result to prevent rebinding between validation and connection.
      const req = send(
        target.url,
        {
          method,
          headers: {
            "User-Agent": options.userAgent ?? "DailyBrief/1.0",
            "Accept-Encoding": "identity",
            ...(options.accept ? { Accept: options.accept } : {}),
            ...(options.referer && new URL(options.referer).origin === target.url.origin
              ? { Referer: options.referer }
              : {}),
            ...(method === "POST" ? { Origin: originalOrigin } : {}),
            ...(method === "POST" && options.contentType
              ? { "Content-Type": options.contentType }
              : {}),
            ...(options.requestedWith && target.url.origin === originalOrigin
              ? { "X-Requested-With": options.requestedWith }
              : {}),
            ...(options.cookie && target.url.origin === originalOrigin
              ? { Cookie: options.cookie }
              : {}),
          },
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, [{ address: target.address, family: target.family }]);
            else callback(null, target.address, target.family);
          },
        },
        (res) => {
          const metadata = {
            url: target.url.href,
            status: res.statusCode ?? 500,
            contentType: res.headers["content-type"],
            cookies: res.headers["set-cookie"] ?? [],
          };
          if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
            res.resume();
            resolve({ ...metadata, text: "", location: res.headers.location });
            return;
          }
          if ((res.statusCode ?? 500) >= 400) {
            res.resume();
            reject(new UpstreamHttpError(metadata.status, target.url.href));
            return;
          }
          void readRemoteResponse(res).then(
            (text) => resolve({ ...metadata, text }),
            (error: unknown) => {
              reject(error);
              req.destroy();
            },
          );
        },
      );
      const timer = setTimeout(
        () => req.destroy(new AppError(504, "Délai de récupération dépassé.", "TIMEOUT")),
        Math.max(1, deadline - Date.now()),
      );
      req.on("close", () => clearTimeout(timer));
      req.on("error", (error) =>
        reject(
          error instanceof AppError
            ? error
            : new AppError(502, "Site inaccessible.", "NETWORK_ERROR"),
        ),
      );
      req.end(method === "POST" ? options.body : undefined);
    });
    if (!response.location || options.followRedirects === false) return response;
    if (response.status === 303 || (method === "POST" && [301, 302].includes(response.status)))
      method = "GET";
    value = new URL(response.location, target.url).href;
  }
  throw new AppError(502, "Trop de redirections.", "REDIRECT_LIMIT");
};
export const fetchRemoteText: FetchText = async (url, options) =>
  (await fetchRemotePage(url, options)).text;
