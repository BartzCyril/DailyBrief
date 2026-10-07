import { test, expect } from "bun:test";
import type { ScrapingConfig } from "@dailybrief/shared";
import { scrapingSchema } from "../../shared/src/scraping";
import { ScrapingService } from "../src/scraping";
import { AppError } from "../src/errors";
import { fetchRemoteText, type RemotePageOptions } from "../src/network";

const config: ScrapingConfig = {
  articleSelector: "article",
  titleSelector: "h2",
  linkSelector: "a",
  mode: "LOAD_MORE",
  loadMore: { buttonSelector: "#more", waitTimeoutMs: 1000 },
};
const card = (id: string) =>
  `<article><h2>Article ${id}</h2><a href="/articles/${id}">Lire</a></article>`;
const page = (script: string, button = '<button id="more">Plus</button>') =>
  `${card("first")}${button}<script>${script}</script>`;

test("requires button settings and a valid waiting delay", () => {
  expect(scrapingSchema.safeParse(config).success).toBe(true);
  for (const loadMore of [
    undefined,
    { buttonSelector: "", waitTimeoutMs: 1000 },
    { buttonSelector: "#more", waitTimeoutMs: 0 },
    { buttonSelector: "#more", waitTimeoutMs: 60001 },
  ])
    expect(scrapingSchema.safeParse({ ...config, loadMore }).success).toBe(false);
});

test("clicks beyond fifteen batches, deduplicates overlaps and stops when the button disappears", async () => {
  const loads: string[] = [];
  const service = new ScrapingService(async (url) => {
    if (url.includes("/batch/")) {
      loads.push(url);
      return JSON.stringify({ html: card("first") + card(url.split("/").at(-1)!) });
    }
    return page(`let n=0; document.querySelector('#more').onclick=async()=>{
      const response=await fetch('/batch/'+(++n)); const data=await response.json();
      document.querySelector('#more').insertAdjacentHTML('beforebegin',data.html);
      if(n===17) document.querySelector('#more').remove();
    };`);
  });
  const result = await service.collect("https://fixture.example/news", config);
  expect(loads).toHaveLength(17);
  expect(result.articles).toHaveLength(18);
  expect(result.articles.at(-1)?.title).toBe("Article 17");
  expect(result.warnings).toBeUndefined();
}, 20000);

test("waits for delayed DOM articles and stops on a disabled button", async () => {
  const service = new ScrapingService(async () =>
    page(`document.querySelector('#more').onclick=()=>setTimeout(()=>{
    document.querySelector('#more').insertAdjacentHTML('beforebegin',${JSON.stringify(card("delayed"))});
    document.querySelector('#more').disabled=true;
  },500);`),
  );
  const result = await service.collect("https://fixture.example/news", config);
  expect(result.articles.map((a) => a.title)).toEqual(["Article first", "Article delayed"]);
  expect(result.warnings).toBeUndefined();
}, 10000);
test("waits for every pending AJAX request before accepting a staged article batch", async () => {
  const service = new ScrapingService(async (url) => {
    if (url.endsWith("/slow")) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return JSON.stringify({ html: card("slow") });
    }
    if (url.endsWith("/fast")) return JSON.stringify({ html: card("fast") });
    return page(`document.querySelector('#more').onclick=()=>{
      document.querySelector('#more').disabled=true;
      for(const part of ['fast','slow']) fetch('/'+part).then(r=>r.json()).then(data=>{
        document.querySelector('#more').insertAdjacentHTML('beforebegin',data.html);
      });
    };`);
  });
  const result = await service.collect("https://fixture.example/news", {
    ...config,
    loadMore: { ...config.loadMore!, waitTimeoutMs: 2000 },
  });
  expect(result.articles.map((a) => a.title)).toEqual([
    "Article first",
    "Article fast",
    "Article slow",
  ]);
}, 10000);

