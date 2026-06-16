import { supabase } from './supabase';
import { escapeHtml, type Announcement } from './newsUtils';
import type { GalleryEvent, GalleryPhoto } from './galleryUtils';
import { batchSignPaths } from './galleryUtils';

// Configuration constants
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;   // auto-logout after 30 min idle
const SESSION_CHECK_MS = 60_000;             // re-check idle time every 60s
const ACTIVITY_PERSIST_THROTTLE_MS = 5000;   // min gap between localStorage writes
const LAST_ACTIVITY_KEY = 'adm_last_activity';
const MB = 1024 * 1024;
const MAX_ANNOUNCEMENT_IMAGE_BYTES = 5 * MB;
const MAX_GALLERY_PHOTO_BYTES = 10 * MB;
const MAX_PHOTOS_PER_EVENT = 20;
const SUCCESS_TOAST_MS = 3000;
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

let sessionInterval: ReturnType<typeof setInterval> | null = null;
let activityHandler: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;
let lastActivity = Date.now();
let lastPersist = 0;

function persistActivityNow() {
  try { localStorage.setItem(LAST_ACTIVITY_KEY, String(lastActivity)); } catch { /* storage unavailable */ }
}

// Update the in-memory timestamp on every activity (cheap), but only write to
// localStorage at most once per throttle window so frequent events (scroll)
// don't hammer storage.
function recordActivity() {
  lastActivity = Date.now();
  if (lastActivity - lastPersist > ACTIVITY_PERSIST_THROTTLE_MS) {
    lastPersist = lastActivity;
    persistActivityNow();
  }
}

function clearStoredActivity() {
  try { localStorage.removeItem(LAST_ACTIVITY_KEY); } catch { /* storage unavailable */ }
}

// True if the persisted last-activity timestamp is older than the idle timeout.
function isIdleExpired(): boolean {
  try {
    const stored = localStorage.getItem(LAST_ACTIVITY_KEY);
    return stored !== null && Date.now() - Number(stored) >= SESSION_TIMEOUT_MS;
  } catch {
    return false;
  }
}

function startSessionTimer(onExpire: () => void) {
  clearSessionTimer();
  lastActivity = Date.now();
  lastPersist = lastActivity;
  persistActivityNow();

  // Time-based idle check
  const checkIdle = () => {
    if (Date.now() - lastActivity >= SESSION_TIMEOUT_MS) {
      clearSessionTimer();
      onExpire();
    }
  };

  activityHandler = recordActivity;
  // On becoming visible, evaluate idle time immediately (covers a slept/locked
  // machine); on hide, flush the freshest timestamp before the tab is backgrounded.
  visibilityHandler = () => {
    if (document.visibilityState === 'visible') checkIdle();
    else persistActivityNow();
  };

  sessionInterval = setInterval(checkIdle, SESSION_CHECK_MS);
  document.addEventListener('click', activityHandler);
  document.addEventListener('keydown', activityHandler);
  document.addEventListener('scroll', activityHandler);
  document.addEventListener('visibilitychange', visibilityHandler);
  window.addEventListener('focus', visibilityHandler);
}

function clearSessionTimer() {
  if (sessionInterval) {
    clearInterval(sessionInterval);
    sessionInterval = null;
  }
  if (activityHandler) {
    document.removeEventListener('click', activityHandler);
    document.removeEventListener('keydown', activityHandler);
    document.removeEventListener('scroll', activityHandler);
    activityHandler = null;
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    window.removeEventListener('focus', visibilityHandler);
    visibilityHandler = null;
  }
}

// State
let editingId: number | null = null;
let deleteTargetId: number | null = null;
let currentImageUrl: string | null = null;
// The image_url the modal was opened with. Used to detect orphan uploads when the user replaces/removes/cancels.
let originalImageUrl: string | null = null;
// The element that had focus before a modal opened — restored on close.
let triggerEl: HTMLElement | null = null;

