/**
 * AutoSpotify Configuration
 *
 * Replace SPOTIFY_CLIENT_ID with your Spotify Developer App Client ID.
 * Register this redirect URI in your Spotify app settings:
 *   https://<your-extension-id>.chromiumapp.org/
 *
 * To get a stable extension ID during development, load the unpacked
 * extension once, copy the ID from chrome://extensions, then optionally
 * add a "key" field to manifest.json (see README).
 */
const CONFIG = {
  SPOTIFY_CLIENT_ID: '4f96b2222293458589e250e040986d93',
  SPOTIFY_AUTH_URL: 'https://accounts.spotify.com/authorize',
  SPOTIFY_TOKEN_URL: 'https://accounts.spotify.com/api/token',
  SPOTIFY_API_BASE: 'https://api.spotify.com/v1',

  /** Scopes required for playback control and state reading */
  SCOPES: [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
  ],

  /** Debounce window for rapid YouTube play/pause events (ms) */
  DEBOUNCE_MS: 250,

  /** Default resume delay if not set in storage (seconds) */
  DEFAULT_RESUME_DELAY_SEC: 2,
};

// Export for service worker (importScripts) and popup (script tag)
if (typeof globalThis !== 'undefined') {
  globalThis.AUTOSPOTIFY_CONFIG = CONFIG;
}
