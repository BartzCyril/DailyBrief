import { Puppeteer } from "puppeteer";

const handlerName = "dailybriefjournalvisible";

if (!Puppeteer.customQueryHandlerNames().includes(handlerName))
  Puppeteer.registerCustomQueryHandler(handlerName, {
    queryAll(root, selector) {
      if (!(
        root instanceof Element ||
        root instanceof Document ||
        root instanceof DocumentFragment
      ))
        return [];
      return [...root.querySelectorAll(selector)].filter((element) => {
        if (!element.isConnected) return false;
        const rectangle = element.getBoundingClientRect();
        if (!rectangle.width || !rectangle.height) return false;
        let ancestor: Element | null = element;
        while (ancestor) {
          const style = getComputedStyle(ancestor);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            style.opacity === "0" ||
            ancestor.hasAttribute("hidden") ||
            ancestor.hasAttribute("inert")
          )
            return false;
          ancestor = ancestor.parentElement;
        }
        return true;
      });
    },
  });

/** Re-resolve the visible CSS matches after hydration, using Puppeteer's isolated query handler. */
export function visibleJournalSelector(selector: string): string {
  return `${handlerName}/${selector}`;
}
