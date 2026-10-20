import type { BriefStory, DailyBriefContent } from "@dailybrief/shared";

export type NewsletterArticle = { id: string; title: string; url: string | null };
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}
function publicLink(value: string | null): string | null {
  try {
    const url = new URL(value ?? "");
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** The email contains the saved editorial synthesis, never concatenated article summaries. */
export function renderNewsletter(
  brief: { date: string; content: DailyBriefContent },
  articles: NewsletterArticle[],
) {
  const date = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${brief.date}T12:00:00Z`),
  );
  const { content } = brief;
  const references = new Map(articles.map((article) => [article.id, article]));
  const links = (story: BriefStory) =>
    [...new Set(story.articleIds)].flatMap((id) => {
      const article = references.get(id);
      const url = article && publicLink(article.url);
      return article && url ? [{ title: article.title, url }] : [];
    });
  const storyHtml = (story: BriefStory) => {
    const sources = links(story);
    return `<li style="padding:12px 0"><h3 style="margin:0 0 8px;font-size:19px;color:#243c30">${escapeHtml(story.title)}</h3><p style="margin:0;line-height:1.7;white-space:pre-line">${escapeHtml(story.text)}</p>${sources.length ? `<p style="margin:10px 0 0;font-size:12px;line-height:1.6;color:#617266">Sources : ${sources.map((source) => `<a href="${escapeHtml(source.url)}" style="color:#365b42">${escapeHtml(source.title)}</a>`).join(" · ")}</p>` : ""}</li>`;
  };
  const storyText = (story: BriefStory, index?: number) =>
    `${index === undefined ? "• " : `${index + 1}. `}${story.title}\n${story.text}${links(story)
      .map((source) => `\nSource : ${source.title}\n${source.url}`)
      .join("")}`;
  const subject = `DailyBrief — L’essentiel de l’actualité du ${date}`;
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f8f7f2;font-family:Arial,sans-serif;color:#243c30"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:24px 12px"><table role="presentation" cellspacing="0" cellpadding="0" style="max-width:680px;width:100%;margin:auto;background:#fff;border:1px solid #dde4d9;border-radius:16px"><tr><td style="padding:28px"><p style="margin:0 0 18px;font-size:13px;letter-spacing:1px;color:#617266">DAILYBRIEF</p><h1 style="margin:0 0 8px;font-size:26px">Brief quotidien — ${escapeHtml(date)}</h1><h2 style="margin:24px 0 12px;font-size:23px">${escapeHtml(content.headline)}</h2><p style="line-height:1.7;white-space:pre-line">${escapeHtml(content.lead)}</p>${content.stories.length ? `<section><h2 style="margin:28px 0 8px;font-size:20px">À retenir aujourd’hui</h2><ol style="padding-left:24px">${content.stories.map(storyHtml).join("")}</ol></section>` : ""}${content.otherNews.length ? `<section><h2 style="margin:28px 0 8px;font-size:20px">Autres informations intéressantes</h2><ul style="padding-left:24px">${content.otherNews.map(storyHtml).join("")}</ul></section>` : ""}${content.trends ? `<section style="margin-top:24px;padding:18px;background:#eef2e6;border-radius:12px"><h2 style="margin:0 0 10px;font-size:20px">Tendances du jour</h2><p style="margin:0;line-height:1.7;white-space:pre-line">${escapeHtml(content.trends)}</p></section>` : ""}<p style="margin:28px 0 0;padding-top:18px;border-top:1px solid #dde4d9;color:#617266;font-size:12px;line-height:1.6">Le fichier Excel joint détaille les articles de cette exécution, leurs résumés et les motifs d’exclusion ou d’échec. Les résumés individuels restent disponibles dans votre tableau de bord DailyBrief.</p></td></tr></table></td></tr></table></body></html>`;
  const text = [
    `Brief quotidien — ${date}`,
    content.headline,
    content.lead,
    ...(content.stories.length ? ["À retenir aujourd’hui", ...content.stories.map(storyText)] : []),
    ...(content.otherNews.length
      ? ["Autres informations intéressantes", ...content.otherNews.map((story) => storyText(story))]
      : []),
    ...(content.trends ? ["Tendances du jour", content.trends] : []),
    "Le fichier Excel joint détaille les articles de cette exécution, leurs résumés et les motifs d’exclusion ou d’échec. Les résumés individuels restent disponibles dans votre tableau de bord DailyBrief.",
  ].join("\n\n");
  return { subject, html, text };
}
