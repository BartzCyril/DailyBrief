/** Returns readiness flags only; page text and verification tokens stay in the browser. */
export function inspectJournalArticleInPage() {
  const body = document.body?.innerText;
  const ready = typeof body === "string" && body.trim().length >= 200;
  const title = document.title.replace(/\s+/g, " ").trim().toLowerCase();
  const challengeTitle = /^client challenge(?:$|\s*[-|.!…])/.test(title);
  const realArticle =
    ready &&
    [...document.querySelectorAll("article")].some((element) => {
      const text = (element as HTMLElement).innerText;
      return typeof text === "string" && text.trim().length >= 200;
    });
  return { ready, challenge: challengeTitle && !realArticle };
}

type VerificationRequest = {
  url: string;
  method: string;
  resourceType: string;
  body?: string;
  hasPostData: boolean;
  headers: Record<string, string>;
};

/** The site's own empty, credential-free PAT check; never a general POST exception. */
export function journalPatRequestAllowed(
  request: VerificationRequest,
  journalOrigin: string,
): boolean {
  const url = new URL(request.url);
  const query = [...url.searchParams];
  const credentials = Object.keys(request.headers).some((key) =>
    ["cookie", "authorization", "proxy-authorization"].includes(key.toLowerCase()),
  );
  return (
    request.method === "POST" &&
    ["fetch", "xhr"].includes(request.resourceType) &&
    !request.body &&
    !request.hasPostData &&
    !credentials &&
    url.protocol === "https:" &&
    url.origin === journalOrigin &&
    !url.username &&
    !url.password &&
    /^\/_fs-ch-[A-Za-z0-9_-]{1,128}\/pat$/.test(url.pathname) &&
    query.length === 1 &&
    query[0]?.[0] === "token" &&
    query[0][1].length > 0 &&
    query[0][1].length <= 8192
  );
}

export function journalChallengeFont(url: string, journalOrigin: string): boolean {
  const target = new URL(url);
  return (
    target.origin === journalOrigin &&
    /^\/_fs-ch-[A-Za-z0-9_-]{1,128}\/assets\/[A-Za-z0-9_.-]+\.(?:woff2?|ttf|otf)$/.test(
      target.pathname,
    )
  );
}