test("preserves replaced article lists and reports repeated or ineffective clicks", async () => {
  const service = new ScrapingService(async () =>
    page(`let n=0; document.querySelector('#more').onclick=()=>{
    document.querySelector('article').outerHTML = n++ === 0 ? ${JSON.stringify(card("second"))} : ${JSON.stringify(card("first"))};
  };`),
  );
  const result = await service.collect("https://fixture.example/news", config);
  expect(result.articles.map((a) => a.title)).toEqual(["Article first", "Article second"]);
  expect(result.warnings?.[0]).toContain("aucun nouvel article");
  expect(result.warnings?.[0]).toContain("2 clic(s)");
}, 10000);

test("keeps first-page validation free of clicks and detects invalid button CSS", async () => {
  const requests: string[] = [];
  const service = new ScrapingService(async (url) => {
    requests.push(url);
    return page("document.querySelector('#more').onclick=()=>fetch('/must-not-click');");
  });
  await service.validateFirstPage("https://fixture.example/news", config);
  expect(requests).toEqual(["https://fixture.example/news"]);
  const invalid = { ...config, loadMore: { ...config.loadMore!, buttonSelector: "??" } };
  expect(
    await service.validateFirstPage("https://fixture.example/news", invalid).catch((e) => e),
  ).toMatchObject({ code: "INVALID_LOAD_MORE_BUTTON" });
}, 10000);

test("reports a missing button and rejects ambiguous visible buttons", async () => {
  const absent = new ScrapingService(async () => card("first"));
  const result = await absent.collect("https://fixture.example/news", config);
  expect(result.articles).toHaveLength(1);
  expect(result.warnings?.[0]).toContain("Aucun bouton visible");
  const ambiguous = new ScrapingService(async () =>
    page("", '<button class="more">Plus</button><button class="more">Autre</button>'),
  );
  expect(
    await ambiguous
      .collect("https://fixture.example/news", {
        ...config,
        loadMore: { ...config.loadMore!, buttonSelector: ".more" },
      })
      .catch((e) => e),
  ).toMatchObject({ code: "INVALID_LOAD_MORE_BUTTON" });
}, 10000);

test("forwards same-origin AJAX POST bodies and headers through the guarded transport", async () => {
  const calls: Array<{ url: string; options?: RemotePageOptions }> = [];
  const service = new ScrapingService(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/ajax")) return JSON.stringify({ html: card("post") });
    return page(`document.querySelector('#more').onclick=async()=>{
      const response=await fetch('/ajax',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:'page=2&nonce=test'});
      const data=await response.json(); document.querySelector('#more').insertAdjacentHTML('beforebegin',data.html);
      document.querySelector('#more').remove();
    };`);
  });
  const result = await service.collect("https://fixture.example/news", config);
  expect(result.articles).toHaveLength(2);
  expect(calls[1]).toMatchObject({
    url: "https://fixture.example/ajax",
    options: {
      method: "POST",
      body: "page=2&nonce=test",
      contentType: "application/x-www-form-urlencoded",
      requestedWith: "XMLHttpRequest",
    },
  });
}, 10000);

test("does not treat AJAX failures or private GET targets as exhaustion", async () => {
  for (const target of ["https://fixture.example/failure", "http://127.0.0.1/private"]) {
    const calls: string[] = [];
    const service = new ScrapingService(async (url, options) => {
      calls.push(url);
      if (url.endsWith("/private")) return fetchRemoteText(url, options);
      if (url.endsWith("/failure"))
        throw new AppError(502, "Chargement inaccessible.", "UPSTREAM_ERROR");
      const init = target.includes("127.0.0.1") ? {} : { method: "POST", body: "page=2" };
      return page(
        `document.querySelector('#more').onclick=()=>fetch(${JSON.stringify(target)},${JSON.stringify(init)}).catch(()=>{});`,
      );
    });
    expect(
      await service.collect("https://fixture.example/news", config).catch((e) => e),
    ).toMatchObject({ code: target.endsWith("/failure") ? "UPSTREAM_ERROR" : "UNSAFE_URL" });
  }
}, 10000);

