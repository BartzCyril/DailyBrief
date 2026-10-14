import { PuppeteerExtra } from "puppeteer-extra";
import type { Page } from "puppeteer";

type Plugin = Parameters<PuppeteerExtra["use"]>[0];

/** Older extra plugins can observe a target before Puppeteer finishes its frame tree. */
export class PageReadyPuppeteerExtra extends PuppeteerExtra {
  private wrappedPlugins = new WeakSet<Plugin>();
  private frameReadiness = new WeakMap<Page, Promise<boolean>>();
  private pageHooks = new WeakMap<Page, Promise<void>[]>();

  override use(plugin: Plugin): this {
    if (!this.wrappedPlugins.has(plugin) && typeof plugin.onPageCreated === "function") {
      const hook = plugin.onPageCreated;
      const lifecycle = this;
      plugin.onPageCreated = function (page: Page) {
        return lifecycle.initializePage(page, () => hook.call(this, page));
      };
      this.wrappedPlugins.add(plugin);
    }
    // Dependency plugins also go through use(), before extra binds their hooks.
    return super.use(plugin);
  }

  private frameReady(page: Page): Promise<boolean> {
    const existing = this.frameReadiness.get(page);
    if (existing) return existing;
    const readiness = (async () => {
      const timeout = page.getDefaultTimeout();
      const deadline = Date.now() + (timeout > 0 && Number.isFinite(timeout) ? timeout : 30000);
      while (!page.isClosed() && page.browser().connected) {
        try {
          page.mainFrame();
          return true;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Requesting main frame too early!")
            throw error;
        }
        if (Date.now() >= deadline) throw new Error("Browser page frame initialization timed out.");
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      return false;
    })();
    this.frameReadiness.set(page, readiness);
    return readiness;
  }

  private initializePage(page: Page, hook: () => Promise<void>): Promise<void> {
    const initialization = (async () => {
      if (!(await this.frameReady(page))) return;
      try {
        await hook();
      } catch (error) {
        // A target closed during setup needs no more injections. Live-page
        // failures still reject and are propagated to the page creator.
        if (!page.isClosed() && page.browser().connected) throw error;
      }
    })();
    const hooks = this.pageHooks.get(page) ?? [];
    hooks.push(initialization);
    this.pageHooks.set(page, hooks);
    // The creator awaits this below; prevent a rejection going unobserved
    // while Puppeteer is still returning the newly created page.
    void initialization.catch(() => {});
    return initialization;
  }

  async waitForPagePlugins(page: Page): Promise<void> {
    // Allow target-created callbacks awaiting target.page() to enqueue hooks.
    await Promise.resolve();
    const hooks = this.pageHooks.get(page) ?? [];
    for (let index = 0; index < hooks.length; index++) await hooks[index];
    if (page.isClosed() || !page.browser().connected)
      throw new Error("Browser page closed during initialization.");
  }
}
