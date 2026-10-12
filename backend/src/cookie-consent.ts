import type { Frame, Locator, Page } from "playwright";
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
  options: { waitForAppearance?: boolean; onAction?: (origins: ReadonlySet<string>) => void } = {},
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
    const matches: { frame: Frame; button: Locator }[] = [];
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      if (frame !== page.mainFrame() && !(await (await frame.frameElement()).isVisible())) continue;
      const buttons = frame.locator(selector).filter({ visible: true });
      for (let i = 0; i < (await buttons.count()); i++)
        matches.push({ frame, button: buttons.nth(i) });
    }
    return matches;
  };
  let matches = await find();
  const appearanceDeadline = Date.now() + (options.waitForAppearance ? 2000 : 0);
  while (!matches.length && Date.now() < appearanceDeadline) {
    await page.waitForTimeout(100);
    matches = await find();
  }
  if (!matches.length) return false; // The choice may already have been stored in this context.
  if (matches.length !== 1)
    throw new AppError(
      422,
      "Plusieurs boutons correspondent au sélecteur de cookies. Choisissez un sélecteur plus précis.",
      "INVALID_COOKIE_CONSENT_SELECTOR",
    );
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  try {
    options.onAction?.(origins);
    await Promise.race([
      (async () => {
        await button.click({ timeout: 5000 });
        while (!finished && !frame.isDetached() && (await button.isVisible()))
          await page.waitForTimeout(100);
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AppError(
                422,
                "La popup de cookies n'a pas disparu après le clic. Vérifiez le bouton choisi.",
                "COOKIE_CONSENT_FAILED",
              ),
            ),
          5000,
        );
      }),
    ]);
    return true;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      422,
      "Impossible de cliquer sur le bouton de cookies. Vérifiez le sélecteur et la popup.",
      "COOKIE_CONSENT_FAILED",
    );
  } finally {
    finished = true;
    clearTimeout(timer);
    options.onAction?.(new Set());
  }
}