test("collects WordPress article batches when a click also triggers an unrelated third-party POST", async () => {
  const calls: string[] = [];
  const origin = "https://www.observatoire-culture.net";
  const ajax = `${origin}/wp-admin/admin-ajax.php`;
  const service = new ScrapingService(async (url, options) => {
    calls.push(url);
    if (url === ajax) {
      expect(options).toMatchObject({ method: "POST", body: "action=more_posts&page=2" });
      return JSON.stringify({ html: card("wordpress-next") });
    }
    return page(`document.querySelector('#more').onclick=async()=>{
      fetch('https://metrics.example/event',{method:'POST',body:'click=more'}).catch(()=>{});
      const data=await(await fetch(${JSON.stringify(ajax)},{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'action=more_posts&page=2'})).json();
      document.querySelector('#more').insertAdjacentHTML('beforebegin',data.html);
      document.querySelector('#more').remove();
    };`);
  });
  const result = await service.collect(`${origin}/tous-les-medias/`, config);
  expect(result.articles.map((a) => a.title)).toEqual(["Article first", "Article wordpress-next"]);
  expect(result.warnings).toBeUndefined();
  expect(calls).toEqual([`${origin}/tous-les-medias/`, ajax]);
}, 10000);

test("retains the preview and reports blocked external POSTs without claiming they caused the lack of articles", async () => {
  const targets = [
    "https://api.axept.io/v1/analytics/evts",
    "https://www.google.com/recaptcha/api2/reload?k=fixture",
    "https://www.google.com/recaptcha/api2/clr?k=fixture",
    "https://other.example/load",
  ];
  const calls: string[] = [];
  const service = new ScrapingService(async (url) => {
    calls.push(url);
    return page(`document.querySelector('#more').onclick=()=>{
      for(const target of ${JSON.stringify(targets)})
        fetch(target,{method:'POST',body:'event=click'}).catch(()=>{});
    };`);
  });
  const result = await service.collect("https://fixture.example/news", config);
  expect(result.articles).toHaveLength(1);
  expect(calls).toEqual(["https://fixture.example/news"]);
  expect(result.warnings?.[0]).toContain("aucun nouvel article");
  expect(result.warnings?.join(" ")).toContain("Aucune requête de chargement AJAX");
  for (const target of targets) expect(result.warnings?.join(" ")).toContain(target);
  expect(result.warnings?.join(" ")).toContain("cela ne permet pas d'identifier la cause");
}, 10000);

test("reports script initialization errors when a visible button never starts its article request", async () => {
  const service = new ScrapingService(async (url) => {
    if (url.endsWith("/theme.js"))
      return "throw new Error('Article loader initialization failed');";
    return `${page("")}<script src="/theme.js"></script>`;
  });
  const result = await service.collect("https://fixture.example/news", config);
  expect(result.articles).toHaveLength(1);
  expect(result.warnings?.join(" ")).toContain("Aucune requête de chargement AJAX");
  expect(result.warnings?.join(" ")).toContain("Article loader initialization failed");
}, 10000);
test("checks POST requests against the current page after a JavaScript redirect", async () => {
  const calls: string[] = [];
  const service = new ScrapingService(async (url) => {
    calls.push(url);
    if (url === "https://www.fixture.example/news")
      return '<script>location.href="https://fixture.example/news"</script>';
    if (url.endsWith("/ajax")) return JSON.stringify({ html: card("redirected") });
    return page(`document.querySelector('#more').onclick=async()=>{
      const data=await(await fetch('/ajax',{method:'POST',body:'page=2'})).json();
      document.querySelector('#more').insertAdjacentHTML('beforebegin',data.html);
      document.querySelector('#more').remove();
    };`);
  });
  const result = await service.collect("https://www.fixture.example/news", config);
  expect(result.articles).toHaveLength(2);
  expect(calls).toEqual([
    "https://www.fixture.example/news",
    "https://fixture.example/news",
    "https://fixture.example/ajax",
  ]);
}, 10000);
test("accepts an empty final WordPress batch even when the click triggers a blocked third-party POST", async () => {
  const requests: string[] = [];
  const service = new ScrapingService(async (url) => {
    requests.push(url);
    if (url.endsWith("/ajax")) return JSON.stringify({ html: "" });
    return page(`document.querySelector('#more').onclick=async()=>{
      fetch('https://metrics.example/event',{method:'POST',body:'click=more'}).catch(()=>{});
      const data=await(await fetch('/ajax',{method:'POST',body:'page=2'})).json();
      document.querySelector('#more').insertAdjacentHTML('beforebegin',data.html);
      document.querySelector('#more').remove();
    };`);
  });
  const result = await service.collect("https://fixture.example/news", config);
  expect(result.articles).toHaveLength(1);
  expect(result.warnings?.[0]).toContain("aucun nouvel article");
  expect(requests).toEqual(["https://fixture.example/news", "https://fixture.example/ajax"]);
}, 10000);

