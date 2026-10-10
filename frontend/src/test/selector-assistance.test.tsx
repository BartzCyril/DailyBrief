import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type {
  JournalPreview,
  ScrapingConfig,
  SelectorAnalysisResponse,
  Source,
} from "@dailybrief/shared";
import { RssForm } from "../sources/RssForm";
import { ScrapingForm } from "../sources/ScrapingForm";
import { EditSourceForm } from "../sources/EditSourceForm";
import { JournalTable } from "../sources/JournalTable";
import { SelectorAssistance } from "../sources/SelectorAssistance";
import { SourceList } from "../sources/SourceList";

const config: ScrapingConfig = {
  articleSelector: ".news-card",
  titleSelector: "h2",
  linkSelector: "a.read",
  descriptionSelector: ".intro",
  mode: "LOAD_MORE",
  loadMore: { buttonSelector: ".next-news", waitTimeoutMs: 20000 },
};
const rssResult: SelectorAnalysisResponse = {
  kind: "RSS_LINK",
  articleLinkSelector: "a.accessToPrimaryDoc.primarydoc",
  analyzedUrl: "https://notices.example.com/notice/1",
  message: "Le lien vers le journal a été identifié. Testez le flux avant de l'enregistrer.",
  complete: true,
  missingFields: [],
};
const scrapingResult: SelectorAnalysisResponse = {
  kind: "SCRAPING",
  scrapingConfig: config,
  analyzedUrl: "https://example.com/news",
  message: "Les sélecteurs des articles et du bouton ont été identifiés.",
  complete: true,
  missingFields: [],
};
const preview = {
  articles: [
    {
      title: "Article de l'aperçu précédent",
      url: "https://example.com/article",
      description: null,
      publishedAt: null,
    },
  ],
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
beforeEach(() => vi.restoreAllMocks());

test("fills a complex RSS selector from its feed URL without testing or saving automatically", async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    json(url.endsWith("/analyze") ? rssResult : preview),
  );
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<RssForm />, { wrapper: MemoryRouter });
  await user.type(screen.getByLabelText("URL du flux RSS"), "https://example.com/feed.xml");
  await user.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
  expect(await screen.findByDisplayValue(rssResult.articleLinkSelector)).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/ai/selectors/analyze",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ kind: "RSS_LINK", url: "https://example.com/feed.xml" }),
    }),
  );
  expect(screen.getByRole("button", { name: "Enregistrer le flux" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Tester" }));
  await screen.findByText(preview.articles[0]!.title);
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({
    url: "https://example.com/feed.xml",
    articleLinkSelector: rssResult.articleLinkSelector,
  });
});

test("fills scraping fields and retrieval mode, invalidating an existing preview", async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    json(url.endsWith("/analyze") ? scrapingResult : { ...preview, mode: "SCROLL" }),
  );
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<ScrapingForm />, { wrapper: MemoryRouter });
  await user.type(screen.getByLabelText("URL du site"), "https://example.com/news");
  await user.type(screen.getByLabelText("Sélecteur des articles"), "article");
  await user.type(screen.getByLabelText("Sélecteur du titre"), "h1");
  await user.type(screen.getByLabelText("Sélecteur du lien"), "a");
  await user.click(screen.getByRole("button", { name: "Tester" }));
  await screen.findByText(preview.articles[0]!.title);
  await user.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
  expect(await screen.findByDisplayValue(".news-card")).toBeInTheDocument();
  expect(screen.getByLabelText("Sélecteur du titre")).toHaveValue("h2");
  expect(screen.getByLabelText("Sélecteur du lien")).toHaveValue("a.read");
  expect(screen.getByLabelText("Sélecteur du bouton")).toHaveValue(".next-news");
  expect(screen.getByLabelText("Délai maximum après un clic (ms)")).toHaveValue(20000);
  expect(screen.queryByText(preview.articles[0]!.title)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Enregistrer la source" })).toBeDisabled();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
});

