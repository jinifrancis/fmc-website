export interface Announcement {
  id: string;
  title_ml: string;
  title_en: string | null;
  content_ml: string;
  content_en: string | null;
  image_url: string | null;
  link_url: string | null;
  link_text_ml: string | null;
  link_text_en: string | null;
  badge_type: string;
  date: string | null;
  published: boolean;
  created_at: string;
}

const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}

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

export async function fetchAndRenderAnnouncements(
  grid: HTMLElement,
  lang: string,
  t: (key: string) => string,
  options?: { limit?: number; emptyEl?: HTMLElement | null },
): Promise<void> {
  const { supabase } = await import('./supabase');
  const limit = options?.limit;
  const emptyEl = options?.emptyEl;

  try {
    let query = supabase
      .from('announcements')
      .select('id, title_ml, title_en, content_ml, content_en, image_url, badge_type, date, link_url, link_text_ml, link_text_en, published, created_at')
      .eq('published', true)
      .order('date', { ascending: false });

    if (limit) query = query.limit(limit);

    const { data, error } = await query;

    if (error || !data || data.length === 0) {
      grid.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'block';
      return;
    }

    grid.innerHTML = data.map(item => makeCard(item, lang, t)).join('');
  } catch {
    grid.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'block';
  }
}

export function initCardOverflow(grid: HTMLElement): void {
  grid.querySelectorAll<HTMLElement>('.news-card').forEach(card => {
    const check = () => {
      card.classList.toggle('has-overflow', card.scrollHeight > card.clientHeight && card.scrollTop + card.clientHeight < card.scrollHeight - 4);
    };
    check();
    card.addEventListener('scroll', check);
  });
}

export function makeCard(item: Announcement, lang: string, t: (key: string) => string): string {
  const title = escapeHtml(String(lang === 'ml' ? item.title_ml : (item.title_en || item.title_ml)));
  const content = String(lang === 'ml' ? item.content_ml : (item.content_en || item.content_ml));
  const date = formatDate(item.date as string, lang);
  const badge = escapeHtml(String(item.badge_type ?? ''));
  const imageUrl = item.image_url ? escapeHtml(String(item.image_url)) : null;

  const imgHtml = imageUrl
    ? `<div class="news-img"><img src="${imageUrl}" alt="${title}" loading="lazy"></div>`
    : '';

  const linkUrl = item.link_url ? escapeHtml(String(item.link_url)) : null;
  const linkText = escapeHtml(String(lang === 'ml' ? item.link_text_ml : (item.link_text_en || item.link_text_ml) || ''));

  const paragraphs = (content || '')
    .split('\n')
    .filter(Boolean)
    .map((p: string) => `<p class="news-excerpt">${escapeHtml(p)}</p>`)
    .join('');

  const linkHtml = linkUrl
    ? `<div class="news-cta"><a href="${linkUrl}" class="news-link">${linkText}</a></div>`
    : '';

  return `
    <article class="news-card">
      ${imgHtml}
      <div class="${BADGE_CLASSES[badge] ?? 'news-badge'}">${escapeHtml(t('badge.' + badge) ?? badge)}</div>
      <h3 class="news-title">${title}</h3>
      <p class="news-date">${date}</p>
      ${paragraphs}
      ${linkHtml}
    </article>
  `;
}
