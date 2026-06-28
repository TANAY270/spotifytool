/**
 * AutoSpotify Popup UI controller.
 * Communicates with the background service worker for auth and preferences.
 */

/** @type {object|null} */
let currentPreferences = null;

// DOM references
const els = {
  loginStatus: document.getElementById('login-status'),
  profileName: document.getElementById('profile-name'),
  btnLogin: document.getElementById('btn-login'),
  btnLogout: document.getElementById('btn-logout'),
  redirectHint: document.getElementById('redirect-hint'),
  toggleEnabled: document.getElementById('toggle-enabled'),
  toggleAutoPause: document.getElementById('toggle-auto-pause'),
  toggleAutoResume: document.getElementById('toggle-auto-resume'),
  resumeDelay: document.getElementById('resume-delay'),
  footerStatus: document.getElementById('footer-status'),
};

/**
 * Send a message to the background service worker.
 * @param {object} message
 * @returns {Promise<object>}
 */
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response || {});
    });
  });
}

/**
 * Refresh UI from background status.
 */
async function loadStatus() {
  try {
    const status = await sendMessage({ type: 'GET_STATUS' });
    applyPreferences(status.preferences);
    applyAuthStatus(status.loggedIn, status.profile);
    showRedirectHint(status.redirectUri);
    els.footerStatus.textContent = status.loggedIn
      ? `Monitoring ${status.youtubeTabCount} YouTube tab(s)`
      : 'Connect Spotify to enable sync';
  } catch (err) {
    els.footerStatus.textContent = `Error: ${err.message}`;
  }
}

/**
 * @param {object} prefs
 */
function applyPreferences(prefs) {
  if (!prefs) return;
  currentPreferences = prefs;

  els.toggleEnabled.checked = prefs.enabled;
  els.toggleAutoPause.checked = prefs.autoPause;
  els.toggleAutoResume.checked = prefs.autoResume;
  els.resumeDelay.value = String(prefs.resumeDelaySec ?? 2);

  updateControlsDisabledState();
}

/**
 * @param {boolean} loggedIn
 * @param {{ displayName: string }|null} profile
 */
function applyAuthStatus(loggedIn, profile) {
  if (loggedIn && profile) {
    els.loginStatus.textContent = 'Connected';
    els.loginStatus.className = 'badge badge-success';
    els.profileName.textContent = profile.displayName || 'Spotify User';
    els.profileName.classList.remove('hidden');
    els.btnLogin.classList.add('hidden');
    els.btnLogout.classList.remove('hidden');
  } else {
    els.loginStatus.textContent = 'Not connected';
    els.loginStatus.className = 'badge badge-muted';
    els.profileName.classList.add('hidden');
    els.btnLogin.classList.remove('hidden');
    els.btnLogout.classList.add('hidden');
  }

  updateControlsDisabledState();
}

/**
 * Show redirect URI hint for Spotify Developer setup.
 * @param {string} redirectUri
 */
function showRedirectHint(redirectUri) {
  if (!redirectUri) return;
  els.redirectHint.textContent = `Redirect URI: ${redirectUri}`;
  els.redirectHint.classList.remove('hidden');
}

function updateControlsDisabledState() {
  const loggedIn = els.loginStatus.textContent === 'Connected';
  const masterOff = !els.toggleEnabled.checked;
  const disabled = !loggedIn || masterOff;

  els.toggleAutoPause.disabled = disabled;
  els.toggleAutoResume.disabled = disabled;
  els.resumeDelay.disabled = disabled;
}

/**
 * Persist preference changes to storage via background.
 * @param {object} updates
 */
async function savePreferences(updates) {
  try {
    const result = await sendMessage({ type: 'SAVE_PREFERENCES', payload: updates });
    if (result.preferences) {
      applyPreferences(result.preferences);
    }
  } catch (err) {
    els.footerStatus.textContent = `Save failed: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

els.btnLogin.addEventListener('click', async () => {
  els.btnLogin.disabled = true;
  els.btnLogin.textContent = 'Connecting…';

  try {
    const result = await sendMessage({ type: 'AUTH_LOGIN' });
    if (result.ok) {
      applyAuthStatus(result.loggedIn, result.profile);
      els.footerStatus.textContent = 'Spotify connected successfully';
    } else {
      throw new Error(result.error || 'Login failed');
    }
  } catch (err) {
    els.footerStatus.textContent = err.message;
  } finally {
    els.btnLogin.disabled = false;
    els.btnLogin.textContent = 'Connect Spotify';
    await loadStatus();
  }
});

els.btnLogout.addEventListener('click', async () => {
  await sendMessage({ type: 'AUTH_LOGOUT' });
  await loadStatus();
});

els.toggleEnabled.addEventListener('change', () => {
  savePreferences({ enabled: els.toggleEnabled.checked });
  updateControlsDisabledState();
});

els.toggleAutoPause.addEventListener('change', () => {
  savePreferences({ autoPause: els.toggleAutoPause.checked });
});

els.toggleAutoResume.addEventListener('change', () => {
  savePreferences({ autoResume: els.toggleAutoResume.checked });
});

els.resumeDelay.addEventListener('change', () => {
  const value = Math.max(0, Math.min(30, Number(els.resumeDelay.value) || 0));
  els.resumeDelay.value = String(value);
  savePreferences({ resumeDelaySec: value });
});

// Initial load
loadStatus();
