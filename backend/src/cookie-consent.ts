import type { Frame, ElementHandle, Page } from "puppeteer";
import { delay, waitForClickTarget } from "./browser";
import { AppError } from "./errors";

export function consentPostAllowed(
  url: string,
  method: string,
  resourceType: string,
  origins: ReadonlySet<string>,
): boolean {
  return (
    method === "POST" &&
    ["xhr", "fetch", "document"].includes(resourceType.toLowerCase()) &&
    origins.has(new URL(url).origin)
  );
}

/** Click the user's chosen consent button, including in a public CMP iframe. */
export async function dismissCookieConsent(
  page: Page,
  selector?: string | null,
  options: {
    waitForAppearance?: boolean;
    onAction?: (origins: ReadonlySet<string>) => void;
    reload?: () => Promise<void>;
  } = {},
): Promise<boolean> {
  if (!selector) return false;
  try {
    await page.evaluate((selector) => document.querySelectorAll(selector).length, selector);
  } catch {
    throw new AppError(
      422,
      "Le sélecteur du bouton de cookies n'est pas un sélecteur CSS valide.",
      "INVALID_COOKIE_CONSENT_SELECTOR",
    );
  }
  const find = async () => {
    const matches: { frame: Frame; button: ElementHandle<Element> }[] = [];
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      if (frame !== page.mainFrame()) {
        const element = await frame.frameElement();
        try {
          if (!element || !(await element.isVisible())) continue;
        } finally {
          await element?.dispose();
        }
      }
      for (const button of await frame.$$(selector)) {
        if (await button.isVisible()) matches.push({ frame, button });
        else await button.dispose();
      }
    }
    return matches;
  };
  let matches = await find();
  const appearanceDeadline = Date.now() + (options.waitForAppearance ? 2000 : 0);
  while (!matches.length && Date.now() < appearanceDeadline) {
    await delay(100);
    matches = await find();
  }
  if (!matches.length) return false; // The choice may already have been stored in this context.
  if (matches.length !== 1) {
    await Promise.all(matches.map(({ button }) => button.dispose()));
    throw new AppError(
      422,
      "Plusieurs boutons correspondent au sélecteur de cookies. Choisissez un sélecteur plus précis.",
      "INVALID_COOKIE_CONSENT_SELECTOR",
    );
  }
  const { frame, button } = matches[0]!;
  if (
    !(await button.evaluate((element) =>
      element.matches(
        'button, input[type="button"], input[type="submit"], [role="button"], a[href]',
      ),
    ))
  )
    throw new AppError(
      422,
      "Le sélecteur de cookies doit désigner un bouton ou un lien cliquable.",
      "INVALID_COOKIE_CONSENT_SELECTOR",
    );
  const origins = new Set([new URL(page.url()).origin]);
  if (/^https?:/.test(frame.url())) origins.add(new URL(frame.url()).origin);
  let actionActive = true;
  try {
    options.onAction?.(origins);
    await waitForClickTarget(button, 5000);
    try {
      await button.asLocator().setTimeout(5000).click();
    } catch (error) {
      if (!frame.isDetached()) throw error;
    }
    // Keep this browser context: the click can persist consent through an AJAX
    // response (including Set-Cookie) before the popup changes its appearance.
    try {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 });
    } catch {
      throw new AppError(
        422,
        "Les appels réseau après le clic sur le bouton de cookies ne se sont pas terminés. La page n'a pas été rechargée.",
        "COOKIE_CONSENT_FAILED",
      );
    }
    options.onAction?.(new Set());
    actionActive = false;
    if (options.reload) await options.reload();
    else
      await Promise.all([
        page.reload({ waitUntil: "load", timeout: 15000 }),
        page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }),
      ]);
    // Re-query after navigation: the original button handle belongs to the old
    // document. Give a delayed CMP the same appearance window as on first load.
    await delay(2000);
    const remaining = await find();
    const visible = remaining.length > 0;
    await Promise.all(remaining.map(({ button }) => button.dispose()));
    if (visible)
      throw new AppError(
        422,
        "La popup de cookies est toujours visible après le clic et le rechargement. Le consentement n'a pas été mémorisé ou appliqué. Vérifiez le bouton choisi et les appels réseau de consentement.",
        "COOKIE_CONSENT_FAILED",
      );
    return true;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      422,
      "Impossible de cliquer sur le bouton de cookies ou de recharger la page. Vérifiez le sélecteur et la popup.",
      "COOKIE_CONSENT_FAILED",
    );
  } finally {
    if (actionActive) options.onAction?.(new Set());
    await button.dispose().catch(() => {});
  }
}
