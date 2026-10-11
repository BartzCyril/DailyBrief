import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, afterEach } from "vitest";
import { toast } from "sonner";
import { Toaster } from "../components/Toaster";
beforeEach(() => render(createElement(Toaster)));
afterEach(() => {
  toast.dismiss();
  cleanup();
});
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = Observer;
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