test("waits for the OPC theme fetching lock before clicking the next WordPress batch", async () => {
  const origin = "https://www.observatoire-culture.net";
  const batches: string[] = [];
  const service = new ScrapingService(async (url, options) => {
    if (url.endsWith("/wp-admin/admin-ajax.php")) {
      batches.push(options?.body ?? "");
      return JSON.stringify({ template: card(String(batches.length)), maxPage: 3 });
    }
    return `${card("first")}<div id="grid" data-offset="12" data-paged="1"></div>
      <div><button id="more-posts">Voir plus</button></div><script>
      const button=document.querySelector('#more-posts'), grid=document.querySelector('#grid');
      button.onclick=async()=>{
        if(button.classList.contains('fetching')) return;
        button.classList.add('fetching');
        const body=new URLSearchParams({action:'load_objects',offset:grid.dataset.offset,page:grid.dataset.paged,object:'post'});
        const data=await(await fetch('/wp-admin/admin-ajax.php',{method:'POST',body})).json();
        grid.insertAdjacentHTML('beforeend',data.template);
        grid.dataset.offset=Number(grid.dataset.offset)+12;
        grid.dataset.paged=Number(grid.dataset.paged)+1;
        if(Number(grid.dataset.paged)>data.maxPage) button.parentElement.style.display='none';
        setTimeout(()=>button.classList.remove('fetching'),500);
      };</script>`;
  });
  const result = await service.collect(`${origin}/tous-les-medias/`, {
    ...config,
    loadMore: { buttonSelector: "#more-posts", waitTimeoutMs: 1500 },
  });
  expect(batches).toEqual([
    "action=load_objects&offset=12&page=1&object=post",
    "action=load_objects&offset=24&page=2&object=post",
    "action=load_objects&offset=36&page=3&object=post",
  ]);
  expect(result.articles.map((a) => a.title)).toEqual([
    "Article first",
    "Article 1",
    "Article 2",
    "Article 3",
  ]);
  expect(result.warnings).toBeUndefined();
}, 10000);

test("waits for an accessible busy button to be ready before the next click", async () => {
  const service = new ScrapingService(async () =>
    page(`let n=0;
    document.querySelector('#more').onclick=()=>{
      const button=document.querySelector('#more');
      if(button.getAttribute('aria-busy')==='true') return;
      button.setAttribute('aria-busy','true');
      button.insertAdjacentHTML('beforebegin','<article><h2>Batch '+(++n)+'</h2><a href="/batch/'+n+'">Lire</a></article>');
      setTimeout(()=>{
        button.setAttribute('aria-busy','false');
        if(n===2) button.disabled=true;
      },600);
    };`),
  );
  const result = await service.collect("https://fixture.example/news", {
    ...config,
    loadMore: { buttonSelector: "#more", waitTimeoutMs: 1500 },
  });
  expect(result.articles.map((a) => a.title)).toEqual(["Article first", "Batch 1", "Batch 2"]);
  expect(result.warnings).toBeUndefined();
}, 10000);

test("reports a loading lock that never clears instead of sending ignored clicks", async () => {
  const service = new ScrapingService(async () =>
    page(`document.querySelector('#more').onclick=()=>{
    const button=document.querySelector('#more');
    button.classList.add('fetching');
    button.insertAdjacentHTML('beforebegin',${JSON.stringify(card("locked"))});
  };`),
  );
  const error = await service.collect("https://fixture.example/news", config).catch((e) => e);
  expect(error).toMatchObject({ code: "LOAD_MORE_TIMEOUT", status: 504 });
  expect(error.message).toContain("bouton");
}, 10000);
