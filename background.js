/**
 * AutoSpotify Background Service Worker
 *
 * Coordinates YouTube tab state, debounces events, and communicates
 * with the Spotify Web API for play/pause control.
 */

importScripts('config.js', 'storage.js', 'auth.js');

/** @type {Map<number, { playing: boolean, isAd: boolean, ended: boolean }>} */
const youtubeTabStates = new Map();

/** Pending debounce timers */
const debounceTimers = {
  pause: null,
  resume: null,
  resumeDelay: null,
};

/** Tracks whether we paused Spotify due to YouTube */
let spotifyPausedByExtension = false;

/** In-flight API call guard to prevent duplicate requests */
let apiCallInProgress = false;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await AutoSpotifyStorage.savePreferences(
    (await AutoSpotifyStorage.getPreferences()) || {},
  );
  await restoreYoutubeTabStates();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (youtubeTabStates.has(tabId)) {
    youtubeTabStates.delete(tabId);
    persistYoutubeTabStates();
    schedulePlaybackEvaluation('tab-removed');
  }
});

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error('[AutoSpotify]', err);
      sendResponse({ ok: false, error: err.message });
    });
  return true;
});

/**
 * @param {object} message
 * @param {chrome.runtime.MessageSender} sender
 */
async function handleMessage(message, sender) {
  switch (message.type) {
    case 'YOUTUBE_STATE':
      return handleYoutubeState(message.payload, sender);

    case 'GET_STATUS':
      return getExtensionStatus();

    case 'AUTH_LOGIN':
      return login();

    case 'AUTH_LOGOUT':
      await AutoSpotifyAuth.logoutSpotify();
      return { ok: true, loggedIn: false };

    case 'SAVE_PREFERENCES':
      await AutoSpotifyStorage.savePreferences(message.payload);
      return {
        ok: true,
        preferences: await AutoSpotifyStorage.getPreferences(),
      };

    case 'GET_REDIRECT_URI':
      return { redirectUri: AutoSpotifyAuth.getRedirectUri() };

    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

// ---------------------------------------------------------------------------
// YouTube state management
// ---------------------------------------------------------------------------

/**
 * Process a YouTube playback state update from a content script.
 * @param {{ playing: boolean, isAd: boolean, ended: boolean }} payload
 * @param {chrome.runtime.MessageSender} sender
 */
async function handleYoutubeState(payload, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) {
    return { ok: false, error: 'Missing tab ID' };
  }

  const prefs = await AutoSpotifyStorage.getPreferences();
  if (!prefs.enabled) {
    return { ok: true, ignored: true, reason: 'disabled' };
  }

  youtubeTabStates.set(tabId, {
    playing: Boolean(payload.playing),
    isAd: Boolean(payload.isAd),
    ended: Boolean(payload.ended),
  });

  await persistYoutubeTabStates();

  // Natural video end should not trigger Spotify resume
  if (payload.ended) {
    await AutoSpotifyStorage.savePlaybackSnapshot({
      wasPlaying: false,
      contextUri: null,
      trackUri: null,
      positionMs: 0,
    });
    schedulePlaybackEvaluation('youtube-ended', false);
  } else {
    schedulePlaybackEvaluation('youtube-state', true);
  }

  return { ok: true };
}

/**
 * Determine aggregate YouTube state across all tracked tabs.
 * @returns {{ anyPlaying: boolean, anyNonAdPlaying: boolean }}
 */
function getAggregateYoutubeState() {
  let anyPlaying = false;
  let anyNonAdPlaying = false;

  for (const state of youtubeTabStates.values()) {
    if (state.playing && !state.ended) {
      anyPlaying = true;
      if (!state.isAd) {
        anyNonAdPlaying = true;
      }
    }
  }

  return { anyPlaying, anyNonAdPlaying };
}

/**
 * Debounce rapid play/pause events, then evaluate Spotify action.
 * Resume uses an additional user-configured delay.
 * @param {string} _reason
 * @param {boolean} [allowResume=true]
 */
function schedulePlaybackEvaluation(_reason, allowResume = true) {
  clearTimeout(debounceTimers.pause);
  clearTimeout(debounceTimers.resume);
  clearTimeout(debounceTimers.resumeDelay);

  debounceTimers.pause = setTimeout(() => {
    evaluateSpotifyAction('pause').catch(console.error);
  }, AUTOSPOTIFY_CONFIG.DEBOUNCE_MS);

  if (!allowResume) return;

  debounceTimers.resume = setTimeout(async () => {
    const prefs = await AutoSpotifyStorage.getPreferences();
    const delayMs =
      (prefs.resumeDelaySec ?? AUTOSPOTIFY_CONFIG.DEFAULT_RESUME_DELAY_SEC) * 1000;

    debounceTimers.resumeDelay = setTimeout(() => {
      evaluateSpotifyAction('resume').catch(console.error);
    }, delayMs);
  }, AUTOSPOTIFY_CONFIG.DEBOUNCE_MS);
}

/**
 * Pause Spotify when YouTube plays; resume when all YouTube tabs pause.
 * @param {'pause' | 'resume'} intendedAction
 */
async function evaluateSpotifyAction(intendedAction) {
  const prefs = await AutoSpotifyStorage.getPreferences();
  if (!prefs.enabled) return;

  const token = await AutoSpotifyAuth.getValidAccessToken();
  if (!token) return;

  const { anyNonAdPlaying } = getAggregateYoutubeState();

  if (intendedAction === 'pause' && prefs.autoPause && anyNonAdPlaying) {
    await pauseSpotifyForYoutube(token);
    return;
  }

  if (intendedAction === 'resume' && prefs.autoResume && !anyNonAdPlaying) {
    await resumeSpotifyAfterYoutube(token);
  }
}

// ---------------------------------------------------------------------------
// Spotify API
// ---------------------------------------------------------------------------

/**
 * @param {string} token
 * @returns {Promise<object|null>}
 */
async function getSpotifyPlaybackState(token) {
  const response = await fetch(
    `${AUTOSPOTIFY_CONFIG.SPOTIFY_API_BASE}/me/player`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error(`Playback state error: ${response.status}`);
  }
  return response.json();
}

/**
 * Pause Spotify and snapshot playback state if currently playing.
 * @param {string} token
 */
async function pauseSpotifyForYoutube(token) {
  if (apiCallInProgress) return;

  try {
    apiCallInProgress = true;
    const state = await getSpotifyPlaybackState(token);

    if (state?.is_playing) {
      await AutoSpotifyStorage.savePlaybackSnapshot({
        wasPlaying: true,
        contextUri: state.context?.uri || null,
        trackUri: state.item?.uri || null,
        positionMs: state.progress_ms || 0,
      });

      const response = await fetch(
        `${AUTOSPOTIFY_CONFIG.SPOTIFY_API_BASE}/me/player/pause`,
        { method: 'PUT', headers: { Authorization: `Bearer ${token}` } },
      );

      if (response.ok || response.status === 204) {
        spotifyPausedByExtension = true;
      }
    } else if (!spotifyPausedByExtension) {
      await AutoSpotifyStorage.savePlaybackSnapshot({
        wasPlaying: false,
        contextUri: null,
        trackUri: null,
        positionMs: 0,
      });
    }
  } finally {
    apiCallInProgress = false;
  }
}

/**
 * Resume Spotify only if it was playing before YouTube took over.
 * @param {string} token
 */
async function resumeSpotifyAfterYoutube(token) {
  if (apiCallInProgress) return;

  const snapshot = await AutoSpotifyStorage.getPlaybackSnapshot();
  if (!snapshot.wasPlaying) return;

  const { anyNonAdPlaying } = getAggregateYoutubeState();
  if (anyNonAdPlaying) return;

  try {
    apiCallInProgress = true;

    const body = {};
    if (snapshot.contextUri) {
      body.context_uri = snapshot.contextUri;
      if (snapshot.trackUri) {
        body.offset = { uri: snapshot.trackUri };
      }
    } else if (snapshot.trackUri) {
      body.uris = [snapshot.trackUri];
    }

    if (snapshot.positionMs > 0) {
      body.position_ms = snapshot.positionMs;
    }

    const response = await fetch(
      `${AUTOSPOTIFY_CONFIG.SPOTIFY_API_BASE}/me/player/play`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: Object.keys(body).length ? JSON.stringify(body) : undefined,
      },
    );

    if (response.ok || response.status === 204) {
      spotifyPausedByExtension = false;
      await AutoSpotifyStorage.savePlaybackSnapshot({
        wasPlaying: false,
        contextUri: null,
        trackUri: null,
        positionMs: 0,
      });
    }
  } finally {
    apiCallInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Auth & status helpers
// ---------------------------------------------------------------------------

async function login() {
  await AutoSpotifyAuth.authenticateWithSpotify();
  const profile = await AutoSpotifyAuth.fetchSpotifyProfile();
  return {
    ok: true,
    loggedIn: Boolean(profile),
    profile: profile
      ? { displayName: profile.display_name, id: profile.id }
      : null,
    redirectUri: AutoSpotifyAuth.getRedirectUri(),
  };
}

async function getExtensionStatus() {
  const [prefs, auth, profile] = await Promise.all([
    AutoSpotifyStorage.getPreferences(),
    AutoSpotifyStorage.getAuth(),
    AutoSpotifyAuth.fetchSpotifyProfile(),
  ]);

  return {
    ok: true,
    preferences: prefs,
    loggedIn: Boolean(auth?.accessToken && profile),
    profile: profile
      ? { displayName: profile.display_name, id: profile.id }
      : null,
    redirectUri: AutoSpotifyAuth.getRedirectUri(),
    youtubeTabCount: youtubeTabStates.size,
  };
}

async function restoreYoutubeTabStates() {
  const stored = await AutoSpotifyStorage.getYoutubeTabStates();
  for (const [tabId, state] of Object.entries(stored)) {
    youtubeTabStates.set(Number(tabId), state);
  }
}

async function persistYoutubeTabStates() {
  await AutoSpotifyStorage.saveYoutubeTabStates(
    Object.fromEntries(youtubeTabStates),
  );
}