function trapFocus(modal: HTMLElement, e: KeyboardEvent) {
  const focusable = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) { e.preventDefault(); last.focus(); }
  } else {
    if (document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

// Modal registry
// Each modal registers its overlay, a close fn, and a priority
interface RegisteredModal {
  overlay: HTMLElement;
  close: () => void;
  priority: number;
}
const registeredModals: RegisteredModal[] = [];
let modalKeyboardBound = false;

function registerModal(overlay: HTMLElement, close: () => void, priority = 0) {
  registeredModals.push({ overlay, close, priority });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  if (!modalKeyboardBound) {
    modalKeyboardBound = true;
    document.addEventListener('keydown', handleModalKeydown);
  }
}

function topmostOpenModal(): RegisteredModal | null {
  let top: RegisteredModal | null = null;
  for (const m of registeredModals) {
    if (m.overlay.classList.contains('open') && (!top || m.priority >= top.priority)) top = m;
  }
  return top;
}

function handleModalKeydown(e: KeyboardEvent) {
  const top = topmostOpenModal();
  if (!top) return;
  if (e.key === 'Escape') top.close();
  else if (e.key === 'Tab') trapFocus(top.overlay, e);
}

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el as T;
}

async function getCurrentUserId(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

// Storage cleanup must not block the user's main action (save/delete).
async function deleteStorageImage(url: string | null) {
  if (!url) return;
  const marker = '/announcements/';
  const idx = url.lastIndexOf(marker);
  if (idx === -1) return;
  const path = url.slice(idx + marker.length);
  if (!path) return;
  const { error } = await supabase.storage.from('announcements').remove([path]);
  if (error) console.warn('Storage cleanup failed:', error.message);
}

function showAlert(el: HTMLDivElement, msg: string) {
  el.textContent = msg;
  el.classList.add('show');
}

function hideAlert(el: HTMLDivElement) {
  el.classList.remove('show');
  el.textContent = '';
}

function flashSuccess(el: HTMLDivElement, msg: string) {
  showAlert(el, msg);
  setTimeout(() => hideAlert(el), SUCCESS_TOAST_MS);
}

function showView(v: 'login' | 'dashboard') {
  const viewLogin = getEl<HTMLDivElement>('view-login');
  const viewDashboard = getEl<HTMLDivElement>('view-dashboard');
  viewLogin.style.display = v === 'login' ? 'flex' : 'none';
  viewDashboard.style.display = v === 'dashboard' ? 'block' : 'none';
}

function formatDateDisplay(dateStr: string) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusPillHtml(published: boolean): string {
  const cls = published ? 'status-published' : 'status-draft';
  const label = published ? '● Published' : '○ Draft';
  return `<span class="status-pill ${cls}">${label}</span>`;
}

// Load announcements from Supabase
async function loadAnnouncements() {
  const annList = getEl<HTMLDivElement>('ann-list');
  const dashCount = getEl<HTMLParagraphElement>('dash-count');
  const dashError = getEl<HTMLDivElement>('dash-error');

  hideAlert(dashError);
  annList.innerHTML = '<div class="empty-state"><h3>Loading…</h3></div>';

  const { data, error } = await supabase
    .from('announcements')
    .select('id, title_ml, title_en, content_ml, content_en, image_url, badge_type, date, published, created_at, link_url, link_text_ml, link_text_en')
    .is('deleted_at', null)
    .order('date', { ascending: false });

  if (error) {
    showAlert(dashError, 'Failed to load announcements: ' + error.message);
    annList.innerHTML = '';
    return;
  }

  dashCount.textContent = data.length === 0
    ? 'No announcements yet'
    : `${data.length} announcement${data.length === 1 ? '' : 's'}`;

  if (data.length === 0) {
    annList.innerHTML = `
      <div class="empty-state">
        <h3>No announcements yet</h3>
        <p>Click "New Announcement" to create your first one.</p>
      </div>`;
    return;
  }

  const items = data as Announcement[];
  annList.innerHTML = items.map((item) => {
    const dateLabel = item.date ? formatDateDisplay(item.date) : 'No date';
    const badge = item.badge_type ?? '';

    return `
      <div class="ann-item">
        <div class="ann-item-info">
          <div class="ann-item-title">${escapeHtml(String(item.title_ml ?? '(No Malayalam title)'))}</div>
          <div class="ann-item-meta">
            ${statusPillHtml(item.published)}
            <span>${dateLabel}</span>
            ${badge ? `<span>${escapeHtml(badge)}</span>` : ''}
            ${item.title_en ? `<span>· EN: ${escapeHtml(String(item.title_en))}</span>` : ''}
          </div>
        </div>
        <div class="ann-item-actions">
          <button class="btn-ghost btn-sm" data-edit="${item.id}">Edit</button>
        </div>
      </div>`;
  }).join('');

  annList.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn instanceof HTMLElement ? btn.dataset.edit : null;
      if (!id) return;
      const item = items.find((d) => String(d.id) === id);
      if (item) openEditModal(item);
    });
  });
}

