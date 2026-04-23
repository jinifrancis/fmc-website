import { supabase } from './supabase.js';
import { escapeHtml, type Announcement } from './newsUtils';

// State
let editingId: string | null = null;
let deleteTargetId: string | null = null;
let currentImageUrl: string | null = null;
// The image_url the modal was opened with. Used to detect orphan uploads when the user replaces/removes/cancels.
let originalImageUrl: string | null = null;
// The element that had focus before a modal opened — restored on close.
let triggerEl: HTMLElement | null = null;

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

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

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el as T;
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
    const statusClass = item.published ? 'status-published' : 'status-draft';
    const statusLabel = item.published ? '● Published' : '○ Draft';
    const dateLabel = item.date ? formatDateDisplay(item.date) : 'No date';
    const badge = item.badge_type ?? '';

    return `
      <div class="ann-item">
        <div class="ann-item-info">
          <div class="ann-item-title">${escapeHtml(String(item.title_ml ?? '(No Malayalam title)'))}</div>
          <div class="ann-item-meta">
            <span class="status-pill ${statusClass}">${statusLabel}</span>
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
      const item = items.find((d) => d.id === id);
      if (item) openEditModal(item);
    });
  });
}

function resetForm() {
  const fTitleMl = getEl<HTMLInputElement>('f-title-ml');
  const fTitleEn = getEl<HTMLInputElement>('f-title-en');
  const fContentMl = getEl<HTMLTextAreaElement>('f-content-ml');
  const fContentEn = getEl<HTMLTextAreaElement>('f-content-en');
  const fDate = getEl<HTMLInputElement>('f-date');
  const fBadge = getEl<HTMLSelectElement>('f-badge');
  const fImageFile = getEl<HTMLInputElement>('f-image-file');
  const fImageUrl = getEl<HTMLInputElement>('f-image-url');
  const imgPreview = getEl<HTMLDivElement>('img-preview');
  const imgPreviewSrc = getEl<HTMLImageElement>('img-preview-src');
  const formError = getEl<HTMLDivElement>('form-error');

  fTitleMl.value = '';
  fTitleEn.value = '';
  fContentMl.value = '';
  fContentEn.value = '';
  fDate.value = new Date().toISOString().slice(0, 10);
  fBadge.value = 'important';
  fImageFile.value = '';
  fImageUrl.value = '';
  imgPreview.style.display = 'none';
  imgPreviewSrc.src = '';
  hideAlert(formError);
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
  const fTitleMl = getEl<HTMLInputElement>('f-title-ml');
  const fTitleEn = getEl<HTMLInputElement>('f-title-en');
  const fContentMl = getEl<HTMLTextAreaElement>('f-content-ml');
  const fContentEn = getEl<HTMLTextAreaElement>('f-content-en');
  const fDate = getEl<HTMLInputElement>('f-date');
  const fBadge = getEl<HTMLSelectElement>('f-badge');
  const fImageUrl = getEl<HTMLInputElement>('f-image-url');
  const imgPreview = getEl<HTMLDivElement>('img-preview');
  const imgPreviewSrc = getEl<HTMLImageElement>('img-preview-src');

  triggerEl = document.activeElement as HTMLElement | null;
  editingId = item.id;
  resetForm();
  modalTitle.textContent = 'Edit Announcement';
  btnDelete.style.display = 'inline-block';

  fTitleMl.value = item.title_ml ?? '';
  fTitleEn.value = item.title_en ?? '';
  fContentMl.value = item.content_ml ?? '';
  fContentEn.value = item.content_en ?? '';
  fDate.value = item.date ?? new Date().toISOString().slice(0, 10);
  fBadge.value = item.badge_type ?? 'important';

  if (item.image_url) {
    currentImageUrl = item.image_url;
    originalImageUrl = item.image_url;
    fImageUrl.value = currentImageUrl;
    imgPreviewSrc.src = currentImageUrl;
    imgPreview.style.display = 'block';
  }

  formModal.classList.add('open');
  getEl<HTMLInputElement>('f-title-ml').focus();
}

function closeModal() {
  // If the user uploaded a new image but didn't save, that upload is orphaned
  // in storage. Clean it up (don't block closing the modal).
  if (currentImageUrl && currentImageUrl !== originalImageUrl) {
    void deleteStorageImage(currentImageUrl);
  }
  getEl<HTMLDivElement>('form-modal').classList.remove('open');
  editingId = null;
  if (triggerEl) { triggerEl.focus(); triggerEl = null; }
}

// Save an announcement in Supabase
async function saveAnnouncement(published: boolean) {
  const fTitleMl = getEl<HTMLInputElement>('f-title-ml');
  const fTitleEn = getEl<HTMLInputElement>('f-title-en');
  const fContentMl = getEl<HTMLTextAreaElement>('f-content-ml');
  const fContentEn = getEl<HTMLTextAreaElement>('f-content-en');
  const fDate = getEl<HTMLInputElement>('f-date');
  const fBadge = getEl<HTMLSelectElement>('f-badge');
  const fImageUrl = getEl<HTMLInputElement>('f-image-url');
  const formError = getEl<HTMLDivElement>('form-error');
  const btnSaveDraft = getEl<HTMLButtonElement>('btn-save-draft');
  const btnPublish = getEl<HTMLButtonElement>('btn-publish');
  const dashSuccess = getEl<HTMLDivElement>('dash-success');

  hideAlert(formError);

  if (!fTitleMl.value.trim()) {
    showAlert(formError, 'Malayalam title is required.');
    fTitleMl.focus();
    return;
  }
  if (!fContentMl.value.trim()) {
    showAlert(formError, 'Malayalam content is required.');
    fContentMl.focus();
    return;
  }

  const payload = {
    title_ml: fTitleMl.value.trim(),
    title_en: fTitleEn.value.trim() || null,
    content_ml: fContentMl.value.trim(),
    content_en: fContentEn.value.trim() || null,
    image_url: fImageUrl.value || null,
    badge_type: fBadge.value,
    date: fDate.value || null,
    published,
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
    showAlert(formError, 'Save failed: ' + error.message);
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
  showAlert(dashSuccess, published ? 'Announcement published.' : 'Saved as draft.');
  setTimeout(() => hideAlert(dashSuccess), 3000);
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
  async function checkSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      admUserEmail.textContent = session.user.email ?? '';
      btnLogout.style.display = 'inline-block';
      showView('dashboard');
      await loadAnnouncements();
    } else {
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
    showView('dashboard');
    await loadAnnouncements();
  });

  btnLogout.addEventListener('click', async () => {
    await supabase.auth.signOut();
    admUserEmail.textContent = '';
    btnLogout.style.display = 'none';
    showView('login');
  });

  // Modal events
  btnNew.addEventListener('click', openNewModal);
  modalClose.addEventListener('click', closeModal);
  formModal.addEventListener('click', (e) => {
    if (e.target === formModal) closeModal();
  });

  // Escape to close + focus trap for both modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Confirm modal sits on top, close it first
      if (confirmModal.classList.contains('open')) {
        deleteTargetId = null;
        confirmModal.classList.remove('open');
      } else if (formModal.classList.contains('open')) {
        closeModal();
      }
      return;
    }
    if (e.key === 'Tab') {
      if (confirmModal.classList.contains('open')) {
        trapFocus(confirmModal, e);
      } else if (formModal.classList.contains('open')) {
        trapFocus(formModal, e);
      }
    }
  });

  // Image upload
  fImageFile.addEventListener('change', async () => {
    const file = fImageFile.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      showAlert(formError, 'Image must be smaller than 5 MB.');
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

  confirmCancel.addEventListener('click', () => {
    deleteTargetId = null;
    confirmModal.classList.remove('open');
  });

  confirmDelete.addEventListener('click', async () => {
    if (!deleteTargetId) return;
    const dashSuccess = getEl<HTMLDivElement>('dash-success');
    const dashError = getEl<HTMLDivElement>('dash-error');

    // Capture the row's image URL before we delete the DB row. After a
    // successful delete we'll remove the file from storage so it doesn't
    // become an orphan.
    const imageToDelete = originalImageUrl;

    confirmDelete.disabled = true;
    const { error } = await supabase.from('announcements').delete().eq('id', deleteTargetId);
    confirmDelete.disabled = false;
    confirmModal.classList.remove('open');
    deleteTargetId = null;

    if (error) {
      showAlert(dashError, 'Delete failed: ' + error.message);
      return;
    }

    // Best-effort storage cleanup, then sync state so closeModal's own
    // orphan check doesn't try to delete anything again.
    if (imageToDelete) await deleteStorageImage(imageToDelete);
    currentImageUrl = null;
    originalImageUrl = null;

    closeModal();
    showAlert(dashSuccess, 'Announcement deleted.');
    setTimeout(() => hideAlert(dashSuccess), 3000);
    await loadAnnouncements();
  });

  confirmModal.addEventListener('click', (e) => {
    if (e.target === confirmModal) {
      deleteTargetId = null;
      confirmModal.classList.remove('open');
    }
  });

  checkSession();
}
