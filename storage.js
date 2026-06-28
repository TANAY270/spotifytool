/**
 * Chrome Storage API wrapper for AutoSpotify.
 * Handles user preferences and OAuth token persistence.
 */

const STORAGE_KEYS = {
  PREFERENCES: 'preferences',
  AUTH: 'auth',
  PLAYBACK_STATE: 'playbackState',
  YOUTUBE_TABS: 'youtubeTabs',
};

/** Default user preferences */
const DEFAULT_PREFERENCES = {
  enabled: true,
  autoResume: true,
  autoPause: true,
  resumeDelaySec: 2,
};

/**
 * Read a value from chrome.storage.local.
 * @param {string} key
 * @returns {Promise<*>}
 */
async function storageGet(key) {
  const result = await chrome.storage.local.get(key);
  return result[key];
}

/**
 * Write a value to chrome.storage.local.
 * @param {string} key
 * @param {*} value
 */
async function storageSet(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

/**
 * Remove keys from chrome.storage.local.
 * @param {string|string[]} keys
 */
async function storageRemove(keys) {
  await chrome.storage.local.remove(keys);
}

/**
 * @returns {Promise<object>} User preferences merged with defaults.
 */
async function getPreferences() {
  const stored = (await storageGet(STORAGE_KEYS.PREFERENCES)) || {};
  return { ...DEFAULT_PREFERENCES, ...stored };
}

/**
 * @param {Partial<typeof DEFAULT_PREFERENCES>} updates
 */
async function savePreferences(updates) {
  const current = await getPreferences();
  await storageSet(STORAGE_KEYS.PREFERENCES, { ...current, ...updates });
  return { ...current, ...updates };
}

/**
 * @returns {Promise<object|null>} Stored auth tokens or null.
 */
async function getAuth() {
  return (await storageGet(STORAGE_KEYS.AUTH)) || null;
}

/**
 * @param {object} auth - { accessToken, refreshToken, expiresAt }
 */
async function saveAuth(auth) {
  await storageSet(STORAGE_KEYS.AUTH, auth);
}

async function clearAuth() {
  await storageRemove(STORAGE_KEYS.AUTH);
}

/**
 * Snapshot of Spotify playback before YouTube took over.
 * @returns {Promise<{ wasPlaying: boolean, contextUri: string|null, trackUri: string|null, positionMs: number }>}
 */
async function getPlaybackSnapshot() {
  return (
    (await storageGet(STORAGE_KEYS.PLAYBACK_STATE)) || {
      wasPlaying: false,
      contextUri: null,
      trackUri: null,
      positionMs: 0,
    }
  );
}

/**
 * @param {object} snapshot
 */
async function savePlaybackSnapshot(snapshot) {
  await storageSet(STORAGE_KEYS.PLAYBACK_STATE, snapshot);
}

/**
 * In-memory tab state is kept in the service worker; this persists
 * a lightweight copy for recovery after service worker restarts.
 */
async function getYoutubeTabStates() {
  return (await storageGet(STORAGE_KEYS.YOUTUBE_TABS)) || {};
}

async function saveYoutubeTabStates(states) {
  await storageSet(STORAGE_KEYS.YOUTUBE_TABS, states);
}

// Export for importScripts and popup
if (typeof globalThis !== 'undefined') {
  globalThis.AutoSpotifyStorage = {
    STORAGE_KEYS,
    DEFAULT_PREFERENCES,
    storageGet,
    storageSet,
    storageRemove,
    getPreferences,
    savePreferences,
    getAuth,
    saveAuth,
    clearAuth,
    getPlaybackSnapshot,
    savePlaybackSnapshot,
    getYoutubeTabStates,
    saveYoutubeTabStates,
  };
}
