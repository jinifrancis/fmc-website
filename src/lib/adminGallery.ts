import { supabase } from './supabase';
import { escapeHtml } from './newsUtils';
import type { GalleryEvent, GalleryPhoto } from './galleryUtils';
import { batchSignPaths } from './galleryUtils';
import {
  MB,
  getEl,
  getCurrentUserId,
  showAlert,
  hideAlert,
  flashSuccess,
  formatDateDisplay,
  statusPillHtml,
  registerModal,
} from './adminShared';

const MAX_GALLERY_PHOTO_BYTES = 10 * MB;
const MAX_PHOTOS_PER_EVENT = 20;   // keep in sync with the gallery_photos DB trigger

// State
let galleryEditingEventId: number | null = null;
let galleryDeleteTargetEventId: number | null = null;
let galleryDeleteTargetPhotoId: number | null = null;
let activeEventSlug: string | null = null;
let activeEventId: number | null = null;
let galleryUploadedPaths: string[] = [];
let galleryTriggerEl: HTMLElement | null = null;

async function deleteGalleryStoragePath(path: string | null) {
  if (!path) return;
  const { error } = await supabase.storage.from('gallery').remove([path]);
  if (error) console.warn('Gallery storage cleanup failed:', error.message);
}

// Strip EXIF by drawing the image onto a canvas and re-encoding as JPEG.
// Returns a new Blob with no metadata. Falls back to the original file if
// the canvas API is unavailable (e.g. in tests or very old browsers).
async function stripExif(file: File): Promise<Blob> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(file); return; }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(
          (blob) => resolve(blob ?? file),
          'image/jpeg',
          0.92,
        );
      } catch {
        resolve(file);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

async function loadGalleryEvents() {
  const list = getEl<HTMLDivElement>('gallery-event-list');
  const dashError = getEl<HTMLDivElement>('gallery-dash-error');

  hideAlert(dashError);
  list.innerHTML = '<div class="empty-state"><h3>Loading…</h3></div>';

  const { data, error } = await supabase
    .from('gallery_events')
    .select('id, slug, title_ml, title_en, event_date, published, created_at')
    .is('deleted_at', null)
    .order('event_date', { ascending: false });

  if (error) {
    showAlert(dashError, 'Failed to load gallery events: ' + error.message);
    list.innerHTML = '';
    return;
  }

  if (!data || data.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <h3>No gallery events yet</h3>
        <p>Click "New Event" to create your first photo album.</p>
      </div>`;
    return;
  }

  const events = data as GalleryEvent[];
  list.innerHTML = events.map((evt) => {
    const dateLabel = evt.event_date ? formatDateDisplay(evt.event_date) : 'No date';
    return `
      <div class="ann-item">
        <div class="ann-item-info">
          <div class="ann-item-title">${escapeHtml(String(evt.title_ml ?? '(No title)'))}</div>
          <div class="ann-item-meta">
            ${statusPillHtml(evt.published)}
            <span>${dateLabel}</span>
            ${evt.title_en ? `<span>· EN: ${escapeHtml(String(evt.title_en))}</span>` : ''}
          </div>
        </div>
        <div class="ann-item-actions">
          <button class="btn-ghost btn-sm" data-gallery-edit="${evt.id}">Edit</button>
          <button class="btn-ghost btn-sm" data-gallery-photos="${evt.id}" data-gallery-slug="${escapeHtml(String(evt.slug))}">Photos</button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-gallery-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn instanceof HTMLElement ? btn.dataset.galleryEdit : null;
      if (!id) return;
      const evt = events.find((e) => String(e.id) === id);
      if (evt) openGalleryEventModal(evt);
    });
  });

  list.querySelectorAll('[data-gallery-photos]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!(btn instanceof HTMLElement)) return;
      const id = btn.dataset.galleryPhotos ? parseInt(btn.dataset.galleryPhotos, 10) : null;
      const slug = btn.dataset.gallerySlug || '';
      const evt = events.find((e) => e.id === id);
      if (id && slug) openPhotoManager(id, slug, String(evt?.title_ml || evt?.title_en || slug));
    });
  });
}

