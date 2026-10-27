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
};

/** In-flight API call guard to prevent duplicate requests */
let apiCallInProgress = false;

// ---------------------------------------------------------------------------
// Initialization & Tab Lifecycle
// ---------------------------------------------------------------------------

restoreYoutubeTabStates()
  .then(pruneInactiveTabs)
  .catch(console.error);

chrome.runtime.onInstalled.addListener(async () => {
  await AutoSpotifyStorage.savePreferences(
    (await AutoSpotifyStorage.getPreferences()) || {},
  );
  await restoreYoutubeTabStates();
  await pruneInactiveTabs();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (youtubeTabStates.has(tabId)) {
    youtubeTabStates.delete(tabId);
    await persistYoutubeTabStates();
    schedulePlaybackEvaluation('tab-removed');
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // If a tab navigates away from YouTube, remove it from active tracking
  if (changeInfo.url && !changeInfo.url.includes('youtube.com')) {
    if (youtubeTabStates.has(tabId)) {
      youtubeTabStates.delete(tabId);
      await persistYoutubeTabStates();
      schedulePlaybackEvaluation('tab-navigated-away');
    }
  }
});

/**
 * Clean up tab states for tabs that no longer exist in the browser.
 */
async function pruneInactiveTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const openTabIds = new Set(tabs.map((t) => t.id));
    let changed = false;

    for (const tabId of youtubeTabStates.keys()) {
      if (!openTabIds.has(tabId)) {
        youtubeTabStates.delete(tabId);
        changed = true;
      }
    }

    if (changed) {
      await persistYoutubeTabStates();
    }
  } catch (err) {
    console.error('[AutoSpotify] Error pruning inactive tabs:', err);
  }
}

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

  // Natural video end should not trigger Spotify resume (per feature spec)
  if (payload.ended) {
    await AutoSpotifyStorage.savePlaybackSnapshot({
      wasPlaying: false,
      pausedByExtension: false,
      deviceId: null,
      deviceName: null,
      contextUri: null,
      trackUri: null,
      positionMs: 0,
      timestamp: Date.now(),
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
 * Coordinate playback evaluation based on current aggregate YouTube state.
 * - If YouTube is playing: cancels resume timers, debounces Spotify pause.
 * - If YouTube is paused: cancels pause timers, schedules Spotify resume after configured delay.
 * @param {string} reason
 * @param {boolean} [allowResume=true]
 */
async function schedulePlaybackEvaluation(reason, allowResume = true) {
  await pruneInactiveTabs();

  const { anyNonAdPlaying } = getAggregateYoutubeState();
  console.log(
    `[AutoSpotify] schedulePlaybackEvaluation (${reason}): anyNonAdPlaying=${anyNonAdPlaying}`,
  );

  if (anyNonAdPlaying) {
    // YouTube is playing: immediately cancel any pending resume timer
    if (debounceTimers.resume) {
      clearTimeout(debounceTimers.resume);
      debounceTimers.resume = null;
    }

    // Debounce pause action slightly to prevent flutter during rapid scrubbing
    if (!debounceTimers.pause) {
      debounceTimers.pause = setTimeout(async () => {
        debounceTimers.pause = null;
        await evaluateSpotifyAction('pause');
      }, AUTOSPOTIFY_CONFIG.DEBOUNCE_MS || 250);
    }
  } else {
    // YouTube is paused/stopped: immediately cancel any pending pause timer
    if (debounceTimers.pause) {
      clearTimeout(debounceTimers.pause);
      debounceTimers.pause = null;
    }

    if (!allowResume) return;

    // Check if Spotify was playing before YouTube took over
    const snapshot = await AutoSpotifyStorage.getPlaybackSnapshot();
    if (!snapshot.wasPlaying) {
      return;
    }

    const prefs = await AutoSpotifyStorage.getPreferences();
    if (!prefs.enabled || !prefs.autoResume) {
      return;
    }

    const delayMs = Math.max(
      0,
      (prefs.resumeDelaySec ?? AUTOSPOTIFY_CONFIG.DEFAULT_RESUME_DELAY_SEC) * 1000,
    );

    // Cancel existing resume timer and schedule the new one
    if (debounceTimers.resume) {
      clearTimeout(debounceTimers.resume);
      debounceTimers.resume = null;
    }

    console.log(`[AutoSpotify] Scheduling Spotify resume in ${delayMs}ms`);
    debounceTimers.resume = setTimeout(async () => {
      debounceTimers.resume = null;
      await evaluateSpotifyAction('resume');
    }, delayMs);
  }
}

/**
 * Execute Spotify pause or resume action if conditions still hold.
 * @param {'pause' | 'resume'} intendedAction
 */
async function evaluateSpotifyAction(intendedAction) {
  const prefs = await AutoSpotifyStorage.getPreferences();
  if (!prefs.enabled) return;

  const token = await AutoSpotifyAuth.getValidAccessToken();
  if (!token) {
    console.warn('[AutoSpotify] No valid Spotify token available.');
    return;
  }

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
 * Fetch current playback state from Spotify.
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
    console.log('[AutoSpotify] Evaluating Spotify playback state before pause...');

    const currentSnapshot = await AutoSpotifyStorage.getPlaybackSnapshot();

    // If extension already paused Spotify for this active session, preserve existing snapshot
    if (currentSnapshot.pausedByExtension && currentSnapshot.wasPlaying) {
      console.log('[AutoSpotify] Spotify was already paused by extension, preserving snapshot.');
      return;
    }

    const state = await getSpotifyPlaybackState(token);
    console.log(
      '[AutoSpotify] Current Spotify state:',
      state?.is_playing ? 'Playing' : 'Paused/Inactive',
    );

    if (state?.is_playing) {
      await AutoSpotifyStorage.savePlaybackSnapshot({
        wasPlaying: true,
        pausedByExtension: true,
        deviceId: state.device?.id || null,
        deviceName: state.device?.name || null,
        contextUri: state.context?.uri || null,
        trackUri: state.item?.uri || null,
        positionMs: state.progress_ms || 0,
        timestamp: Date.now(),
      });

      const pauseUrl = state.device?.id
        ? `${AUTOSPOTIFY_CONFIG.SPOTIFY_API_BASE}/me/player/pause?device_id=${encodeURIComponent(state.device.id)}`
        : `${AUTOSPOTIFY_CONFIG.SPOTIFY_API_BASE}/me/player/pause`;

      const response = await fetch(pauseUrl, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
      });

      console.log('[AutoSpotify] Spotify pause response status:', response.status);
      if (response.ok || response.status === 204) {
        console.log('[AutoSpotify] Spotify successfully paused.');
      } else {
        const errorText = await response.text();
        console.error('[AutoSpotify] Failed to pause Spotify:', response.status, errorText);
      }
    } else {
      // Spotify was not playing when YouTube started.
      // If we didn't pause it earlier, record wasPlaying=false so we don't start Spotify later.
      if (!currentSnapshot.pausedByExtension) {
        await AutoSpotifyStorage.savePlaybackSnapshot({
          wasPlaying: false,
          pausedByExtension: false,
          deviceId: null,
          deviceName: null,
          contextUri: null,
          trackUri: null,
          positionMs: 0,
          timestamp: Date.now(),
        });
        console.log('[AutoSpotify] Spotify was already inactive/paused, marked wasPlaying=false.');
      }
    }
  } catch (err) {
    console.error('[AutoSpotify] Error in pauseSpotifyForYoutube:', err);
  } finally {
    apiCallInProgress = false;
  }
}

/**
 * Resume Spotify on the recorded or available device only if it was playing before YouTube took over.
 * @param {string} token
 */
async function resumeSpotifyAfterYoutube(token) {
  if (apiCallInProgress) return;

  const snapshot = await AutoSpotifyStorage.getPlaybackSnapshot();
  console.log('[AutoSpotify] Checking resume snapshot wasPlaying:', snapshot.wasPlaying);
  if (!snapshot.wasPlaying) {
    console.log('[AutoSpotify] Spotify was not playing before YouTube took over, skipping resume.');
    return;
  }

  const { anyNonAdPlaying } = getAggregateYoutubeState();
  if (anyNonAdPlaying) {
    console.log('[AutoSpotify] YouTube is still playing, skipping resume.');
    return;
  }

  try {
    apiCallInProgress = true;
    console.log('[AutoSpotify] Resuming Spotify playback...');

    // 1. Fetch available devices from Spotify
    let devices = [];
    try {
      const devicesRes = await fetch(
        `${AUTOSPOTIFY_CONFIG.SPOTIFY_API_BASE}/me/player/devices`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (devicesRes.ok) {
        const devData = await devicesRes.json();
        devices = devData.devices || [];
        console.log(
          '[AutoSpotify] Available Spotify devices:',
          devices.map((d) => `${d.name} (${d.type}, active=${d.is_active})`),
        );
      }
    } catch (e) {
      console.warn('[AutoSpotify] Could not fetch devices:', e);
    }

    // Determine target device ID
    let targetDeviceId = null;
    if (snapshot.deviceId && devices.some((d) => d.id === snapshot.deviceId)) {
      targetDeviceId = snapshot.deviceId;
    } else if (devices.length > 0) {
      const activeDev = devices.find((d) => d.is_active);
      const computerDev = devices.find((d) => d.type.toLowerCase() === 'computer');
      targetDeviceId = activeDev?.id || computerDev?.id || devices[0]?.id || snapshot.deviceId;
    } else {
      targetDeviceId = snapshot.deviceId;
    }

    console.log('[AutoSpotify] Target device ID for resume:', targetDeviceId);

    let resumed = false;

    // Helper to send PUT play with or without body
    async function sendPlayCommand(deviceId, bodyObj) {
      const url = deviceId
        ? `${AUTOSPOTIFY_CONFIG.SPOTIFY_API_BASE}/me/player/play?device_id=${encodeURIComponent(deviceId)}`
        : `${AUTOSPOTIFY_CONFIG.SPOTIFY_API_BASE}/me/player/play`;

      const options = {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(bodyObj ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(bodyObj ? { body: JSON.stringify(bodyObj) } : {}),
      };

      return fetch(url, options);
    }

    // Attempt 1: Simple unpause on target device (or active player)
    let playRes = await sendPlayCommand(targetDeviceId);
    console.log('[AutoSpotify] Attempt 1 (simple play) status:', playRes.status);

    if (playRes.ok || playRes.status === 204) {
      resumed = true;
    }

    // Attempt 2: If attempt 1 failed (e.g. 404 No Active Device), wake up and transfer playback
    if (!resumed && targetDeviceId) {
      console.log('[AutoSpotify] Attempt 2: Transferring playback to device with play=true...');
      try {
        const transferRes = await fetch(
          `${AUTOSPOTIFY_CONFIG.SPOTIFY_API_BASE}/me/player`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              device_ids: [targetDeviceId],
              play: true,
            }),
          },
        );
        console.log('[AutoSpotify] Attempt 2 (transfer playback) status:', transferRes.status);
        if (transferRes.ok || transferRes.status === 204) {
          resumed = true;
        }
      } catch (err) {
        console.warn('[AutoSpotify] Attempt 2 transfer failed:', err);
      }
    }

    // Attempt 3: If still not resumed, attempt with specific track / context snapshot payload
    if (!resumed) {
      const body = {};
      if (snapshot.contextUri) {
        body.context_uri = snapshot.contextUri;
        if (snapshot.trackUri) body.offset = { uri: snapshot.trackUri };
      } else if (snapshot.trackUri) {
        body.uris = [snapshot.trackUri];
      }
      if (snapshot.positionMs > 0) {
        body.position_ms = snapshot.positionMs;
      }

      if (Object.keys(body).length > 0) {
        console.log('[AutoSpotify] Attempt 3: Playing with snapshot track/context payload...');
        playRes = await sendPlayCommand(targetDeviceId, body);
        console.log('[AutoSpotify] Attempt 3 status:', playRes.status);
        if (playRes.ok || playRes.status === 204) {
          resumed = true;
        }
      }
    }

    if (resumed) {
      console.log('[AutoSpotify] Spotify resumed successfully.');
      await AutoSpotifyStorage.savePlaybackSnapshot({
        wasPlaying: false,
        pausedByExtension: false,
        deviceId: null,
        deviceName: null,
        contextUri: null,
        trackUri: null,
        positionMs: 0,
        timestamp: Date.now(),
      });
    } else {
      const errorText = playRes ? await playRes.text().catch(() => '') : '';
      console.error(
        '[AutoSpotify] Failed to resume Spotify. Last status:',
        playRes?.status,
        errorText,
      );
    }
  } catch (err) {
    console.error('[AutoSpotify] Error in resumeSpotifyAfterYoutube:', err);
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
  await pruneInactiveTabs();
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
