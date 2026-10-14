import type { Browser, BrowserContext, Page } from "puppeteer";

/** Call on a dedicated journal browser, then clean up after that browser closes. */
export async function blockJournalAuxiliaryTargets(
  browser: Browser,
  context: BrowserContext,
  page: Page,
): Promise<() => Promise<void>> {
  const primarySession = await page.createCDPSession();
  let primaryTargetId: string;
  try {
    const { targetInfo } = await primarySession.send("Target.getTargetInfo");
    primaryTargetId = targetInfo.targetId;
  } finally {
    await primarySession.detach();
  }
  const session = await browser.target().createCDPSession();
  const attached = (event: {
    targetInfo: { targetId: string; type: string; browserContextId?: string };
  }) => {
    const { targetInfo } = event;
    if (targetInfo.targetId === primaryTargetId) return;
    // Workers do not consistently report their browser context in CDP. This
    // browser is dedicated to one journal session, so all worker targets can
    // be closed while existing pages in its default context are left alone.
    const worker = ["worker", "shared_worker", "service_worker"].includes(targetInfo.type);
    if (targetInfo.browserContextId !== context.id && !worker) return;
    void session
      .send("Target.closeTarget", { targetId: targetInfo.targetId })
      .then(({ success }) => {
        if (!success) return context.close();
      })
      .catch(() => context.close().catch(() => {}));
  };
  session.on("Target.attachedToTarget", attached);
  try {
    // Pause before page startup: closing a popup after its first navigation
    // can otherwise happen after a form POST has already reached the server.
    await session.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [
        { type: "page", exclude: false },
        { type: "worker", exclude: false },
        { type: "shared_worker", exclude: false },
        { type: "service_worker", exclude: false },
        { exclude: true },
      ],
    });
  } catch (error) {
    session.off("Target.attachedToTarget", attached);
    await session.detach().catch(() => {});
    throw error;
  }
  return async () => {
    // Detaching can release a paused target. The caller first closes the
    // dedicated browser, retaining fail-closed behavior until the session ends.
    session.off("Target.attachedToTarget", attached);
    await session.detach().catch(() => {});
  };
}

/** Keep journal requests on the tab/frames whose network traffic is guarded. */
export async function prepareJournalNativePage(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    // Worker requests and newly opened tabs do not inherit the tab's request
    // interception. This runs before site scripts, including in child frames.
    for (const name of ["Worker", "SharedWorker"] as const) {
      Object.defineProperty(window, name, {
        configurable: false,
        writable: false,
        value: class {
          constructor() {
            throw new DOMException("Journal workers are disabled", "SecurityError");
          }
        },
      });
    }
    Object.defineProperty(window, "open", {
      configurable: false,
      writable: false,
      value: () => null,
    });
    // Lock the prototype as well as the container: calling the original
    // prototype method would bypass a replacement on navigator.serviceWorker.
    if (typeof ServiceWorkerContainer !== "undefined") {
      const register = () =>
        Promise.reject(new DOMException("Journal service workers are disabled", "SecurityError"));
      Object.defineProperty(ServiceWorkerContainer.prototype, "register", {
        configurable: false,
        writable: false,
        value: register,
      });
      if (navigator.serviceWorker)
        Object.defineProperty(navigator.serviceWorker, "register", {
          configurable: false,
          writable: false,
          value: register,
        });
    }

    const safeTarget = (value: string) => {
      const target = value.trim().toLowerCase();
      return ["_self", "_top", "_parent"].includes(target) ? target : "_self";
    };
    const targetAttribute = (element: Element, name: string) => {
      const attribute = name.toLowerCase();
      if (
        attribute === "target" &&
        (element instanceof HTMLFormElement ||
          element instanceof HTMLAnchorElement ||
          element instanceof HTMLAreaElement ||
          element instanceof HTMLBaseElement)
      )
        return true;
      return (
        attribute === "formtarget" &&
        (element instanceof HTMLButtonElement || element instanceof HTMLInputElement)
      );
    };
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name: string, value: string) {
      return setAttribute.call(this, name, targetAttribute(this, name) ? safeTarget(value) : value);
    };
    const setAttributeNS = Element.prototype.setAttributeNS;
    Element.prototype.setAttributeNS = function (
      namespace: string | null,
      name: string,
      value: string,
    ) {
      return setAttributeNS.call(
        this,
        namespace,
        name,
        namespace === null && targetAttribute(this, name) ? safeTarget(value) : value,
      );
    };
    for (const [prototype, property] of [
      [HTMLFormElement.prototype, "target"],
      [HTMLAnchorElement.prototype, "target"],
      [HTMLAreaElement.prototype, "target"],
      [HTMLBaseElement.prototype, "target"],
      [HTMLButtonElement.prototype, "formTarget"],
      [HTMLInputElement.prototype, "formTarget"],
    ] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      if (descriptor?.set)
        Object.defineProperty(prototype, property, {
          ...descriptor,
          set(this: Element, value: string) {
            descriptor.set!.call(this, safeTarget(value));
          },
        });
    }
    const normalize = (element: Element) => {
      for (const name of ["target", "formtarget"]) {
        const value = element.getAttribute(name);
        if (value !== null && targetAttribute(element, name) && value !== safeTarget(value))
          setAttribute.call(element, name, safeTarget(value));
      }
    };
    const normalizeForm = (form: HTMLFormElement, submitter?: HTMLElement | null) => {
      // An omitted target can otherwise inherit <base target="_blank">.
      form.target = safeTarget(form.target);
      if (submitter) normalize(submitter);
    };
    const submit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      normalizeForm(this);
      return submit.call(this);
    };
    const requestSubmit = HTMLFormElement.prototype.requestSubmit;
    HTMLFormElement.prototype.requestSubmit = function (submitter?: HTMLElement | null) {
      normalizeForm(this, submitter);
      return submitter ? requestSubmit.call(this, submitter) : requestSubmit.call(this);
    };
    document.addEventListener(
      "submit",
      (event) => {
        if (event.target instanceof HTMLFormElement)
          normalizeForm(event.target, (event as SubmitEvent).submitter);
      },
      true,
    );
    document.addEventListener(
      "click",
      (event) => {
        for (const element of event.composedPath()) {
          if (!(element instanceof Element)) continue;
          if (element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement) {
            element.setAttribute("target", safeTarget(element.getAttribute("target") ?? ""));
            break;
          }
          normalize(element);
        }
      },
      true,
    );
    const normalizeTree = (node: Node) => {
      if (!(node instanceof Element)) return;
      normalize(node);
      node
        .querySelectorAll(
          "a[target], area[target], base[target], form[target], button[formtarget], input[formtarget]",
        )
        .forEach(normalize);
    };
    new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.type === "attributes" && change.target instanceof Element)
          normalize(change.target);
        else change.addedNodes.forEach(normalizeTree);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["target", "formtarget"],
    });
  });
}