function getAnnouncementFormEls() {
  return {
    titleMl: getEl<HTMLInputElement>('f-title-ml'),
    titleEn: getEl<HTMLInputElement>('f-title-en'),
    contentMl: getEl<HTMLTextAreaElement>('f-content-ml'),
    contentEn: getEl<HTMLTextAreaElement>('f-content-en'),
    date: getEl<HTMLInputElement>('f-date'),
    badge: getEl<HTMLSelectElement>('f-badge'),
    imageFile: getEl<HTMLInputElement>('f-image-file'),
    imageUrl: getEl<HTMLInputElement>('f-image-url'),
    imgPreview: getEl<HTMLDivElement>('img-preview'),
    imgPreviewSrc: getEl<HTMLImageElement>('img-preview-src'),
    formError: getEl<HTMLDivElement>('form-error'),
  };
}

function resetForm() {
  const f = getAnnouncementFormEls();
  f.titleMl.value = '';
  f.titleEn.value = '';
  f.contentMl.value = '';
  f.contentEn.value = '';
  f.date.value = new Date().toISOString().slice(0, 10);
  f.badge.value = 'important';
  f.imageFile.value = '';
  f.imageUrl.value = '';
  f.imgPreview.style.display = 'none';
  f.imgPreviewSrc.src = '';
  hideAlert(f.formError);
  currentImageUrl = null;
  originalImageUrl = null;
}

function openNewModal() {
  const formModal = getEl<HTMLDivElement>('form-modal');
  const modalTitle = getEl<HTMLHeadingElement>('modal-title');
  const btnDelete = getEl<HTMLButtonElement>('btn-delete');

  triggerEl = document.activeElement as HTMLElement | null;
  editingId = null;
  resetForm();
  modalTitle.textContent = 'New Announcement';
  btnDelete.style.display = 'none';
  formModal.classList.add('open');
  getEl<HTMLInputElement>('f-title-ml').focus();
}

function openEditModal(item: Announcement) {
  const formModal = getEl<HTMLDivElement>('form-modal');
  const modalTitle = getEl<HTMLHeadingElement>('modal-title');
  const btnDelete = getEl<HTMLButtonElement>('btn-delete');

  triggerEl = document.activeElement as HTMLElement | null;
  editingId = item.id;
  resetForm();
  modalTitle.textContent = 'Edit Announcement';
  btnDelete.style.display = 'inline-block';

  const f = getAnnouncementFormEls();
  f.titleMl.value = item.title_ml ?? '';
  f.titleEn.value = item.title_en ?? '';
  f.contentMl.value = item.content_ml ?? '';
  f.contentEn.value = item.content_en ?? '';
  f.date.value = item.date ?? new Date().toISOString().slice(0, 10);
  f.badge.value = item.badge_type ?? 'important';

  if (item.image_url) {
    currentImageUrl = item.image_url;
    originalImageUrl = item.image_url;
    f.imageUrl.value = currentImageUrl;
    f.imgPreviewSrc.src = currentImageUrl;
    f.imgPreview.style.display = 'block';
  }

  formModal.classList.add('open');
  getEl<HTMLInputElement>('f-title-ml').focus();
}

function closeModal() {
  // If the user uploaded a new image but didn't save, that upload is orphaned in storage.
  if (currentImageUrl && currentImageUrl !== originalImageUrl) {
    void deleteStorageImage(currentImageUrl);
  }
  getEl<HTMLDivElement>('form-modal').classList.remove('open');
  editingId = null;
  if (triggerEl) { triggerEl.focus(); triggerEl = null; }
}

