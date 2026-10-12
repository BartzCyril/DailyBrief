// Public browser verification endpoints. This does not solve challenges or alter fingerprints.
const verificationHosts = new Set([
  "geo.captcha-delivery.com",
  "api-js.datadome.co",
  "challenges.cloudflare.com",
]);

export function verificationPostAllowed(
  url: string,
  method: string,
  resourceType: string,
  verifying: boolean,
  sourceOrigin: string,
): boolean {
  if (!verifying || method !== "POST" || !["xhr", "fetch"].includes(resourceType.toLowerCase()))
    return false;
  const target = new URL(url);
  if (target.username || target.password) return false;
  return (
    target.origin === sourceOrigin ||
    (target.protocol === "https:" && !target.port && verificationHosts.has(target.hostname))
  );
}
