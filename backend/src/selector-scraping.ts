import type { ScrapingConfig } from "@dailybrief/shared";
import { articleUrl } from "./rss";

const paginationLandmark = '[class*="pagin" i], [id*="pagin" i], [aria-label*="page" i]';
const moreText =
  /charger\s+(?:plus|la suite)|voir\s+plus|afficher\s+(?:plus|la suite)|load\s+more|more\s+(?:articles|posts|news)/i;
export function isHidden(element: Element): boolean {
  if (element.closest('[hidden], [aria-hidden="true"], [data-dailybrief-hidden], template'))
    return true;
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement)
    if (
      /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(ancestor.getAttribute("style") ?? "")
    )
      return true;
  return false;
}
export function samePaginationUrl(first: string, second: string): boolean {
  const normalize = (value: string) => {
    const url = new URL(value);
    url.hash = "";
    url.searchParams.sort();
    return url.href;
  };
  return normalize(first) === normalize(second);
}

/** Prioritize navigation at the end of large article lists in the bounded AI snapshot. */
export function scrapingControlRoots(document: Document): Element[] {
  return [
    ...document.querySelectorAll(
      `${paginationLandmark}, a[rel~="next"], button, a[role="button"], input[type="button"]`,
    ),
  ]
    .filter(
      (element) =>
        !isHidden(element) &&
        (element.matches(`${paginationLandmark}, a[rel~="next"]`) ||
          moreText.test(
            `${element.textContent} ${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("value") ?? ""}`,
          )),
    )
    .filter(
      (element, _index, elements) =>
        !elements.some((parent) => parent !== element && parent.contains(element)),
    )
    .slice(0, 6);
}

/** Infer only a one-page increment actually represented by a public navigation link. */
export function discoverPagination(
  document: Document,
  url: string,
  articleSelector?: string,
): ScrapingConfig["pagination"] {
  const current = new URL(url);
  const numbered = [...document.querySelectorAll("a[href]")].filter(
    (anchor) =>
      !isHidden(anchor) &&
      !anchor.closest(articleSelector ?? "article") &&
      /^\d+$/.test(anchor.textContent?.trim() ?? ""),
  );
  const anchors = [...document.querySelectorAll("a[href]")].filter(
    (anchor) =>
      !isHidden(anchor) &&
      !anchor.closest(articleSelector ?? "article") &&
      (anchor.closest(paginationLandmark) ||
        anchor.getAttribute("rel")?.split(/\s+/).includes("next") ||
        (numbered.length >= 2 && numbered.includes(anchor))),
  );
  const selected = document.querySelector(
    `:is(${paginationLandmark}) [aria-current="page"], :is(${paginationLandmark}) .selected, :is(${paginationLandmark}) .active`,
  );
  const selectedText = selected?.textContent?.trim() ?? "";
  const selectedNumber = /^\d+$/.test(selectedText) ? Number(selectedText) : undefined;
  const hrefs = anchors
    .map((anchor) => articleUrl(anchor.getAttribute("href")!, url))
    .filter((href): href is string => !!href);
  const discoveries = new Map<string, NonNullable<ScrapingConfig["pagination"]>>();
  for (const href of hrefs) {
    const next = new URL(href);
    if (next.origin !== current.origin || samePaginationUrl(next.href, current.href)) continue;
    if (next.pathname === current.pathname) {
      for (const [name, value] of next.searchParams) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(name) || !/^\d{1,5}$/.test(value)) continue;
        const target = Number(value);
        const rawStart = current.searchParams.get(name);
        const start =
          rawStart && /^\d+$/.test(rawStart)
            ? Number(rawStart)
            : (selectedNumber ?? (target === 2 ? 1 : target === 1 ? 0 : undefined));
        if (start === undefined || target !== start + 1 || start > 10000) continue;
        const expected = new URL(current);
        expected.searchParams.set(name, value);
        if (!samePaginationUrl(expected.href, next.href)) continue;
        const pagination = { strategy: "QUERY_PARAM" as const, queryParam: name, startPage: start };
        discoveries.set(JSON.stringify(pagination), pagination);
      }
    } else if (next.search === current.search) {
      for (const match of next.pathname.matchAll(/\d+/g)) {
        const prefix = next.pathname.slice(0, match.index);
        const suffix = next.pathname.slice(match.index + match[0].length);
        const middle =
          current.pathname.startsWith(prefix) && current.pathname.endsWith(suffix)
            ? current.pathname.slice(prefix.length, suffix ? -suffix.length : undefined)
            : "";
        const target = Number(match[0]);
        const start = /^\d+$/.test(middle)
          ? Number(middle)
          : (selectedNumber ?? (target === 2 ? 1 : undefined));
        if (start === undefined || target !== start + 1 || start > 10000) continue;
        const template = `${current.origin}${prefix}{page}${suffix}`;
        // Never copy arbitrary query values into a reusable configuration.
        if (current.search) continue;
        const first = template.replace("{page}", String(start));
        if (
          !samePaginationUrl(first, current.href) &&
          !hrefs.some((link) => samePaginationUrl(link, first))
        )
          continue;
        const pagination = {
          strategy: "URL_TEMPLATE" as const,
          urlTemplate: template,
          startPage: start,
        };
        discoveries.set(JSON.stringify(pagination), pagination);
      }
    }
  }
  // Conflicting controls need human review rather than an arbitrary choice.
  return discoveries.size === 1 ? [...discoveries.values()][0] : undefined;
}