// Save an announcement in Supabase
async function saveAnnouncement(published: boolean) {
  const f = getAnnouncementFormEls();
  const btnSaveDraft = getEl<HTMLButtonElement>('btn-save-draft');
  const btnPublish = getEl<HTMLButtonElement>('btn-publish');
  const dashSuccess = getEl<HTMLDivElement>('dash-success');

  hideAlert(f.formError);

  if (!f.titleMl.value.trim()) {
    showAlert(f.formError, 'Malayalam title is required.');
    f.titleMl.focus();
    return;
  }
  if (!f.contentMl.value.trim()) {
    showAlert(f.formError, 'Malayalam content is required.');
    f.contentMl.focus();
    return;
  }

  const userId = await getCurrentUserId();

  const payload = {
    title_ml: f.titleMl.value.trim(),
    title_en: f.titleEn.value.trim() || null,
    content_ml: f.contentMl.value.trim(),
    content_en: f.contentEn.value.trim() || null,
    image_url: f.imageUrl.value || null,
    badge_type: f.badge.value,
    date: f.date.value || null,
    published,
    ...(editingId ? { updater_uid: userId } : { creator_uid: userId }),
  };

  btnSaveDraft.disabled = true;
  btnPublish.disabled = true;

  let error;
  if (editingId) {
    ({ error } = await supabase.from('announcements').update(payload).eq('id', editingId));
  } else {
    ({ error } = await supabase.from('announcements').insert(payload));
  }

  btnSaveDraft.disabled = false;
  btnPublish.disabled = false;

  if (error) {
    showAlert(f.formError, 'Save failed: ' + error.message);
    return;
  }

  // If the saved image differs from the one the modal opened with, the old
  // image is now orphaned. Then sync state so closeModal's
  // own orphan check doesn't mistake the just-saved image for an orphan.
  const savedUrl = payload.image_url;
  if (originalImageUrl && originalImageUrl !== savedUrl) {
    await deleteStorageImage(originalImageUrl);
  }
  originalImageUrl = savedUrl;

  closeModal();
  flashSuccess(dashSuccess, published ? 'Announcement published.' : 'Saved as draft.');
  await loadAnnouncements();
}

