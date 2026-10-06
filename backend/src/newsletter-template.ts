export type NewsletterItem = { title: string; summary: string; keyPoints: string[]; url: string | null; source: string; publishedAt: Date | null };
export function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
export function renderNewsletter(items: NewsletterItem[], timezone: string, now = new Date()) {
  const date = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: timezone }).format(now);
  const subject = `DailyBrief — Votre résumé du ${date}`;
  const html = `<!doctype html><html lang="fr"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#0f172a"><table role="presentation" width="100%"><tr><td style="padding:24px"><table role="presentation" style="max-width:640px;width:100%;margin:auto;background:#fff;border-radius:12px"><tr><td style="padding:28px"><h1>DailyBrief</h1><p>Votre résumé du ${escapeHtml(date)}</p>${items.map(item => {
    let url: string | null = null; try { const parsed = new URL(item.url ?? ""); if (["http:", "https:"].includes(parsed.protocol)) url = parsed.href; } catch { /* no original link */ }
    return `<article style="border-top:1px solid #e2e8f0;padding:20px 0"><h2 style="font-size:20px">${escapeHtml(item.title)}</h2><p style="line-height:1.6">${escapeHtml(item.summary)}</p><ul>${item.keyPoints.map(point => `<li style="padding:4px 0">${escapeHtml(point)}</li>`).join("")}</ul>${url ? `<a href="${escapeHtml(url)}">Lire l'article original</a>` : ""}<p style="font-size:12px;color:#64748b">Source : ${escapeHtml(item.source)}${item.publishedAt ? ` · ${escapeHtml(new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeZone: timezone }).format(item.publishedAt))}` : ""}</p></article>`;
  }).join("")}</td></tr></table></td></tr></table></body></html>`;
  const text = `DailyBrief\nVotre résumé du ${date}\n\n${items.map(item => `${item.title}\n\n${item.summary}\n\n${item.keyPoints.map(point => `• ${point}`).join("\n")}\n${item.url ?? ""}\nSource : ${item.source}`).join("\n\n---\n\n")}`;
  return { subject, html, text };
}
