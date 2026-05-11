// Skip the login flow if there's already a valid session cookie.
(async function checkSession() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.ok) {
      window.location.href = '/';
      return;
    }
  } catch {}
  fetchClientId();
})();

async function fetchClientId() {
  let data;
  try {
    const res = await fetch('/api/auth/config');
    if (!res.ok) { showSetupError('Could not reach /api/auth/config (status ' + res.status + ')'); return; }
    data = await res.json();
  } catch (e) {
    showSetupError('Network error reaching /api/auth/config: ' + e.message);
    return;
  }

  if (!data.clientId) {
    showSetupError('GOOGLE_CLIENT_ID is not set on the server. Add it to .env.local (or your Vercel project env vars) and restart.');
    return;
  }

  // Inject the GSI button slot only now that we have a real client_id —
  // otherwise Google renders an unconfigured button that 400s on click.
  const slot = document.getElementById('googleBtnSlot');
  slot.innerHTML = '<div class="g_id_signin"></div>';

  function initOnce() {
    if (!window.google || !google.accounts) {
      // GSI script is loaded with defer — poll until it appears on window.
      setTimeout(initOnce, 100);
      return;
    }
    google.accounts.id.initialize({
      client_id: data.clientId,
      callback: handleGoogleLogin,
    });
    google.accounts.id.renderButton(
      slot.querySelector('.g_id_signin'),
      { theme: 'outline', size: 'large', text: 'sign_in_with', shape: 'rectangular', width: 300 }
    );
  }
  initOnce();
}

function showSetupError(msg) {
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = msg;
  errorEl.classList.add('show');
}

async function handleGoogleLogin(response) {
  const errorEl = document.getElementById('loginError');
  const loadingEl = document.getElementById('loginLoading');

  errorEl.classList.remove('show');
  loadingEl.classList.add('show');

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ credential: response.credential }),
    });

    const data = await res.json();

    if (!data.success) {
      loadingEl.classList.remove('show');
      errorEl.textContent = data.error || 'Login failed';
      errorEl.classList.add('show');
      return;
    }

    window.location.href = '/';
  } catch (err) {
    loadingEl.classList.remove('show');
    errorEl.textContent = 'Network error. Please try again.';
    errorEl.classList.add('show');
  }
}
