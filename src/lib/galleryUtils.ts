import { escapeHtml, formatDate } from './newsUtils';
import { useTranslations } from '../i18n/utils';

export const SIGNED_URL_EXPIRY_SECONDS = 3_600; // 1 hour

export interface GalleryEvent {
  id: number;
  slug: string;
  title_ml: string;
  title_en: string;
  event_date: string | null;
  published: boolean;
  cover_path: string | null;
  created_at: string;
}

export interface GalleryPhoto {
  id: number;
  event_id: number;
  storage_path: string;
  sort_order: number;
}

// Signs a batch of storage paths in one request. Returns a map of path → signed URL.
// Paths that fail to sign are omitted from the result.
export async function batchSignPaths(paths: string[]): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const { supabase } = await import('./supabase');
  const { data, error } = await supabase.storage
    .from('gallery')
    .createSignedUrls(paths, SIGNED_URL_EXPIRY_SECONDS);

  const map = new Map<string, string>();
  if (error || !data) return map;
  for (const item of data) {
    if (item.signedUrl && item.path) {
      map.set(item.path, item.signedUrl);
    }
  }
  return map;
}

// Signs a single storage path and returns its URL, or null if signing fails.
// Call this when opening the lightbox to refresh an expiring URL.
export async function createSignedUrl(storagePath: string): Promise<string | null> {
  const { supabase } = await import('./supabase');
  const { data, error } = await supabase.storage
    .from('gallery')
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

// Fetches all published gallery events, finds the first photo of each event
// to use as a thumbnail, signs those paths in one batch, then renders event cards.
export async function fetchAndRenderGalleryEvents(
  grid: HTMLElement,
  lang: string,
  emptyEl?: HTMLElement | null,
): Promise<void> {
  const { supabase } = await import('./supabase');

  try {
    const { data, error } = await supabase
      .from('gallery_events')
      .select('id, slug, title_ml, title_en, event_date, published, cover_path, created_at')
      .eq('published', true)
      .is('deleted_at', null)
      .order('event_date', { ascending: false });

    if (error) {
      console.error('[gallery] failed to load events:', error.message);
      grid.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'block';
      return;
    }

    if (!data || data.length === 0) {
      grid.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'block';
      return;
    }

    const events = data as GalleryEvent[];

    // Thumbnail per event: use the admin-chosen cover_path when set, otherwise
    // fall back to the event's first photo (lowest sort_order).
    const thumbMap = new Map<number, string>();
    for (const event of events) {
      if (event.cover_path) thumbMap.set(event.id, event.cover_path);
    }

    // Fetch first photos only to fill events that have no explicit cover.
    const eventIds = events.map(e => e.id);
    const { data: firstPhotos, error: firstPhotosError } = await supabase
      .from('gallery_photos')
      .select('event_id, storage_path, sort_order')
      .in('event_id', eventIds)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });

    if (firstPhotosError) {
      // Non-fatal: cards still render with placeholders. Surface the cause.
      console.error('[gallery] failed to load cover photos:', firstPhotosError.message);
    }

    if (firstPhotos) {
      for (const photo of firstPhotos) {
        if (!thumbMap.has(photo.event_id)) {
          thumbMap.set(photo.event_id, photo.storage_path);
        }
      }
    }

    // Batch-sign all thumbnail paths in one round trip.
    const thumbPaths = [...thumbMap.values()];
    const signedMap = await batchSignPaths(thumbPaths);

    grid.innerHTML = events.map(event => makeEventCard(event, lang, signedMap, thumbMap)).join('');
  } catch (err) {
    console.error('[gallery] unexpected error loading events:', err);
    grid.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'block';
  }
}

export function makeEventCard(
  event: GalleryEvent,
  lang: string,
  signedMap: Map<string, string>,
  thumbMap: Map<number, string>,
): string {
  const title = escapeHtml(String(lang === 'ml' ? event.title_ml : (event.title_en || event.title_ml)));
  const date = event.event_date ? formatDate(event.event_date, lang) : '';

  // Use the first photo (from thumbMap) as the card thumbnail.
  const thumbPath = thumbMap.get(event.id);
  const signedThumb = thumbPath ? signedMap.get(thumbPath) : null;
  const coverHtml = signedThumb
    ? `<div class="gallery-card-img"><img src="${escapeHtml(signedThumb)}" alt="${title}" loading="lazy"></div>`
    : `<div class="gallery-card-img gallery-card-img--placeholder"><span>&#10022;</span></div>`;

  return `
    <button class="gallery-card"
      data-slug="${escapeHtml(event.slug)}"
      data-title="${title}"
      data-date="${escapeHtml(date)}">
      ${coverHtml}
      <div class="gallery-card-body">
        <h3 class="gallery-card-title">${title}</h3>
        ${date ? `<p class="gallery-card-date">${date}</p>` : ''}
      </div>
    </button>
  `;
}

// Fetches photos for one event by slug, signs all URLs in one batch,
// then renders thumbnail tiles. Each tile carries data-path (for re-signing) and
// data-url (the already-signed URL) so the lightbox can reuse them without extra fetches.
export async function fetchAndRenderGalleryPhotos(
  grid: HTMLElement,
  slug: string,
  lang: string,
  emptyEl?: HTMLElement | null,
): Promise<void> {
  const { supabase } = await import('./supabase');
  const t = useTranslations(lang);

  try {
    // Resolve the event id from the slug (also enforces published + not-deleted).
    const { data: eventData, error: eventError } = await supabase
      .from('gallery_events')
      .select('id')
      .eq('slug', slug)
      .eq('published', true)
      .is('deleted_at', null)
      .single();

    if (eventError || !eventData) {
      // PGRST116 = no matching row (unknown/unpublished slug) — a normal empty case,
      // not a failure. Log anything else (e.g. a schema/RLS error).
      if (eventError && eventError.code !== 'PGRST116') {
        console.error('[gallery] failed to load event:', eventError.message);
      }
      grid.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'block';
      return;
    }

    // Then fetch the photos for this event.
    const { data: photos, error: photosError } = await supabase
      .from('gallery_photos')
      .select('id, event_id, storage_path, sort_order')
      .eq('event_id', eventData.id)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });

    if (photosError) {
      console.error('[gallery] failed to load photos:', photosError.message);
      grid.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'block';
      return;
    }

    if (!photos || photos.length === 0) {
      grid.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'block';
      return;
    }

    // Sign all photo paths in one round trip.
    const paths = (photos as GalleryPhoto[]).map(p => p.storage_path);
    const signedMap = await batchSignPaths(paths);

    grid.innerHTML = (photos as GalleryPhoto[]).map((photo, index) => {
      const signedUrl = signedMap.get(photo.storage_path) || '';
      const escapedPath = escapeHtml(photo.storage_path);
      const escapedUrl = escapeHtml(signedUrl);
      const label = `${escapeHtml(t('gallery.photo'))} ${index + 1}`;

      return `
        <button
          class="gallery-thumb"
          data-index="${index}"
          data-path="${escapedPath}"
          data-url="${escapedUrl}"
          aria-label="${label}"
        >
          ${signedUrl
            ? `<img src="${escapedUrl}" alt="${label}" loading="lazy">`
            : `<span class="gallery-thumb-placeholder">&#10022;</span>`
          }
        </button>
      `;
    }).join('');
  } catch (err) {
    console.error('[gallery] unexpected error loading photos:', err);
    grid.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'block';
  }
}
