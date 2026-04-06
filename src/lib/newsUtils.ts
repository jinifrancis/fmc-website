export type Announcement = Record<string, unknown>;

export const BADGE_CLASSES: Record<string, string> = {
  important: 'news-badge',
  success: 'news-badge news-badge-success',
  new: 'news-badge news-badge-new',
  event: 'news-badge news-badge-event',
  update: 'news-badge news-badge-update',
};

export function formatDate(dateStr: string, lang: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const locale = lang === 'ml' ? 'ml-IN' : 'en-IN';
  return '📅 ' + d.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
}

export function makeCard(item: Announcement, lang: string, t: (key: string) => string): string {
  const title = (lang === 'ml' ? item.title_ml : (item.title_en || item.title_ml)) as string;
  const content = (lang === 'ml' ? item.content_ml : (item.content_en || item.content_ml)) as string;
  const date = formatDate(item.date as string, lang);
  const badge = item.badge_type as string;
  const imageUrl = item.image_url as string | null;
  const linkUrl = item.link_url as string | null;
  const linkText = (lang === 'ml' ? item.link_text_ml : (item.link_text_en || item.link_text_ml)) as string;

  const imgHtml = imageUrl
    ? `<div class="news-img"><img src="${imageUrl}" alt="${title}" loading="lazy"></div>`
    : '';

  const paragraphs = (content || '')
    .split('\n')
    .filter(Boolean)
    .map((p: string) => `<p class="news-excerpt">${p}</p>`)
    .join('');

  const linkHtml = linkUrl
    ? `<div class="news-cta"><a href="${linkUrl}" class="news-link">${linkText}</a></div>`
    : '';

  return `
    <article class="news-card">
      ${imgHtml}
      <div class="${BADGE_CLASSES[badge] ?? 'news-badge'}">${t('badge.' + badge) ?? badge}</div>
      <h3 class="news-title">${title}</h3>
      <p class="news-date">${date}</p>
      ${paragraphs}
      ${linkHtml}
    </article>
  `;
}
