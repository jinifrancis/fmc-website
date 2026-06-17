import { supabase } from './supabase';
import {
  getEl,
  showAlert,
  hideAlert,
  startSessionTimer,
  clearSessionTimer,
  clearStoredActivity,
  isIdleExpired,
} from './adminShared';
import { loadAnnouncements, showAnnouncementsTab } from './adminAnnouncements';

function showView(v: 'login' | 'dashboard') {
  const viewLogin = getEl<HTMLDivElement>('view-login');
  const viewDashboard = getEl<HTMLDivElement>('view-dashboard');
  viewLogin.style.display = v === 'login' ? 'flex' : 'none';
  viewDashboard.style.display = v === 'dashboard' ? 'block' : 'none';
}

export function initAdmin() {
  const loginForm = getEl<HTMLFormElement>('login-form');
  const loginEmail = getEl<HTMLInputElement>('login-email');
  const loginPassword = getEl<HTMLInputElement>('login-password');
  const loginBtn = getEl<HTMLButtonElement>('login-btn');
  const loginError = getEl<HTMLDivElement>('login-error');
  const btnLogout = getEl<HTMLButtonElement>('btn-logout');
  const admUserEmail = getEl<HTMLSpanElement>('adm-user-email');

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

  checkSession();
}
