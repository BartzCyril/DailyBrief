import { createServer, connect, type Socket } from "node:net";
import type { LaunchOptions, Page } from "puppeteer";
import { setRequestGuard } from "./browser";
import { AppError } from "./errors";
import { validateRemoteUrl, remoteConnectionError, RemoteConnectionError } from "./network";
import { MAX_REMOTE_BYTES } from "./remote-response";

// HTML and each decoded response keep their separate 2 MiB limit. A browser
// also needs CSS/scripts/AJAX, so its wire budget is larger and scoped to one
// application-initiated page, scroll or load-more operation, not the collection.
export const MAX_BROWSER_LOAD_BYTES = 32 * 1024 * 1024;

export type BrowserDestinationValidator = typeof validateRemoteUrl;
export type BrowserNetworkFactory = () => Promise<BrowserNetwork>;
export type NativeBrowserRequest = {
  url: string;
  method: string;
  resourceType: string;
  mainNavigation: boolean;
  redirected: boolean;
};

export function publicBrowserOptions(version: string): { locale: string; userAgent: string } {
  const platform =
    process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : process.platform === "darwin"
        ? "Macintosh; Intel Mac OS X 10_15_7"
        : "X11; Linux x86_64";
  return {
    locale: "fr-FR",
    userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.replace(/^.*\//, "")} Safari/537.36`,
  };
}

/** A temporary loopback SOCKS relay: Chromium owns HTTP, TLS, redirects and cookies.
 * Only the TCP destination is resolved and pinned here, before any bytes reach a site.
 * No HTML, passwords, certificates or cookies are read or stored by this relay.
 */
export class BrowserNetwork {
  readonly launchOptions: Pick<LaunchOptions, "args">;
  private sockets = new Set<Socket>();
  private failures = new Map<string, AppError>();
  private receivedBytes = 0;
  private budgetError?: AppError;
  private budgetFailure?: (error: AppError) => void;
  private closed = false;
  private constructor(
    private server: ReturnType<typeof createServer>,
    private validate: BrowserDestinationValidator,
    port: number,
    private maxLoadBytes: number,
  ) {
    this.launchOptions = {
      args: [
        `--proxy-server=socks5://127.0.0.1:${port}`,
        "--proxy-bypass-list=<-loopback>",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      ],
    };
  }

  static async create(
    validate: BrowserDestinationValidator = validateRemoteUrl,
    options: { maxLoadBytes?: number } = {},
  ): Promise<BrowserNetwork> {
    const maxLoadBytes = options.maxLoadBytes ?? MAX_BROWSER_LOAD_BYTES;
    if (!Number.isSafeInteger(maxLoadBytes) || maxLoadBytes <= 0)
      throw new Error("Invalid browser download budget");
    let network: BrowserNetwork;
    const server = createServer((socket) => network.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing browser relay address");
    network = new BrowserNetwork(server, validate, address.port, maxLoadBytes);
    return network;
  }

  async guard(url: string): Promise<void> {
    await this.validate(url);
  }

  // Only the application can begin a new operation. Redirects, background
  // requests and unsolicited navigations must not reset an exhausted budget.
  beginLoad(): void {
    this.assertWithinBudget();
    this.receivedBytes = 0;
  }

  assertWithinBudget(): void {
    if (this.budgetError) throw this.budgetError;
  }

  onBudgetExceeded(listener: (error: AppError) => void): void {
    this.budgetFailure = listener;
    if (this.budgetError) listener(this.budgetError);
  }

  private key(url: string): string {
    const target = new URL(url);
    return `${target.hostname.toLowerCase()}:${target.port || (target.protocol === "https:" ? "443" : "80")}`;
  }

  failure(url: string, browserMessage = ""): AppError {
    if (this.budgetError) return this.budgetError;
    const saved = this.failures.get(this.key(url));
    if (saved) return saved;
    if (/ERR_(?:CERT|SSL|TLS)_/.test(browserMessage)) return new RemoteConnectionError("TLS");
    if (/ERR_NAME_NOT_RESOLVED/.test(browserMessage)) return new RemoteConnectionError("DNS");
    if (/ERR_(?:CONNECTION_REFUSED|PROXY_CONNECTION_FAILED)/.test(browserMessage))
      return new RemoteConnectionError("CONNECT");
    if (/ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED)/.test(browserMessage))
      return new RemoteConnectionError("RESET");
    if (/ERR_(?:TIMED_OUT|CONNECTION_TIMED_OUT)/.test(browserMessage))
      return new AppError(504, "Le site a mis trop de temps à répondre.", "TIMEOUT");
    return new RemoteConnectionError("UNKNOWN");
  }

  private track(socket: Socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(45000, () => socket.destroy());
  }

  private accept(socket: Socket) {
    if (this.closed || this.sockets.size >= 64) {
      socket.destroy();
      return;
    }
    this.track(socket);
    let buffer = Buffer.alloc(0);
    let greeted = false;
    let connecting = false;
    const consume = (chunk: Buffer) => {
      if (connecting) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 512) {
        socket.destroy();
        return;
      }
      if (!greeted) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        if (buffer[0] !== 5 || !buffer.subarray(2, 2 + buffer[1]!).includes(0)) {
          socket.end(Buffer.from([5, 255]));
          return;
        }
        socket.write(Buffer.from([5, 0]));
        buffer = buffer.subarray(2 + buffer[1]!);
        greeted = true;
      }
      if (buffer.length < 5) return;
      if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0) {
        socket.destroy();
        return;
      }
      const type = buffer[3];
      const size = type === 1 ? 4 : type === 4 ? 16 : type === 3 ? buffer[4]! : 0;
      const offset = type === 3 ? 5 : 4;
      if (!size || ![1, 3, 4].includes(type!)) {
        socket.destroy();
        return;
      }
      if (buffer.length < offset + size + 2) return;
      const host =
        type === 1
          ? [...buffer.subarray(offset, offset + size)].join(".")
          : type === 4
            ? `[${Array.from({ length: 8 }, (_, i) => buffer.readUInt16BE(offset + i * 2).toString(16)).join(":")}]`
            : buffer.subarray(offset, offset + size).toString("utf8");
      const port = buffer.readUInt16BE(offset + size);
      if (!port || /[\s/@?#\\]/.test(host)) {
        socket.destroy();
        return;
      }
      let destinationUrl: string;
      try {
        destinationUrl = new URL(`http://${host}:${port}/`).href;
      } catch {
        socket.destroy();
        return;
      }
      const remaining = buffer.subarray(offset + size + 2);
      connecting = true;
      socket.pause();
      socket.off("data", consume);
      void this.open(socket, destinationUrl, port, remaining);
    };
    socket.on("data", consume);
  }

  private async open(socket: Socket, url: string, port: number, remaining: Buffer) {
    let upstream: Socket | undefined;
    try {
      const destination = await this.validate(url);
      if (this.closed || socket.destroyed) return;
      // Connecting to the numeric address cannot trigger a second DNS resolution.
      upstream = connect({ host: destination.address, family: destination.family, port });
      this.track(upstream);
      const remote = upstream;
      socket.on("close", () => remote.destroy());
      remote.on("close", () => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        remote.once("connect", resolve);
        remote.once("error", reject);
      });
      if (this.closed || socket.destroyed) {
        remote.destroy();
        return;
      }
      socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      remote.on("data", (chunk: Buffer) => {
        this.receivedBytes += chunk.length;
        if (this.receivedBytes > this.maxLoadBytes) {
          if (!this.budgetError) {
            this.budgetError = new AppError(
              413,
              "Le chargement de cette page dépasse le budget réseau autorisé du navigateur.",
              "RESPONSE_TOO_LARGE",
            );
            this.budgetFailure?.(this.budgetError);
          }
          remote.destroy();
          socket.destroy();
        }
      });
      if (remaining.length) remote.write(remaining);
      socket.pipe(remote).pipe(socket);
      socket.resume();
    } catch (error) {
      if (this.failures.size < 512)
        this.failures.set(
          this.key(url),
          error instanceof AppError ? error : remoteConnectionError(error),
        );
      upstream?.destroy();
      if (!socket.destroyed) socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
    }
  }

  async close() {
    this.closed = true;
    this.budgetFailure = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.failures.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** Count Chromium's decoded response chunks as well as the relay's wire bytes. */
export async function watchBrowserResponseSize(
  page: Page,
  onFailure: (error: AppError) => void,
  network?: BrowserNetwork,
) {
  network?.onBudgetExceeded((error) => {
    onFailure(error);
    void page.close().catch(() => {});
  });
  const session = await page.createCDPSession();
  const sizes = new Map<string, number>();
  await session.send("Network.enable");
  session.on("Network.dataReceived", ({ requestId, dataLength }) => {
    const size = (sizes.get(requestId) ?? 0) + dataLength;
    sizes.set(requestId, size);
    if (size > MAX_REMOTE_BYTES) {
      onFailure(
        new AppError(
          413,
          "La réponse navigateur dépasse la taille autorisée.",
          "RESPONSE_TOO_LARGE",
        ),
      );
      void page.close().catch(() => {});
    }
  });
  session.on("Network.loadingFinished", ({ requestId }) => sizes.delete(requestId));
  session.on("Network.loadingFailed", ({ requestId }) => sizes.delete(requestId));
}

/** Puppeteer interception checks every redirected request before Chromium sends it. */
export async function watchBrowserRequests(
  page: Page,
  network: BrowserNetwork,
  check: (request: NativeBrowserRequest) => void,
  onFailure: (error: AppError, request: NativeBrowserRequest) => void,
) {
  setRequestGuard(page, async (intercepted) => {
    const request: NativeBrowserRequest = {
      url: intercepted.url(),
      method: intercepted.method(),
      resourceType:
        intercepted.resourceType() === "xhr"
          ? "XHR"
          : intercepted.resourceType().replace(/^./, (letter) => letter.toUpperCase()),
      mainNavigation: intercepted.isNavigationRequest() && intercepted.frame() === page.mainFrame(),
      redirected: intercepted.redirectChain().length > 0,
    };
    try {
      await network.guard(request.url);
      check(request);
    } catch (error) {
      const failure = error instanceof AppError ? error : new RemoteConnectionError("UNKNOWN");
      if (!page.isClosed()) onFailure(failure, request);
      throw failure;
    }
  });
}