test("analyzes a journal's public login form, preserves credentials and authenticated selectors, and exposes partial help", async () => {
  const journal: JournalPreview = {
    domain: "journal.example.com",
    count: 2,
    enabled: true,
    email: "reader@example.com",
    hasCredentials: true,
    authenticationSupported: true,
    loginConfig: {
      loginUrl: "https://journal.example.com/login",
      emailSelector: "#old-email",
      passwordSelector: "#old-password",
      submitSelector: "#old-submit",
      successSelector: ".account-existing",
      articleContentSelector: ".full-existing",
    },
  };
  const result: SelectorAnalysisResponse = {
    kind: "JOURNAL_LOGIN",
    analyzedUrl: "https://accounts.journal.example.com/login",
    message: "Le formulaire est identifié. Le sélecteur visible après connexion reste à vérifier.",
    complete: false,
    missingFields: ["successSelector"],
    helpRequestId: "ticket-journal",
    loginConfig: {
      loginUrl: "https://accounts.journal.example.com/login",
      emailSelector: "#email",
      passwordSelector: "#password",
      submitSelector: "#connect",
    },
  };
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    json(url.endsWith("/analyze") ? result : journal),
  );
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<JournalTable journals={[journal]} onChange={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Configurer l'accès" }));
  await user.type(screen.getByLabelText(/Nouveau mot de passe/), "never-send-to-ai");
  await user.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
  expect(await screen.findByDisplayValue("#connect")).toBeInTheDocument();
  expect(screen.getByLabelText("URL du formulaire de connexion")).toHaveValue(
    result.loginConfig.loginUrl,
  );
  expect(screen.getByLabelText("Email pour journal.example.com")).toHaveValue("reader@example.com");
  expect(screen.getByLabelText(/Nouveau mot de passe/)).toHaveValue("never-send-to-ai");
  expect(screen.getByLabelText("Sélecteur visible après connexion")).toHaveValue(
    ".account-existing",
  );
  expect(screen.getByLabelText("Sélecteur du contenu intégral (facultatif)")).toHaveValue(
    ".full-existing",
  );
  expect(screen.getByRole("button", { name: "Envoyer une demande d'aide" })).toBeEnabled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
    kind: "JOURNAL_LOGIN",
    url: journal.loginConfig!.loginUrl,
  });
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("never-send-to-ai");
  await user.click(screen.getByRole("button", { name: "Enregistrer les identifiants" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
    email: "reader@example.com",
    password: "never-send-to-ai",
    loginConfig: { successSelector: ".account-existing", articleContentSelector: ".full-existing" },
  });
});

test("offers help only after failure, sends it on demand, supports a failed send retry and avoids duplicate mail", async () => {
  let helpAttempts = 0;
  let analysisAttempts = 0;
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/analyze")) {
      analysisAttempts++;
      return analysisAttempts === 1
        ? json(
            { message: "Analyse impossible", code: "AI_FAILED", helpRequestId: "ticket-one" },
            422,
          )
        : json(rssResult);
    }
    helpAttempts++;
    return helpAttempts === 1
      ? json({ message: "Le serveur email est indisponible." }, 503)
      : json({ message: "Votre demande d'aide a été envoyée." });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  const onResult = vi.fn();
  render(<SelectorAssistance kind="RSS_LINK" url="https://example.com/feed" onResult={onResult} />);
  expect(
    screen.queryByRole("button", { name: "Envoyer une demande d'aide" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Analyse impossible");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(onResult).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Envoyer une demande d'aide" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("serveur email");
  expect(screen.getByRole("button", { name: "Envoyer une demande d'aide" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Envoyer une demande d'aide" }));
  expect(await screen.findByText("Votre demande d'aide a été envoyée.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Envoyer une demande d'aide" })).toBeDisabled();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/help"))).toHaveLength(2);
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({
    helpRequestId: "ticket-one",
  });
  await user.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith(rssResult));
  expect(
    screen.queryByRole("button", { name: "Envoyer une demande d'aide" }),
  ).not.toBeInTheDocument();
});

test("ignores a result for an edited URL and clears the associated help request", async () => {
  let finish: ((response: Response) => void) | undefined;
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }),
  );
  const onResult = vi.fn();
  const busy = vi.fn();
  function Harness() {
    const [url, setUrl] = useState("https://example.com/first");
    return (
      <>
        <input
          aria-label="URL à analyser"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <SelectorAssistance kind="RSS_LINK" url={url} onResult={onResult} onBusyChange={busy} />
      </>
    );
  }
  render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
  expect(screen.getByRole("button", { name: "Analyse en cours…" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("URL à analyser"), {
    target: { value: "https://example.com/second" },
  });
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    finish?.(json({ ...rssResult, complete: false, helpRequestId: "obsolete" })),
  );
  expect(onResult).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Envoyer une demande d'aide" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remplir avec l'IA" })).toBeEnabled();
  expect(busy).toHaveBeenLastCalledWith(false);
});

test("aborts an analysis when its modal/form is unmounted and never applies a late response", async () => {
  let finish: ((response: Response) => void) | undefined;
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }),
  );
  const onResult = vi.fn();
  const { unmount } = render(
    <SelectorAssistance kind="RSS_LINK" url="https://example.com/feed" onResult={onResult} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
  unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => finish?.(json(rssResult)));
  expect(onResult).not.toHaveBeenCalled();
});

