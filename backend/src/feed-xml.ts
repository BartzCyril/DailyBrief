import { XMLValidator } from "fast-xml-parser";
import { AppError } from "./errors";

export function prepareFeedXml(input: string): { xml: string; warnings: string[] } {
  let xml = input.trimStart();
  const warnings: string[] = [];
  if (xml !== input) warnings.push("Les espaces ou le BOM avant le document XML ont été retirés.");
  if (!xml)
    throw new AppError(
      422,
      "Le site a renvoyé une réponse vide à la place du flux.",
      "EMPTY_RESPONSE",
    );
  if (!xml.startsWith("<"))
    throw new AppError(
      422,
      "La réponse reçue du site ne commence pas par un document XML. Vérifiez l'URL du flux, la réponse HTTP et les éventuels contrôles d'accès du site.",
      "NOT_XML_RESPONSE",
    );
  // Inspect markup only: HTML and declaration examples inside articles are ordinary content.
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, "");
  const beginning = markup.replace(/^(?:\s*<\?[\s\S]*?\?>)*\s*/, "");
  if (/^(?:<!DOCTYPE\s+html\b|<(?:html|head|body)\b)/i.test(beginning))
    throw new AppError(
      422,
      "Le site renvoie une page HTML au lieu d'un flux RSS ou Atom. Vérifiez l'URL du flux et les éventuels contrôles d'accès du site.",
      "HTML_NOT_FEED",
    );
  if (/<!DOCTYPE|<!ENTITY/i.test(markup))
    throw new AppError(
      422,
      "Les déclarations DTD et d'entités XML ne sont pas autorisées dans les flux.",
      "UNSAFE_XML",
    );

  // Escape stray ampersands/HTML entities as literal XML text, preserving CDATA and comments.
  // Tag structure is never repaired, and declared entities are never resolved.
  const escaped = xml.replace(
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g,
    (match) => (match === "&" ? "&amp;" : match),
  );
  if (escaped !== xml)
    warnings.push("Les esperluettes et entités HTML non échappées ont été normalisées.");
  xml = escaped;
  const validation = XMLValidator.validate(xml);
  if (validation !== true)
    throw new AppError(
      422,
      `XML invalide à la ligne ${validation.err.line}, colonne ${validation.err.col} (${validation.err.code}). Le flux est incomplet ou ses balises sont mal formées.`,
      "INVALID_FEED",
    );
  return { xml, warnings };
}
