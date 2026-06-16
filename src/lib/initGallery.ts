import { fetchAndRenderGalleryEvents, fetchAndRenderGalleryPhotos, createSignedUrl } from './galleryUtils';

const MODAL_SKELETON_COUNT = 4;
const SWIPE_THRESHOLD_PX = 40;
const FOCUSABLE = 'a[href], button:not(:disabled), input, [tabindex]:not([tabindex="-1"])';

export function initGalleryGrid(gridId: string, emptyId: string): void {
  const grid = document.getElementById(gridId);
  const emptyMsg = document.getElementById(emptyId);
  if (!grid) return;
  const lang = grid.dataset.lang || 'ml';

  // Render the event cards into the grid.
  fetchAndRenderGalleryEvents(grid, lang, emptyMsg);

  // ── Event modal ───────────────────────────────────────────────────────────

  const eventModal  = document.getElementById('event-modal') as HTMLElement;
  const modalTitle  = document.getElementById('event-modal-title') as HTMLElement;
  const modalDate   = document.getElementById('event-modal-date') as HTMLElement;
  const modalPhotos = document.getElementById('event-modal-photos') as HTMLElement;
  const modalEmpty  = document.getElementById('event-modal-empty') as HTMLElement;
  const modalClose  = document.getElementById('event-modal-close') as HTMLButtonElement;

  if (!eventModal || !modalPhotos) return;

  // Track which photo buttons are currently loaded in the modal.
  let photoButtons: NodeListOf<HTMLButtonElement> | null = null;
  let modalTriggerEl: HTMLElement | null = null;
  // Incremented on every open/close to discard in-flight fetches from prior opens.
  let openGeneration = 0;

  // Use event delegation so the listener works after async HTML injection.
  grid.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLButtonElement>('.gallery-card');
    if (!card) return;
    // These attributes are always set by makeEventCard in galleryUtils.ts.
    const slug = card.dataset.slug;
    const title = card.dataset.title;
    if (!slug || !title) return;
    modalTriggerEl = card;
    openEventModal(slug, title, card.dataset.date ?? '');
  });

  async function openEventModal(slug: string, title: string, date: string): Promise<void> {
    const myGeneration = ++openGeneration;

    // Populate the header.
    modalTitle.textContent = title;
    modalDate.textContent = date;

    // Reset empty state from any previous open.
    modalEmpty.style.display = 'none';

    // Show skeleton tiles immediately so there's something to see during the fetch.
    modalPhotos.innerHTML = Array(MODAL_SKELETON_COUNT)
      .fill('<div class="gallery-thumb gallery-thumb--skeleton skel"></div>')
      .join('');

    // Show the modal and lock body scroll.
    // NOTE: style="display:none" must remain as an inline attribute on #event-modal in
    // GalleryPage.astro — this code reads element.style.display, not computed style.
    eventModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    modalClose.focus();

    // Fetch and render photos. This replaces the skeletons with real tiles.
    await fetchAndRenderGalleryPhotos(modalPhotos, slug, lang, modalEmpty);

    // Discard if another open or a close happened while we were fetching.
    if (myGeneration !== openGeneration) return;

    // Re-read photo buttons AFTER the fetch resolves so we have the real tiles.
    photoButtons = modalPhotos.querySelectorAll<HTMLButtonElement>('.gallery-thumb');

    // Attach lightbox click listeners to each photo tile.
    photoButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.dataset.index || '0', 10);
        openLightbox(index);
      });
    });
  }

  function closeEventModal(): void {
    openGeneration++; // invalidates any in-flight fetch
    eventModal.style.display = 'none';
    document.body.style.overflow = '';
    modalPhotos.innerHTML = '';
    photoButtons = null;
    if (modalTriggerEl) { modalTriggerEl.focus(); modalTriggerEl = null; }
  }

  // Close modal when clicking the close button.
  modalClose.addEventListener('click', closeEventModal);

  // Close modal when clicking the dark overlay outside the inner card.
  eventModal.addEventListener('click', (e) => {
    if (e.target === eventModal) closeEventModal();
  });

  // ── Lightbox ──────────────────────────────────────────────────────────────

  const lightbox  = document.getElementById('lightbox') as HTMLElement;
  const lbImg     = document.getElementById('lb-img') as HTMLImageElement;
  const lbSpinner = document.getElementById('lb-spinner') as HTMLElement;
  const lbClose   = document.getElementById('lb-close') as HTMLButtonElement;
  const lbPrev    = document.getElementById('lb-prev') as HTMLButtonElement;
  const lbNext    = document.getElementById('lb-next') as HTMLButtonElement;

  if (!lightbox) return;

  let currentIndex = 0;
  let triggerEl: HTMLElement | null = null;

  async function openLightbox(index: number): Promise<void> {
    triggerEl = document.activeElement as HTMLElement | null;
    currentIndex = index;
    lightbox.style.display = 'flex';
    // NOTE: do NOT set body overflow here — the modal already owns that lock.
    lbClose.focus();
    await showPhoto(index);
  }

  function closeLightbox(): void {
    lightbox.style.display = 'none';
    // NOTE: do NOT clear body overflow here — the modal owns that lock.
    lbImg.src = '';
    if (triggerEl) { triggerEl.focus(); triggerEl = null; }
  }

  async function showPhoto(index: number): Promise<void> {
    if (!photoButtons) return;
    const btn = photoButtons[index];
    if (!btn) return;

    const path   = btn.dataset.path || '';
    const cached = btn.dataset.url || '';   // URL the thumbnail already loaded
    const label  = btn.getAttribute('aria-label') || '';

    lbImg.alt = label;
    lbImg.style.opacity = '0';
    lbSpinner.style.display = 'block';

    const finish = () => { lbSpinner.style.display = 'none'; lbImg.style.opacity = '1'; };

    // Reuse the thumbnail's signed URL so the full image comes straight from the
    // browser cache (no extra API call, no re-download). If that URL has expired
    // (page open > 1 hour), the onerror handler re-signs once and retries.
    let triedResign = false;
    lbImg.onload = finish;
    lbImg.onerror = async () => {
      if (!triedResign) {
        triedResign = true;
        const fresh = await createSignedUrl(path);
        if (fresh) { lbImg.src = fresh; return; }
      }
      finish();
    };

    if (cached) {
      lbImg.src = cached;
    } else {
      const fresh = await createSignedUrl(path);
      if (fresh) { lbImg.src = fresh; } else { finish(); }
    }

    // Update prev/next button visibility.
    lbPrev.style.visibility = index > 0 ? 'visible' : 'hidden';
    lbNext.style.visibility = photoButtons && index < photoButtons.length - 1 ? 'visible' : 'hidden';
  }

  lbClose.addEventListener('click', closeLightbox);
  // Close the lightbox when clicking the dark backdrop (not the image or controls).
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  lbPrev.addEventListener('click', () => {
    if (currentIndex > 0) { currentIndex--; showPhoto(currentIndex); }
  });
  lbNext.addEventListener('click', () => {
    if (photoButtons && currentIndex < photoButtons.length - 1) {
      currentIndex++;
      showPhoto(currentIndex);
    }
  });

  // Keyboard navigation — check lightbox first, then modal.
  // NOTE: display checks rely on the inline style="display:none" set in GalleryPage.astro.
  document.addEventListener('keydown', (e) => {
    // Focus trap: contain Tab key within the event modal when it's open and lightbox is closed.
    if (eventModal.style.display !== 'none' && lightbox.style.display === 'none' && e.key === 'Tab') {
      const focusable = Array.from(eventModal.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      return;
    }

    if (lightbox.style.display !== 'none') {
      // Lightbox is open: trap Tab within its visible controls, then handle its keys.
      if (e.key === 'Tab') {
        const focusable = Array.from(lightbox.querySelectorAll<HTMLElement>(FOCUSABLE))
          .filter(el => el.style.visibility !== 'hidden');
        if (focusable.length) {
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
        return;
      }
      if (e.key === 'Escape') { closeLightbox(); return; }
      if (e.key === 'ArrowLeft' && currentIndex > 0) { currentIndex--; showPhoto(currentIndex); }
      if (e.key === 'ArrowRight' && photoButtons && currentIndex < photoButtons.length - 1) {
        currentIndex++;
        showPhoto(currentIndex);
      }
      return;
    }
    // Lightbox is closed — check if modal needs to handle Escape.
    if (eventModal.style.display !== 'none' && e.key === 'Escape') {
      closeEventModal();
    }
  });

  // Touch swipe support in the lightbox.
  let touchStartX = 0;
  lightbox.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
  }, { passive: true });
  lightbox.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
    if (dx < 0 && photoButtons && currentIndex < photoButtons.length - 1) {
      currentIndex++;
      showPhoto(currentIndex);
    } else if (dx > 0 && currentIndex > 0) {
      currentIndex--;
      showPhoto(currentIndex);
    }
  }, { passive: true });
}