test.each(["RSS", "SCRAPING"] as const)(
  "fills selectors while editing a %s source without saving",
  async (type) => {
    const source: Source = {
      id: "source-edit",
      type,
      url: "https://example.com/source",
      enabled: true,
      scrapingConfig:
        type === "RSS"
          ? null
          : {
              articleSelector: "article",
              titleSelector: "h1",
              linkSelector: "a",
              mode: "SCROLL",
              scroll: { maxScrolls: 3, waitAfterScrollMs: 1000 },
            },
    };
    const fetcher = vi.fn(async (url: string) =>
      json(url.endsWith("/analyze") ? (type === "RSS" ? rssResult : scrapingResult) : preview),
    );
    vi.stubGlobal("fetch", fetcher);
    const save = vi.fn(async () => {});
    const user = userEvent.setup();
    render(<EditSourceForm source={source} busy={false} onSave={save} onCancel={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Tester" }));
    await screen.findByText(preview.articles[0]!.title);
    await user.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
    expect(
      await screen.findByDisplayValue(
        type === "RSS" ? rssResult.articleLinkSelector : ".news-card",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(preview.articles[0]!.title)).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enregistrer les modifications" })).toBeEnabled();
  },
);

test("does not offer email help for a network failure without a server ticket", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network");
    }),
  );
  render(<SelectorAssistance kind="RSS_LINK" url="https://example.com/feed" onResult={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connexion impossible");
  expect(
    screen.queryByRole("button", { name: "Envoyer une demande d'aide" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remplir avec l'IA" })).toBeEnabled();
});

test.each(["RSS", "SCRAPING", "EDIT_RSS", "EDIT_SCRAPING"] as const)(
  "cancels a slow analysis in %s, immediately unlocks fields and ignores its late result",
  async (form) => {
    let finish: ((response: Response) => void) | undefined;
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    const type = form.includes("SCRAPING") ? "SCRAPING" : "RSS";
    render(
      form.startsWith("EDIT") ? (
        <EditSourceForm
          source={{
            id: "editable",
            type,
            url: "https://example.com/source",
            enabled: true,
            scrapingConfig: null,
          }}
          busy={false}
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />
      ) : form === "RSS" ? (
        <RssForm />
      ) : (
        <ScrapingForm />
      ),
      { wrapper: MemoryRouter },
    );
    const url = screen.getByLabelText(type === "RSS" ? "URL du flux RSS" : "URL du site");
    if (!form.startsWith("EDIT")) await user.type(url, "https://example.com/source");
    const selector = screen.getByLabelText(
      type === "RSS" ? "Sélecteur du lien vers l'article (facultatif)" : "Sélecteur des articles",
    );
    await user.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
    expect(url).toBeDisabled();
    expect(selector).toBeDisabled();
    expect(screen.getByRole("button", { name: "Annuler l'analyse" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Annuler l'analyse" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Annuler l'analyse" }));
    expect(signal?.aborted).toBe(true);
    expect(url).toBeEnabled();
    expect(selector).toBeEnabled();
    await user.type(selector, ".manual-selection");
    await act(async () => finish?.(json(type === "RSS" ? rssResult : scrapingResult)));
    expect(selector).toHaveValue(".manual-selection");
    expect(screen.getByRole("button", { name: "Remplir avec l'IA" })).toBeEnabled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Envoyer une demande d'aide" })).toBeNull();
  },
);

test("can retry after cancellation without applying a previous request over the new result", async () => {
  const requests: Array<{ finish: (response: Response) => void; signal: AbortSignal }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((finish) => {
          requests.push({ finish, signal: init!.signal as AbortSignal });
        }),
    ),
  );
  const onResult = vi.fn();
  const onPendingChange = vi.fn();
  render(
    <SelectorAssistance
      kind="RSS_LINK"
      url="https://example.com/feed"
      onResult={onResult}
      onPendingChange={onPendingChange}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
  await user.click(screen.getByRole("button", { name: "Annuler l'analyse" }));
  expect(requests[0]!.signal.aborted).toBe(true);
  await user.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
  await act(async () => requests[0]!.finish(json({ ...rssResult, articleLinkSelector: ".old" })));
  expect(onResult).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Analyse en cours…" })).toBeDisabled();
  expect(onPendingChange).toHaveBeenLastCalledWith("analysis");
  await act(async () => requests[1]!.finish(json(rssResult)));
  expect(onResult).toHaveBeenCalledExactlyOnceWith(rssResult);
  expect(onPendingChange).toHaveBeenLastCalledWith(null);
});

const slowJournal: JournalPreview = {
  domain: "journal.example.com",
  count: 1,
  enabled: true,
  email: "reader@example.com",
  hasCredentials: true,
  authenticationSupported: false,
};

test.each(["close", "escape", "cancel"] as const)(
  "closes journal configuration with %s during a slow analysis and aborts without exposing credentials",
  async (action) => {
    let finish: ((response: Response) => void) | undefined;
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<JournalTable journals={[slowJournal]} onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Configurer l'accès" }));
    await user.type(screen.getByLabelText(/Nouveau mot de passe/), "private-secret");
    await user.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
    expect(screen.getByRole("button", { name: "Annuler l'analyse" })).toBeEnabled();
    expect(screen.getByLabelText(/Nouveau mot de passe/)).toBeDisabled();
    if (action === "escape") await user.keyboard("{Escape}");
    else
      await user.click(
        screen.getByRole("button", { name: action === "close" ? "Fermer la fenêtre" : "Annuler" }),
      );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(signal?.aborted).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      kind: "JOURNAL_LOGIN",
      url: "https://journal.example.com",
    });
    await act(async () => finish?.(json({ ...rssResult, helpRequestId: "late-help" })));
    await user.click(screen.getByRole("button", { name: "Configurer l'accès" }));
    expect(screen.getByLabelText(/Nouveau mot de passe/)).toHaveValue("");
    expect(screen.getByRole("button", { name: "Remplir avec l'IA" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Envoyer une demande d'aide" })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test("protects the journal modal while its explicitly requested help email is being sent", async () => {
  let finish: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url.endsWith("/analyze")
        ? Promise.resolve(
            json({ message: "Analyse impossible", helpRequestId: "help-ticket" }, 422),
          )
        : new Promise<Response>((resolve) => {
            finish = resolve;
          }),
    ),
  );
  const user = userEvent.setup();
  render(<JournalTable journals={[slowJournal]} onChange={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Configurer l'accès" }));
  await user.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
  await user.click(await screen.findByRole("button", { name: "Envoyer une demande d'aide" }));
  expect(screen.getByRole("button", { name: "Fermer la fenêtre" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Annuler" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Annuler l'analyse" })).toBeNull();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await act(async () => finish?.(json({ message: "Votre demande d'aide a été envoyée." })));
  expect(screen.getByRole("button", { name: "Fermer la fenêtre" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Annuler" })).toBeEnabled();
});

test("blocks closing a source modal during help delivery and unlocks it after SMTP fails", async () => {
  let fail: ((reason: Error) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url.endsWith("/analyze")
        ? Promise.resolve(
            json({ message: "Analyse impossible", helpRequestId: "help-ticket" }, 422),
          )
        : new Promise<Response>((_resolve, reject) => {
            fail = reject;
          }),
    ),
  );
  const user = userEvent.setup();
  render(
    <SourceList
      sources={[
        {
          id: "source-smtp",
          type: "RSS",
          url: "https://example.com/feed",
          enabled: true,
          scrapingConfig: null,
        },
      ]}
      onChanged={vi.fn()}
    />,
    { wrapper: MemoryRouter },
  );
  await user.click(screen.getByRole("button", { name: "Modifier https://example.com/feed" }));
  await user.click(screen.getByRole("button", { name: "Remplir avec l'IA" }));
  await user.click(await screen.findByRole("button", { name: "Envoyer une demande d'aide" }));
  expect(screen.getByRole("button", { name: "Fermer la fenêtre" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Annuler" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await act(async () => fail?.(new Error("SMTP unavailable")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connexion impossible");
  expect(screen.getByRole("button", { name: "Fermer la fenêtre" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Annuler" })).toBeEnabled();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
