import { supabase } from './supabase';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;   // auto-logout after 30 min idle
const SESSION_CHECK_MS = 60_000;             // re-check idle time every 60s
const ACTIVITY_PERSIST_THROTTLE_MS = 5000;   // min gap between localStorage writes
const LAST_ACTIVITY_KEY = 'adm_last_activity';
export const MB = 1024 * 1024;
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

export function clearStoredActivity() {
  try { localStorage.removeItem(LAST_ACTIVITY_KEY); } catch { /* storage unavailable */ }
}

export function isIdleExpired(): boolean {
  try {
    const stored = localStorage.getItem(LAST_ACTIVITY_KEY);
    if (stored === null) return true;          // no activity timestamp → can't prove freshness
    const ts = Number(stored);
    if (!Number.isFinite(ts)) return true;     // corrupt value → treat as expired
    return Date.now() - ts >= SESSION_TIMEOUT_MS;
  } catch {
    return false;                              // storage unavailable → don't lock out
  }
}

export function startSessionTimer(onExpire: () => void) {
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

export function clearSessionTimer() {
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

// Modal registry
// Each modal registers its overlay, a close fn, and a priority. Backdrop click
// closes that modal; one shared keydown listener handles ESC (close) and Tab
// (focus trap) for the topmost open modal (higher priority sits on top).
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

interface RegisteredModal {
  overlay: HTMLElement;
  close: () => void;
  priority: number;
}
const registeredModals: RegisteredModal[] = [];
let modalKeyboardBound = false;

export function registerModal(overlay: HTMLElement, close: () => void, priority = 0) {
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

// Helpers
export function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el as T;
}

export async function getCurrentUserId(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

export function showAlert(el: HTMLDivElement, msg: string) {
  el.textContent = msg;
  el.classList.add('show');
}

export function hideAlert(el: HTMLDivElement) {
  el.classList.remove('show');
  el.textContent = '';
}

export function flashSuccess(el: HTMLDivElement, msg: string) {
  showAlert(el, msg);
  setTimeout(() => hideAlert(el), SUCCESS_TOAST_MS);
}

export function formatDateDisplay(dateStr: string) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function statusPillHtml(published: boolean): string {
  const cls = published ? 'status-published' : 'status-draft';
  const label = published ? '● Published' : '○ Draft';
  return `<span class="status-pill ${cls}">${label}</span>`;
}
