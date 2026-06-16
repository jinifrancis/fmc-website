import { supabase } from './supabase';
import { escapeHtml, type Announcement } from './newsUtils';
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
  startSessionTimer,
  clearSessionTimer,
  clearStoredActivity,
  isIdleExpired,
} from './adminShared';

const MAX_ANNOUNCEMENT_IMAGE_BYTES = 5 * MB;

// State
let editingId: number | null = null;
let deleteTargetId: number | null = null;
let currentImageUrl: string | null = null;
// The image_url the modal was opened with. Used to detect orphan uploads when the user replaces/removes/cancels.
let originalImageUrl: string | null = null;
// The element that had focus before a modal opened — restored on close.
let triggerEl: HTMLElement | null = null;

function showView(v: 'login' | 'dashboard') {
  const viewLogin = getEl<HTMLDivElement>('view-login');
  const viewDashboard = getEl<HTMLDivElement>('view-dashboard');
  viewLogin.style.display = v === 'login' ? 'flex' : 'none';
  viewDashboard.style.display = v === 'dashboard' ? 'block' : 'none';
}

// Resets the dashboard to the Announcements tab (used on login).
function showAnnouncementsTab() {
  document.getElementById('tab-announcements')?.classList.add('tab-active');
  document.getElementById('tab-gallery')?.classList.remove('tab-active');
  const sectionAnn = document.getElementById('section-announcements');
  const sectionGallery = document.getElementById('section-gallery');
  if (sectionAnn) sectionAnn.style.display = 'block';
  if (sectionGallery) sectionGallery.style.display = 'none';
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