export function initAdmin() {
  const loginForm = getEl<HTMLFormElement>('login-form');
  const loginEmail = getEl<HTMLInputElement>('login-email');
  const loginPassword = getEl<HTMLInputElement>('login-password');
  const loginBtn = getEl<HTMLButtonElement>('login-btn');
  const loginError = getEl<HTMLDivElement>('login-error');
  const btnLogout = getEl<HTMLButtonElement>('btn-logout');
  const admUserEmail = getEl<HTMLSpanElement>('adm-user-email');
  const btnNew = getEl<HTMLButtonElement>('btn-new');
  const modalClose = getEl<HTMLButtonElement>('modal-close');
  const formModal = getEl<HTMLDivElement>('form-modal');
  const fImageFile = getEl<HTMLInputElement>('f-image-file');
  const imgPreview = getEl<HTMLDivElement>('img-preview');
  const imgPreviewSrc = getEl<HTMLImageElement>('img-preview-src');
  const imgRemove = getEl<HTMLButtonElement>('img-remove');
  const imgUploading = getEl<HTMLParagraphElement>('img-uploading');
  const formError = getEl<HTMLDivElement>('form-error');
  const btnDelete = getEl<HTMLButtonElement>('btn-delete');
  const confirmModal = getEl<HTMLDivElement>('confirm-modal');
  const confirmCancel = getEl<HTMLButtonElement>('confirm-cancel');
  const confirmDelete = getEl<HTMLButtonElement>('confirm-delete');
  const fImageUrl = getEl<HTMLInputElement>('f-image-url');
  const btnSaveDraft = getEl<HTMLButtonElement>('btn-save-draft');
  const btnPublish = getEl<HTMLButtonElement>('btn-publish');

  // Authentication
  async function resetToLogin(message?: string) {
    await supabase.auth.signOut();
    clearSessionTimer();
    clearStoredActivity();
    admUserEmail.textContent = '';
    btnLogout.style.display = 'none';
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
    loginEmail.value = '';
    loginPassword.value = '';
    showView('login');
    if (message) showAlert(loginError, message);
  }

  async function checkSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      if (isIdleExpired()) {
        await resetToLogin('Session expired. Please sign in again.');
        return;
      }
      admUserEmail.textContent = session.user.email ?? '';
      btnLogout.style.display = 'inline-block';
      startSessionTimer(() => resetToLogin('Session expired. Please sign in again.'));
      showView('dashboard');
      showAnnouncementsTab();
      await loadAnnouncements();
    } else {
      clearSessionTimer();
      showView('login');
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(loginError);
    loginBtn.disabled = true;
    loginBtn.innerHTML = '<span class="spinner"></span>Signing in…';

    const { error } = await supabase.auth.signInWithPassword({
      email: loginEmail.value.trim(),
      password: loginPassword.value,
    });

    if (error) {
      showAlert(loginError, error.message);
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign In';
      return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      admUserEmail.textContent = session.user.email ?? '';
      btnLogout.style.display = 'inline-block';
    }
    startSessionTimer(() => resetToLogin('Session expired. Please sign in again.'));
    showView('dashboard');
    showAnnouncementsTab();
    await loadAnnouncements();
  });

  btnLogout.addEventListener('click', () => { void resetToLogin(); });

  // Modal events. The confirm dialog (priority 1) sits over the form (priority 0).
  const closeConfirmModal = () => {
    deleteTargetId = null;
    confirmModal.classList.remove('open');
  };
  btnNew.addEventListener('click', openNewModal);
  modalClose.addEventListener('click', closeModal);
  registerModal(formModal, closeModal, 0);
  registerModal(confirmModal, closeConfirmModal, 1);

  // Image upload
  fImageFile.addEventListener('change', async () => {
    const file = fImageFile.files?.[0];
    if (!file) return;

    if (file.size > MAX_ANNOUNCEMENT_IMAGE_BYTES) {
      showAlert(formError, `Image must be smaller than ${MAX_ANNOUNCEMENT_IMAGE_BYTES / MB} MB.`);
      fImageFile.value = '';
      return;
    }

    const ALLOWED_TYPES: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    const ext = ALLOWED_TYPES[file.type];
    if (!ext) {
      showAlert(formError, 'Only JPG, PNG, and WebP images are allowed.');
      fImageFile.value = '';
      return;
    }

    // If the user already uploaded one image in this session but hasn't saved,
    // that previous upload is an orphan. Capture it now and clean it up once
    // the new upload succeeds (but never touch the original saved image — that
    // only gets cleaned up after a successful save).
    const previousUnsaved = (currentImageUrl && currentImageUrl !== originalImageUrl)
      ? currentImageUrl
      : null;

    imgUploading.style.display = 'block';
    imgPreview.style.display = 'none';

    const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('announcements')
      .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type });

    imgUploading.style.display = 'none';

    if (uploadError) {
      showAlert(formError, 'Image upload failed: ' + uploadError.message);
      fImageFile.value = '';
      return;
    }

    const { data: urlData } = supabase.storage.from('announcements').getPublicUrl(path);
    currentImageUrl = urlData.publicUrl;
    fImageUrl.value = currentImageUrl;
    imgPreviewSrc.src = currentImageUrl;
    imgPreview.style.display = 'block';

    // New upload succeeded — clean up the previous unsaved one.
    if (previousUnsaved) await deleteStorageImage(previousUnsaved);
  });

  imgRemove.addEventListener('click', () => {
    // If the current image is an unsaved upload (not the original), it's an
    // orphan in storage — clean it up. Never touch the original here: if the
    // user is removing the saved image, that cleanup happens after save.
    if (currentImageUrl && currentImageUrl !== originalImageUrl) {
      void deleteStorageImage(currentImageUrl);
    }
    currentImageUrl = null;
    fImageUrl.value = '';
    fImageFile.value = '';
    imgPreview.style.display = 'none';
    imgPreviewSrc.src = '';
  });

  // Save events
  btnSaveDraft.addEventListener('click', () => saveAnnouncement(false));
  btnPublish.addEventListener('click', () => saveAnnouncement(true));

  // Delete events
  btnDelete.addEventListener('click', () => {
    deleteTargetId = editingId;
    confirmModal.classList.add('open');
    confirmCancel.focus();
  });

  confirmCancel.addEventListener('click', closeConfirmModal);

  confirmDelete.addEventListener('click', async () => {
    if (!deleteTargetId) return;
    const dashSuccess = getEl<HTMLDivElement>('dash-success');
    const dashError = getEl<HTMLDivElement>('dash-error');

    const userId = await getCurrentUserId();

    confirmDelete.disabled = true;
    const { error } = await supabase
      .from('announcements')
      .update({ deleted_at: new Date().toISOString(), deleter_uid: userId })
      .eq('id', deleteTargetId);
    confirmDelete.disabled = false;
    confirmModal.classList.remove('open');
    deleteTargetId = null;

    if (error) {
      showAlert(dashError, 'Delete failed: ' + error.message);
      return;
    }

    // Reset in-memory state so closeModal doesn't treat the image as orphaned
    currentImageUrl = null;
    originalImageUrl = null;

    closeModal();
    flashSuccess(dashSuccess, 'Announcement deleted.');
    await loadAnnouncements();
  });

  checkSession();
}

// GALLERY ADMIN
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

function showAnnouncementsTab() {
  document.getElementById('tab-announcements')?.classList.add('tab-active');
  document.getElementById('tab-gallery')?.classList.remove('tab-active');
  const sectionAnn = document.getElementById('section-announcements');
  const sectionGallery = document.getElementById('section-gallery');
  if (sectionAnn) sectionAnn.style.display = 'block';
  if (sectionGallery) sectionGallery.style.display = 'none';
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