function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// Generates a URL-safe slug from the title and appends -2, -3, … if needed.
async function generateUniqueSlug(title: string): Promise<string> {
  const base = toSlug(title) || 'event';
  const { data } = await supabase
    .from('gallery_events')
    .select('slug')
    .like('slug', `${base}%`);
  const taken = new Set((data ?? []).map((r: { slug: string }) => r.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function setFieldError(inputId: string, message: string) {
  const errorEl = document.getElementById(`${inputId}-error`);
  const input = document.getElementById(inputId);
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.add('visible');
  }
  if (input) {
    input.closest('.form-row')?.classList.add('has-error');
  }
}

function clearFieldErrors() {
  document.querySelectorAll('.field-error.visible').forEach(el => {
    el.textContent = '';
    el.classList.remove('visible');
  });
  document.querySelectorAll('.form-row.has-error').forEach(el => {
    el.classList.remove('has-error');
  });
}

function clearFieldError(inputId: string) {
  const errorEl = document.getElementById(`${inputId}-error`);
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.remove('visible');
  }
  document.getElementById(inputId)?.closest('.form-row')?.classList.remove('has-error');
}

function updateCharCount(inputId: string, countId: string) {
  const input = getEl<HTMLInputElement>(inputId);
  const counter = getEl<HTMLElement>(countId);
  const max = input.maxLength > 0 ? input.maxLength : 100;
  counter.textContent = `${input.value.length}/${max}`;
}

function resetGalleryEventForm() {
  clearFieldErrors();
  getEl<HTMLInputElement>('ge-title-ml').value = '';
  getEl<HTMLInputElement>('ge-title-en').value = '';
  getEl<HTMLInputElement>('ge-date').value = new Date().toISOString().slice(0, 10);
  getEl<HTMLInputElement>('ge-published').checked = false;
  hideAlert(getEl<HTMLDivElement>('ge-form-error'));
}

function openGalleryEventModal(evt?: GalleryEvent) {
  const modal = getEl<HTMLDivElement>('gallery-event-modal');
  const modalTitle = getEl<HTMLHeadingElement>('ge-modal-title');
  const btnDelete = getEl<HTMLButtonElement>('ge-btn-delete');

  galleryTriggerEl = document.activeElement as HTMLElement | null;
  resetGalleryEventForm();

  if (evt) {
    galleryEditingEventId = evt.id;
    modalTitle.textContent = 'Edit Event';
    btnDelete.style.display = 'inline-block';
    getEl<HTMLInputElement>('ge-title-ml').value = evt.title_ml ?? '';
    getEl<HTMLInputElement>('ge-title-en').value = evt.title_en ?? '';
    getEl<HTMLInputElement>('ge-date').value = evt.event_date ?? '';
    getEl<HTMLInputElement>('ge-published').checked = evt.published ?? false;
  } else {
    galleryEditingEventId = null;
    modalTitle.textContent = 'New Event';
    btnDelete.style.display = 'none';
  }

  updateCharCount('ge-title-en', 'ge-title-en-count');
  updateCharCount('ge-title-ml', 'ge-title-ml-count');

  modal.classList.add('open');
  getEl<HTMLInputElement>('ge-title-en').focus();
}

function closeGalleryEventModal() {
  getEl<HTMLDivElement>('gallery-event-modal').classList.remove('open');
  galleryEditingEventId = null;
  if (galleryTriggerEl) { galleryTriggerEl.focus(); galleryTriggerEl = null; }
}

async function saveGalleryEvent() {
  const titleMl = (getEl<HTMLInputElement>('ge-title-ml').value ?? '').trim();
  const titleEn = (getEl<HTMLInputElement>('ge-title-en').value ?? '').trim();
  const date = (getEl<HTMLInputElement>('ge-date').value ?? '').trim();
  const published = getEl<HTMLInputElement>('ge-published').checked;
  const formError = getEl<HTMLDivElement>('ge-form-error');
  const btnSave = getEl<HTMLButtonElement>('ge-btn-save');
  const dashSuccess = getEl<HTMLDivElement>('gallery-dash-success');

  hideAlert(formError);
  clearFieldErrors();

  let hasError = false;
  let firstErrorField: HTMLElement | null = null;

  if (!titleEn) {
    setFieldError('ge-title-en', 'English title is required.');
    hasError = true;
    firstErrorField = firstErrorField || getEl('ge-title-en');
  }
  if (!titleMl) {
    setFieldError('ge-title-ml', 'Malayalam title is required.');
    hasError = true;
    firstErrorField = firstErrorField || getEl('ge-title-ml');
  }

  if (hasError) {
    if (firstErrorField) firstErrorField.focus();
    return;
  }

  const userId = await getCurrentUserId();

  btnSave.disabled = true;

  let error;
  if (galleryEditingEventId) {
    ({ error } = await supabase
      .from('gallery_events')
      .update({ title_ml: titleMl, title_en: titleEn, event_date: date || null, published, updater_uid: userId })
      .eq('id', galleryEditingEventId));
  } else {
    // Auto-generate a unique slug from the English title; never shown in the UI.
    const slug = await generateUniqueSlug(titleEn);
    ({ error } = await supabase
      .from('gallery_events')
      .insert({ slug, title_ml: titleMl, title_en: titleEn, event_date: date || null, published, creator_uid: userId }));
  }

  btnSave.disabled = false;

  if (error) {
    showAlert(formError, 'Save failed: ' + error.message);
    return;
  }

  const isEdit = !!galleryEditingEventId;
  closeGalleryEventModal();
  flashSuccess(dashSuccess, isEdit ? 'Event updated.' : 'Event created.');
  await loadGalleryEvents();
}

async function openPhotoManager(eventId: number, slug: string, title: string) {
  activeEventId = eventId;
  activeEventSlug = slug;
  galleryUploadedPaths = [];

  const eventListView = getEl<HTMLDivElement>('gallery-event-list-view');
  const photoView = getEl<HTMLDivElement>('gallery-photo-view');
  const photoViewTitle = getEl<HTMLHeadingElement>('gallery-photo-view-title');

  eventListView.style.display = 'none';
  photoView.style.display = 'block';
  photoViewTitle.textContent = `Photos — ${title}`;

  await loadPhotos(eventId);
}

function closePhotoManager() {
  for (const path of galleryUploadedPaths) {
    void deleteGalleryStoragePath(path);
  }
  galleryUploadedPaths = [];
  activeEventId = null;
  activeEventSlug = null;

  getEl<HTMLDivElement>('gallery-photo-view').style.display = 'none';
  getEl<HTMLDivElement>('gallery-event-list-view').style.display = 'block';
}

async function loadPhotos(eventId: number) {
  const photoList = getEl<HTMLDivElement>('gallery-photo-list');
  const photoError = getEl<HTMLDivElement>('gallery-photo-error');

  hideAlert(photoError);
  photoList.innerHTML = '<div class="empty-state"><h3>Loading…</h3></div>';

  const { data: photos, error } = await supabase
    .from('gallery_photos')
    .select('id, event_id, storage_path, sort_order')
    .eq('event_id', eventId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    showAlert(photoError, 'Failed to load photos: ' + error.message);
    photoList.innerHTML = '';
    return;
  }

  if (!photos || photos.length === 0) {
    photoList.innerHTML = '<div class="empty-state"><h3>No photos yet</h3><p>Use the upload area below to add photos.</p></div>';
    return;
  }

  const list = photos as GalleryPhoto[];

  const { data: ev } = await supabase
    .from('gallery_events')
    .select('cover_path')
    .eq('id', eventId)
    .single();
  const coverPath = ev?.cover_path ?? null;

  // Sign all paths for preview (one batch round-trip, shared with the public side).
  const urlMap = await batchSignPaths(list.map(p => p.storage_path));

  photoList.innerHTML = list.map(photo => {
    const url = urlMap.get(photo.storage_path) || '';
    const isCover = photo.storage_path === coverPath;
    const coverBtn = isCover
      ? `<button class="btn-ghost btn-sm" disabled>★ Cover</button>`
      : `<button class="btn-ghost btn-sm" data-set-cover="${photo.id}">Set as cover</button>`;
    return `
      <div class="gallery-photo-item" data-photo-id="${photo.id}" data-photo-path="${escapeHtml(photo.storage_path)}">
        <div class="gallery-photo-thumb">
          ${isCover ? '<span class="gallery-cover-badge">Cover</span>' : ''}
          ${url ? `<img src="${escapeHtml(url)}" alt="">` : '<span class="gallery-thumb-placeholder">&#10022;</span>'}
        </div>
        <div class="gallery-photo-actions">
          ${coverBtn}
          <button class="btn-danger btn-sm" data-delete-photo="${photo.id}">Delete</button>
        </div>
      </div>`;
  }).join('');

  photoList.querySelectorAll('[data-set-cover]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!(btn instanceof HTMLElement)) return;
      const photoId = parseInt(btn.dataset.setCover || '0', 10);
      const item = list.find(p => p.id === photoId);
      if (item) setCoverPhoto(item.storage_path);
    });
  });

  photoList.querySelectorAll('[data-delete-photo]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!(btn instanceof HTMLElement)) return;
      const photoId = parseInt(btn.dataset.deletePhoto || '0', 10);
      const item = list.find(p => p.id === photoId);
      if (item) confirmDeletePhoto(item);
    });
  });
}

