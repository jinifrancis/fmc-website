import { supabase } from './supabase.js';

// ── State ────────────────────────────────────────────────────
let editingId: string | null = null;
let deleteTargetId: string | null = null;
let currentImageUrl: string | null = null;

// ── Helpers ──────────────────────────────────────────────────
function showAlert(el: HTMLDivElement, msg: string) {
  el.textContent = msg;
  el.classList.add('show');
}

function hideAlert(el: HTMLDivElement) {
  el.classList.remove('show');
  el.textContent = '';
}

function showView(v: 'login' | 'dashboard') {
  const viewLogin = document.getElementById('view-login') as HTMLDivElement;
  const viewDashboard = document.getElementById('view-dashboard') as HTMLDivElement;
  viewLogin.style.display = v === 'login' ? 'flex' : 'none';
  viewDashboard.style.display = v === 'dashboard' ? 'block' : 'none';
}

function formatDateDisplay(dateStr: string) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Load announcements ───────────────────────────────────────
async function loadAnnouncements() {
  const annList = document.getElementById('ann-list') as HTMLDivElement;
  const dashCount = document.getElementById('dash-count') as HTMLParagraphElement;
  const dashError = document.getElementById('dash-error') as HTMLDivElement;

  hideAlert(dashError);
  annList.innerHTML = '<div class="empty-state"><h3>Loading…</h3></div>';

  const { data, error } = await supabase
    .from('announcements')
    .select('*')
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

  annList.innerHTML = data.map((item: Record<string, unknown>) => {
    const statusClass = item.published ? 'status-published' : 'status-draft';
    const statusLabel = item.published ? '● Published' : '○ Draft';
    const dateLabel = item.date ? formatDateDisplay(item.date as string) : 'No date';
    const badge = String(item.badge_type ?? '');

    return `
      <div class="ann-item">
        <div class="ann-item-info">
          <div class="ann-item-title">${item.title_ml ?? '(No Malayalam title)'}</div>
          <div class="ann-item-meta">
            <span class="status-pill ${statusClass}">${statusLabel}</span>
            <span>${dateLabel}</span>
            ${badge ? `<span>${badge}</span>` : ''}
            ${item.title_en ? `<span>· EN: ${item.title_en}</span>` : ''}
          </div>
        </div>
        <div class="ann-item-actions">
          <button class="btn-ghost btn-sm" data-edit="${item.id}">Edit</button>
        </div>
      </div>`;
  }).join('');

  annList.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.edit!;
      const item = data.find((d: Record<string, unknown>) => String(d.id) === id);
      if (item) openEditModal(item as Record<string, unknown>);
    });
  });
}

// ── Modal ────────────────────────────────────────────────────
function resetForm() {
  const fTitleMl = document.getElementById('f-title-ml') as HTMLInputElement;
  const fTitleEn = document.getElementById('f-title-en') as HTMLInputElement;
  const fContentMl = document.getElementById('f-content-ml') as HTMLTextAreaElement;
  const fContentEn = document.getElementById('f-content-en') as HTMLTextAreaElement;
  const fDate = document.getElementById('f-date') as HTMLInputElement;
  const fBadge = document.getElementById('f-badge') as HTMLSelectElement;
  const fImageFile = document.getElementById('f-image-file') as HTMLInputElement;
  const fImageUrl = document.getElementById('f-image-url') as HTMLInputElement;
  const imgPreview = document.getElementById('img-preview') as HTMLDivElement;
  const imgPreviewSrc = document.getElementById('img-preview-src') as HTMLImageElement;
  const formError = document.getElementById('form-error') as HTMLDivElement;

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
}

function openNewModal() {
  const formModal = document.getElementById('form-modal') as HTMLDivElement;
  const modalTitle = document.getElementById('modal-title') as HTMLHeadingElement;
  const btnDelete = document.getElementById('btn-delete') as HTMLButtonElement;

  editingId = null;
  resetForm();
  modalTitle.textContent = 'New Announcement';
  btnDelete.style.display = 'none';
  formModal.classList.add('open');
}

function openEditModal(item: Record<string, unknown>) {
  const formModal = document.getElementById('form-modal') as HTMLDivElement;
  const modalTitle = document.getElementById('modal-title') as HTMLHeadingElement;
  const btnDelete = document.getElementById('btn-delete') as HTMLButtonElement;
  const fTitleMl = document.getElementById('f-title-ml') as HTMLInputElement;
  const fTitleEn = document.getElementById('f-title-en') as HTMLInputElement;
  const fContentMl = document.getElementById('f-content-ml') as HTMLTextAreaElement;
  const fContentEn = document.getElementById('f-content-en') as HTMLTextAreaElement;
  const fDate = document.getElementById('f-date') as HTMLInputElement;
  const fBadge = document.getElementById('f-badge') as HTMLSelectElement;
  const fImageUrl = document.getElementById('f-image-url') as HTMLInputElement;
  const imgPreview = document.getElementById('img-preview') as HTMLDivElement;
  const imgPreviewSrc = document.getElementById('img-preview-src') as HTMLImageElement;

  editingId = String(item.id);
  resetForm();
  modalTitle.textContent = 'Edit Announcement';
  btnDelete.style.display = 'inline-block';

  fTitleMl.value = String(item.title_ml ?? '');
  fTitleEn.value = String(item.title_en ?? '');
  fContentMl.value = String(item.content_ml ?? '');
  fContentEn.value = String(item.content_en ?? '');
  fDate.value = String(item.date ?? new Date().toISOString().slice(0, 10));
  fBadge.value = String(item.badge_type ?? 'important');

  if (item.image_url) {
    currentImageUrl = String(item.image_url);
    fImageUrl.value = currentImageUrl;
    imgPreviewSrc.src = currentImageUrl;
    imgPreview.style.display = 'block';
  }

  formModal.classList.add('open');
}

