import { useId, useMemo, useState } from "react";
import { Code2, MousePointer2 } from "lucide-react";

export const exampleHtml = `<article class="article-card">
  <h2><a class="title" href="/article/cloud">Le cloud de demain</a></h2>
  <p class="description">De nouvelles façons de travailler.</p>
  <time datetime="2026-10-10">10 octobre 2026</time>
</article>`;

/** Query an isolated, inert HTML document. Never insert typed HTML or execute code. */
export function inspectSelector(selector: string): { error: string; matches: string[] } {
  if (!selector.trim())
    return { error: "Saisissez un sélecteur pour voir les correspondances.", matches: [] };
  try {
    const document = new DOMParser().parseFromString(exampleHtml, "text/html");
    const root = document.querySelector("article")!;
    return {
      error: "",
      matches: Array.from(root.querySelectorAll(selector)).map((element) => element.outerHTML),
    };
  } catch {
    return { error: "Ce sélecteur CSS n’est pas valide. Essayez h2 ou .description.", matches: [] };
  }
}

export function SelectorPlayground() {
  const [selector, setSelector] = useState("h2 a.title");
  const id = useId();
  const result = useMemo(() => inspectSelector(selector), [selector]);
  return (
    <div className="selector-playground">
      <div className="playground-heading">
        <MousePointer2 size={20} aria-hidden="true" />
        <div>
          <h3>À vous de jouer</h3>
          <p>Cet exemple fonctionne ici, sans compte et sans appel à l’IA.</p>
        </div>
      </div>
      <div className="playground-panels">
        <div>
          <p className="playground-label">Une carte d’article, dans la page</p>
          <div className="example-article">
            <span>CLOUD · ARTICLE DE DÉMONSTRATION</span>
            <h4>Le cloud de demain</h4>
            <p>De nouvelles façons de travailler.</p>
            <time dateTime="2026-10-10">10 octobre 2026</time>
          </div>
          <p className="playground-label">
            <Code2 size={14} aria-hidden="true" /> Son HTML
          </p>
          <pre>
            <code>{exampleHtml}</code>
          </pre>
        </div>
        <div>
          <label htmlFor={id}>Sélecteur à l’intérieur du bloc article</label>
          <input
            id={id}
            value={selector}
            spellCheck={false}
            maxLength={300}
            onChange={(event) => setSelector(event.target.value)}
            aria-describedby={`${id}-result`}
          />
          <div className="selector-presets">
            {["h2", "h2 a.title", ".description", "time", "a[href]"].map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={selector === value}
                onClick={() => setSelector(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <div id={`${id}-result`} role="status" className="selector-result">
            <strong>
              {result.error ||
                `${result.matches.length} élément${result.matches.length > 1 ? "s" : ""} trouvé${result.matches.length > 1 ? "s" : ""}`}
            </strong>
            {result.matches.map((match, i) => (
              <pre key={i}>
                <code>{match}</code>
              </pre>
            ))}
            {!result.error && !result.matches.length && (
              <p>La syntaxe est valide, mais aucun élément de cette carte ne correspond.</p>
            )}
          </div>
          <p className="playground-hint">
            Le bloc racine <code>.article-card</code> est déjà sélectionné. Les autres champs
            cherchent à l’intérieur : utilisez <code>h2</code>, pas <code>.article-card h2</code>{" "}
            dans cet exercice.
          </p>
        </div>
      </div>
    </div>
  );
}