async function setCoverPhoto(storagePath: string) {
  if (!activeEventId || !activeEventSlug) return;
  const dashSuccess = getEl<HTMLDivElement>('gallery-dash-success');
  const photoError = getEl<HTMLDivElement>('gallery-photo-error');

  const userId = await getCurrentUserId();

  const { error } = await supabase
    .from('gallery_events')
    .update({ cover_path: storagePath, updater_uid: userId })
    .eq('id', activeEventId);

  if (error) {
    showAlert(photoError, 'Failed to set cover: ' + error.message);
    return;
  }

  flashSuccess(dashSuccess, 'Cover photo updated.');
  await loadPhotos(activeEventId);
}

async function handlePhotoUpload(files: FileList) {
  const photoError = getEl<HTMLDivElement>('gallery-photo-error');
  const uploadProgress = getEl<HTMLParagraphElement>('gallery-upload-progress');
  const dashSuccess = getEl<HTMLDivElement>('gallery-dash-success');

  if (!activeEventId || !activeEventSlug) return;

  hideAlert(photoError);
  hideAlert(dashSuccess);

  // All allowed types are re-encoded to JPEG via canvas (stripExif) before upload.
  const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

  const validFiles = Array.from(files).filter(f => {
    if (f.size > MAX_GALLERY_PHOTO_BYTES) { showAlert(photoError, `${f.name} is too large (max ${MAX_GALLERY_PHOTO_BYTES / MB} MB).`); return false; }
    if (!ALLOWED_TYPES.has(f.type)) { showAlert(photoError, `${f.name}: only JPG, PNG, WebP allowed.`); return false; }
    return true;
  });

  if (validFiles.length === 0) return;

  // Enforce the per-event photo cap. This is a UX guard; the DB trigger is the
  // real limit, so keep MAX_PHOTOS_PER_EVENT in sync with it. Reject the whole
  // batch if it would exceed, so the upload is all-or-nothing.
  const { count: existingCount, error: countError } = await supabase
    .from('gallery_photos')
    .select('*', { count: 'exact', head: true })
    .eq('event_id', activeEventId);

  if (countError) {
    showAlert(photoError, 'Could not verify photo count: ' + countError.message);
    return;
  }

  const current = existingCount ?? 0;
  const remaining = MAX_PHOTOS_PER_EVENT - current;
  if (validFiles.length > remaining) {
    showAlert(photoError, remaining <= 0
      ? `This event already has the maximum of ${MAX_PHOTOS_PER_EVENT} photos.`
      : `This event has ${current}/${MAX_PHOTOS_PER_EVENT} photos — you can add ${remaining} more, but you selected ${validFiles.length}.`);
    return;
  }

  uploadProgress.style.display = 'block';
  let uploaded = 0;

  const { data: lastPhoto } = await supabase
    .from('gallery_photos')
    .select('sort_order')
    .eq('event_id', activeEventId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const baseOrder = (lastPhoto?.sort_order ?? -1) + 1;

  for (const file of validFiles) {
    uploadProgress.textContent = `Uploading ${uploaded + 1} of ${validFiles.length}…`;

    // Strip EXIF via canvas re-encode (normally yields a JPEG). If stripExif fell
    // back to the original file, match the path + content-type to the real blob.
    const cleanBlob = await stripExif(file);
    const blobType = cleanBlob.type || 'image/jpeg';
    const ext = blobType === 'image/png' ? 'png' : blobType === 'image/webp' ? 'webp' : 'jpg';
    const path = `${activeEventSlug}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('gallery')
      .upload(path, cleanBlob, { contentType: blobType, cacheControl: '3600', upsert: false });

    if (uploadError) {
      showAlert(photoError, `Upload failed for ${file.name}: ${uploadError.message}`);
      continue;
    }

    // Track for orphan cleanup if the user navigates away without saving
    galleryUploadedPaths.push(path);

    const nextOrder = baseOrder + uploaded;
    const { error: insertError } = await supabase
      .from('gallery_photos')
      .insert({ event_id: activeEventId, storage_path: path, sort_order: nextOrder });

    if (insertError) {
      showAlert(photoError, `DB insert failed for ${file.name}: ${insertError.message}`);
      void deleteGalleryStoragePath(path);
      galleryUploadedPaths = galleryUploadedPaths.filter(p => p !== path);
      continue;
    }

    // Photo is now persisted — remove from orphan list
    galleryUploadedPaths = galleryUploadedPaths.filter(p => p !== path);
    uploaded++;
  }

  uploadProgress.style.display = 'none';

  if (uploaded > 0) {
    flashSuccess(dashSuccess, `${uploaded} photo${uploaded === 1 ? '' : 's'} uploaded.`);
    await loadPhotos(activeEventId!);
  }
}

function confirmDeletePhoto(photo: GalleryPhoto) {
  galleryDeleteTargetPhotoId = photo.id;
  const modal = getEl<HTMLDivElement>('gallery-confirm-photo-modal');
  modal.classList.add('open');
  getEl<HTMLButtonElement>('gallery-confirm-photo-cancel').focus();
}

function confirmDeleteEvent(eventId: number) {
  galleryDeleteTargetEventId = eventId;
  const modal = getEl<HTMLDivElement>('gallery-confirm-event-modal');
  modal.classList.add('open');
  getEl<HTMLButtonElement>('gallery-confirm-event-cancel').focus();
}

export function initGalleryAdmin() {
  const tabAnn = getEl<HTMLButtonElement>('tab-announcements');
  const tabGallery = getEl<HTMLButtonElement>('tab-gallery');
  const sectionAnn = getEl<HTMLDivElement>('section-announcements');
  const sectionGallery = getEl<HTMLDivElement>('section-gallery');

  tabAnn.addEventListener('click', () => {
    tabAnn.classList.add('tab-active');
    tabGallery.classList.remove('tab-active');
    sectionAnn.style.display = 'block';
    sectionGallery.style.display = 'none';
  });

  tabGallery.addEventListener('click', () => {
    tabGallery.classList.add('tab-active');
    tabAnn.classList.remove('tab-active');
    sectionGallery.style.display = 'block';
    sectionAnn.style.display = 'none';
    loadGalleryEvents();
  });

  getEl<HTMLButtonElement>('btn-new-gallery-event').addEventListener('click', () => openGalleryEventModal());

  getEl<HTMLInputElement>('ge-title-en').addEventListener('input', () => {
    updateCharCount('ge-title-en', 'ge-title-en-count');
    clearFieldError('ge-title-en');
  });

  getEl<HTMLInputElement>('ge-title-ml').addEventListener('input', () => {
    updateCharCount('ge-title-ml', 'ge-title-ml-count');
    clearFieldError('ge-title-ml');
  });

  const galleryEventModal = getEl<HTMLDivElement>('gallery-event-modal');
  getEl<HTMLButtonElement>('ge-modal-close').addEventListener('click', closeGalleryEventModal);
  getEl<HTMLButtonElement>('ge-modal-close-cancel').addEventListener('click', closeGalleryEventModal);
  registerModal(galleryEventModal, closeGalleryEventModal, 0);
  getEl<HTMLButtonElement>('ge-btn-save').addEventListener('click', saveGalleryEvent);
  getEl<HTMLButtonElement>('ge-btn-delete').addEventListener('click', () => {
    if (galleryEditingEventId) confirmDeleteEvent(galleryEditingEventId);
  });

  // Back from photo manager
  getEl<HTMLButtonElement>('gallery-back-btn').addEventListener('click', closePhotoManager);

  // Photo upload
  const photoFileInput = getEl<HTMLInputElement>('gallery-photo-file');
  photoFileInput.addEventListener('change', () => {
    if (photoFileInput.files && photoFileInput.files.length > 0) {
      handlePhotoUpload(photoFileInput.files).then(() => { photoFileInput.value = ''; });
    }
  });

  // Confirm delete photo modal
  const confirmPhotoModal = getEl<HTMLDivElement>('gallery-confirm-photo-modal');
  const closePhotoConfirm = () => {
    galleryDeleteTargetPhotoId = null;
    confirmPhotoModal.classList.remove('open');
  };
  getEl<HTMLButtonElement>('gallery-confirm-photo-cancel').addEventListener('click', closePhotoConfirm);
  getEl<HTMLButtonElement>('gallery-confirm-photo-delete').addEventListener('click', async () => {
    if (!galleryDeleteTargetPhotoId || !activeEventId || !activeEventSlug) return;
    const dashSuccess = getEl<HTMLDivElement>('gallery-dash-success');
    const photoError = getEl<HTMLDivElement>('gallery-photo-error');

    // Find the storage_path before deleting the row
    const { data: photoRow } = await supabase
      .from('gallery_photos')
      .select('storage_path')
      .eq('id', galleryDeleteTargetPhotoId)
      .single();

    const { error } = await supabase
      .from('gallery_photos')
      .delete()
      .eq('id', galleryDeleteTargetPhotoId);

    confirmPhotoModal.classList.remove('open');

    if (error) {
      showAlert(photoError, 'Delete failed: ' + error.message);
      galleryDeleteTargetPhotoId = null;
      return;
    }

    // Remove from storage after DB row is gone
    if (photoRow?.storage_path) {
      await supabase
        .from('gallery_events')
        .update({ cover_path: null })
        .eq('id', activeEventId)
        .eq('cover_path', photoRow.storage_path);
      void deleteGalleryStoragePath(photoRow.storage_path);
    }

    galleryDeleteTargetPhotoId = null;
    flashSuccess(dashSuccess, 'Photo deleted.');
    await loadPhotos(activeEventId!);
  });
  registerModal(confirmPhotoModal, closePhotoConfirm, 1);

  const confirmEventModal = getEl<HTMLDivElement>('gallery-confirm-event-modal');
  const closeEventConfirm = () => {
    galleryDeleteTargetEventId = null;
    confirmEventModal.classList.remove('open');
  };
  getEl<HTMLButtonElement>('gallery-confirm-event-cancel').addEventListener('click', closeEventConfirm);
  getEl<HTMLButtonElement>('gallery-confirm-event-delete').addEventListener('click', async () => {
    if (!galleryDeleteTargetEventId) return;
    const dashSuccess = getEl<HTMLDivElement>('gallery-dash-success');
    const dashError = getEl<HTMLDivElement>('gallery-dash-error');

    const userId = await getCurrentUserId();

    const { error } = await supabase
      .from('gallery_events')
      .update({ deleted_at: new Date().toISOString(), deleter_uid: userId })
      .eq('id', galleryDeleteTargetEventId);

    confirmEventModal.classList.remove('open');
    galleryDeleteTargetEventId = null;

    if (error) {
      showAlert(dashError, 'Delete failed: ' + error.message);
      return;
    }

    closeGalleryEventModal();
    flashSuccess(dashSuccess, 'Event deleted.');
    await loadGalleryEvents();
  });
  registerModal(confirmEventModal, closeEventConfirm, 1);
}