function closeModal() {
  const formModal = document.getElementById('form-modal') as HTMLDivElement;
  formModal.classList.remove('open');
  editingId = null;
}

// ── Save ─────────────────────────────────────────────────────
async function saveAnnouncement(published: boolean) {
  const fTitleMl = document.getElementById('f-title-ml') as HTMLInputElement;
  const fTitleEn = document.getElementById('f-title-en') as HTMLInputElement;
  const fContentMl = document.getElementById('f-content-ml') as HTMLTextAreaElement;
  const fContentEn = document.getElementById('f-content-en') as HTMLTextAreaElement;
  const fDate = document.getElementById('f-date') as HTMLInputElement;
  const fBadge = document.getElementById('f-badge') as HTMLSelectElement;
  const fImageUrl = document.getElementById('f-image-url') as HTMLInputElement;
  const formError = document.getElementById('form-error') as HTMLDivElement;
  const btnSaveDraft = document.getElementById('btn-save-draft') as HTMLButtonElement;
  const btnPublish = document.getElementById('btn-publish') as HTMLButtonElement;
  const dashSuccess = document.getElementById('dash-success') as HTMLDivElement;

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

  closeModal();
  showAlert(dashSuccess, published ? 'Announcement published.' : 'Saved as draft.');
  setTimeout(() => hideAlert(dashSuccess), 3000);
  await loadAnnouncements();
}

// ── Init ─────────────────────────────────────────────────────
export function initAdmin() {
  const viewLogin = document.getElementById('view-login') as HTMLDivElement;
  const viewDashboard = document.getElementById('view-dashboard') as HTMLDivElement;
  const loginForm = document.getElementById('login-form') as HTMLFormElement;
  const loginEmail = document.getElementById('login-email') as HTMLInputElement;
  const loginPassword = document.getElementById('login-password') as HTMLInputElement;
  const loginBtn = document.getElementById('login-btn') as HTMLButtonElement;
  const loginError = document.getElementById('login-error') as HTMLDivElement;
  const btnLogout = document.getElementById('btn-logout') as HTMLButtonElement;
  const admUserEmail = document.getElementById('adm-user-email') as HTMLSpanElement;
  const btnNew = document.getElementById('btn-new') as HTMLButtonElement;
  const modalClose = document.getElementById('modal-close') as HTMLButtonElement;
  const formModal = document.getElementById('form-modal') as HTMLDivElement;
  const fImageFile = document.getElementById('f-image-file') as HTMLInputElement;
  const imgPreview = document.getElementById('img-preview') as HTMLDivElement;
  const imgPreviewSrc = document.getElementById('img-preview-src') as HTMLImageElement;
  const imgRemove = document.getElementById('img-remove') as HTMLButtonElement;
  const imgUploading = document.getElementById('img-uploading') as HTMLParagraphElement;
  const formError = document.getElementById('form-error') as HTMLDivElement;
  const btnSaveDraft = document.getElementById('btn-save-draft') as HTMLButtonElement;
  const btnPublish = document.getElementById('btn-publish') as HTMLButtonElement;
  const btnDelete = document.getElementById('btn-delete') as HTMLButtonElement;
  const confirmModal = document.getElementById('confirm-modal') as HTMLDivElement;
  const confirmCancel = document.getElementById('confirm-cancel') as HTMLButtonElement;
  const confirmDelete = document.getElementById('confirm-delete') as HTMLButtonElement;

  // ── Auth ───────────────────────────────────────────────────
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

  // ── Modal events ───────────────────────────────────────────
  btnNew.addEventListener('click', openNewModal);
  modalClose.addEventListener('click', closeModal);
  formModal.addEventListener('click', (e) => {
    if (e.target === formModal) closeModal();
  });

  // ── Image upload ───────────────────────────────────────────
  fImageFile.addEventListener('change', async () => {
    const file = fImageFile.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      showAlert(formError, 'Image must be smaller than 5 MB.');
      fImageFile.value = '';
      return;
    }

    imgUploading.style.display = 'block';
    imgPreview.style.display = 'none';

    const ext = file.name.split('.').pop();
    const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('announcements')
      .upload(path, file, { cacheControl: '3600', upsert: false });

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
  });

  imgRemove.addEventListener('click', () => {
    currentImageUrl = null;
    fImageUrl.value = '';
    fImageFile.value = '';
    imgPreview.style.display = 'none';
    imgPreviewSrc.src = '';
  });

  // ── Save events ────────────────────────────────────────────
  btnSaveDraft.addEventListener('click', () => saveAnnouncement(false));
  btnPublish.addEventListener('click', () => saveAnnouncement(true));

  // ── Delete events ──────────────────────────────────────────
  btnDelete.addEventListener('click', () => {
    deleteTargetId = editingId;
    confirmModal.classList.add('open');
  });

  confirmCancel.addEventListener('click', () => {
    deleteTargetId = null;
    confirmModal.classList.remove('open');
  });

  confirmDelete.addEventListener('click', async () => {
    if (!deleteTargetId) return;
    const dashSuccess = document.getElementById('dash-success') as HTMLDivElement;
    const dashError = document.getElementById('dash-error') as HTMLDivElement;

    confirmDelete.disabled = true;
    const { error } = await supabase.from('announcements').delete().eq('id', deleteTargetId);
    confirmDelete.disabled = false;
    confirmModal.classList.remove('open');
    deleteTargetId = null;

    if (error) {
      showAlert(dashError, 'Delete failed: ' + error.message);
      return;
    }

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