export function discoverLoadMore(document: Document, articleSelector: string): string | undefined {
  const buttons = [
    ...document.querySelectorAll('button, a[href], input[type="button"], [role="button"]'),
  ].filter(
    (element) =>
      !isHidden(element) &&
      !element.closest(articleSelector) &&
      !element.closest("nav, header, footer, form") &&
      !element.matches(':disabled, [aria-disabled="true"]') &&
      moreText.test(
        `${element.textContent} ${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("value") ?? ""}`,
      ),
  );
  if (buttons.length !== 1) return;
  const button = buttons[0]!;
  const id = button.id;
  const classes = [...button.classList];
  const options = [
    ...(id && /^[a-zA-Z_][\w-]*$/.test(id) ? [`#${id}`] : []),
    ...classes.filter((name) => /^[a-zA-Z_][\w-]*$/.test(name)).map((name) => `.${name}`),
    button.tagName.toLowerCase(),
  ];
  for (const selector of options)
    if (document.querySelectorAll(selector).length === 1) return selector;
  const path: string[] = [];
  for (
    let element: Element | null = button;
    element && path.length < 8;
    element = element.parentElement
  ) {
    const siblings = [...(element.parentElement?.children ?? [])].filter(
      (sibling) => sibling.tagName === element!.tagName,
    );
    path.unshift(`${element.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(element) + 1})`);
    const selector = path.join(" > ");
    if (selector.length <= 200 && document.querySelectorAll(selector).length === 1) return selector;
  }
}

/** Missing model fields can be recovered from unambiguous elements on the actual page. */
export function discoverArticleField(blocks: Element[], selectors: string[]): string | undefined {
  return selectors.find((selector) => {
    let observed = false;
    for (const block of blocks) {
      const matches = [...block.querySelectorAll(selector)];
      if (!matches.length) continue;
      if (
        matches.length !== 1 ||
        isHidden(matches[0]!) ||
        !(matches[0]!.textContent?.trim() || matches[0]!.getAttribute("datetime")?.trim())
      )
        return false;
      observed = true;
    }
    return observed;
  });
}

export function hasPublicationDate(element: Element): boolean {
  const datetime = element.getAttribute("datetime")?.trim();
  if (datetime) return !Number.isNaN(Date.parse(datetime));
  const text = element.textContent?.trim() ?? "";
  return (
    /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b|\b\d{1,2}(?:er)?\s+(?:janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(?:il y a|ago|aujourd'hui|hier)\b/i.test(
      text,
    ) ||
    (!Number.isNaN(Date.parse(text)) && /\b\d{4}\b/.test(text))
  );
}
