/**
 * Spotify OAuth 2.0 with PKCE for Chrome Extension (Manifest V3).
 * Uses chrome.identity.launchWebAuthFlow for the authorization step.
 */

/**
 * Generate a cryptographically random string for PKCE code_verifier.
 * @param {number} length
 * @returns {string}
 */
function generateRandomString(length = 64) {
  const charset =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  return Array.from(randomValues, (v) => charset[v % charset.length]).join('');
}

/**
 * Base64url-encode an ArrayBuffer (no padding).
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Create PKCE code_challenge from code_verifier (S256).
 * @param {string} verifier
 * @returns {Promise<string>}
 */
async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(digest);
}

/**
 * Build Spotify authorization URL with PKCE parameters.
 * @param {string} clientId
 * @param {string} redirectUri
 * @param {string[]} scopes
 * @param {string} codeChallenge
 * @returns {string}
 */
function buildAuthUrl(clientId, redirectUri, scopes, codeChallenge) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
  });
  return `${AUTOSPOTIFY_CONFIG.SPOTIFY_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access + refresh tokens.
 * @param {string} code
 * @param {string} codeVerifier
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number }>}
 */
async function exchangeCodeForTokens(code, codeVerifier) {
  const { SPOTIFY_CLIENT_ID, SPOTIFY_TOKEN_URL } = AUTOSPOTIFY_CONFIG;
  const redirectUri = chrome.identity.getRedirectURL();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: SPOTIFY_CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return tokensFromResponse(data);
}

/**
 * Refresh an expired access token using the refresh token.
 * @param {string} refreshToken
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number }>}
 */
async function refreshAccessToken(refreshToken) {
  const { SPOTIFY_CLIENT_ID, SPOTIFY_TOKEN_URL } = AUTOSPOTIFY_CONFIG;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: SPOTIFY_CLIENT_ID,
  });

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return tokensFromResponse(data, refreshToken);
}

/**
 * Normalize Spotify token response into our storage format.
 * @param {object} data
 * @param {string} [existingRefreshToken]
 */
function tokensFromResponse(data, existingRefreshToken) {
  const expiresAt = Date.now() + data.expires_in * 1000 - 60_000; // 1 min buffer
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || existingRefreshToken,
    expiresAt,
  };
}

/**
 * Launch Spotify OAuth flow and persist tokens.
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number }>}
 */
async function authenticateWithSpotify() {
  const { SPOTIFY_CLIENT_ID, SCOPES } = AUTOSPOTIFY_CONFIG;

  if (!SPOTIFY_CLIENT_ID || SPOTIFY_CLIENT_ID === 'YOUR_SPOTIFY_CLIENT_ID_HERE') {
    throw new Error(
      'Spotify Client ID is not configured. Edit config.js with your Client ID.',
    );
  }

  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = buildAuthUrl(SPOTIFY_CLIENT_ID, redirectUri, SCOPES, codeChallenge);

  const redirectUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (responseUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!responseUrl) {
        reject(new Error('Authorization was cancelled.'));
        return;
      }
      resolve(responseUrl);
    });
  });

  const url = new URL(redirectUrl);
  const error = url.searchParams.get('error');
  if (error) {
    throw new Error(`Spotify authorization error: ${error}`);
  }

  const code = url.searchParams.get('code');
  if (!code) {
    throw new Error('No authorization code received from Spotify.');
  }

  const tokens = await exchangeCodeForTokens(code, codeVerifier);
  await AutoSpotifyStorage.saveAuth(tokens);
  return tokens;
}

/**
 * Return a valid access token, refreshing if necessary.
 * @returns {Promise<string|null>}
 */
async function getValidAccessToken() {
  const auth = await AutoSpotifyStorage.getAuth();
  if (!auth?.accessToken) {
    return null;
  }

  if (Date.now() < auth.expiresAt) {
    return auth.accessToken;
  }

  if (!auth.refreshToken) {
    await AutoSpotifyStorage.clearAuth();
    return null;
  }

  try {
    const refreshed = await refreshAccessToken(auth.refreshToken);
    await AutoSpotifyStorage.saveAuth(refreshed);
    return refreshed.accessToken;
  } catch (err) {
    console.error('[AutoSpotify] Token refresh failed:', err);
    await AutoSpotifyStorage.clearAuth();
    return null;
  }
}

/**
 * Fetch current Spotify user profile (for login status display).
 * @returns {Promise<object|null>}
 */
async function fetchSpotifyProfile() {
  const token = await getValidAccessToken();
  if (!token) return null;

  const response = await fetch(`${AUTOSPOTIFY_CONFIG.SPOTIFY_API_BASE}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) return null;
  return response.json();
}

async function logoutSpotify() {
  await AutoSpotifyStorage.clearAuth();
}

// Export for importScripts and popup
if (typeof globalThis !== 'undefined') {
  globalThis.AutoSpotifyAuth = {
    authenticateWithSpotify,
    getValidAccessToken,
    fetchSpotifyProfile,
    logoutSpotify,
    getRedirectUri: () => chrome.identity.getRedirectURL(),
  };
}
