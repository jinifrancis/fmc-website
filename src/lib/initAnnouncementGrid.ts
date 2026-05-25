import { useTranslations } from '../i18n/utils';
import { fetchAndRenderAnnouncements, initCardOverflow } from './newsUtils';

export function initAnnouncementGrid(gridId: string, emptyId: string, limit?: number) {
  const grid = document.getElementById(gridId);
  const emptyMsg = document.getElementById(emptyId);
  if (!grid) return;
  const lang = grid.dataset.lang || 'ml';
  const t = useTranslations(lang);
  fetchAndRenderAnnouncements(grid, lang, t, { limit, emptyEl: emptyMsg })
    .then(() => initCardOverflow(grid));
}
