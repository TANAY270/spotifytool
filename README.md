# AutoSpotify

**AutoSpotify** is a Chrome Extension (Manifest V3) that automatically synchronizes Spotify playback with YouTube video activity. When you watch YouTube, Spotify pauses; when you pause YouTube, Spotify resumes — but only if it was playing before.

---

## Features

| Feature | Description |
|---------|-------------|
| **Auto Pause** | Pauses Spotify when a YouTube video starts playing |
| **Auto Resume** | Resumes your last Spotify track when YouTube is paused |
| **Smart resume** | Only resumes if Spotify was playing before YouTube took over |
| **Ad ignore** | YouTube advertisements do not trigger Spotify changes |
| **Video end handling** | Natural video completion does not resume Spotify |
| **Multi-tab support** | Tracks all YouTube tabs; pauses if any is playing, resumes only when all are paused |
| **Debouncing** | Prevents duplicate Spotify API calls from rapid play/pause |
| **Configurable delay** | Set how many seconds to wait before resuming Spotify |

---

## Requirements

- Google Chrome (or Chromium-based browser)
- **Spotify Premium** account (required by Spotify Web API for playback control)
- An active Spotify session on at least one device (desktop app, web player, or phone)

---

## Project Structure

```
spotifytool/
├── manifest.json      # Extension manifest (MV3)
├── background.js      # Service worker — Spotify API & tab coordination
├── content.js         # YouTube video event detection
├── auth.js            # Spotify OAuth 2.0 PKCE flow
├── storage.js         # Chrome Storage API wrapper
├── config.js          # Client ID and configuration
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic
├── styles.css         # Popup styles
├── icons/             # Extension icons (16, 48, 128 px)
└── README.md
```

---

## Architecture

```
┌─────────────────┐     YOUTUBE_STATE      ┌──────────────────┐
│   content.js    │ ─────────────────────► │  background.js   │
│  (YouTube tab)  │                        │ (service worker) │
└─────────────────┘                        └────────┬─────────┘
                                                    │
                    ┌───────────────────────────────┼───────────────────────────────┐
                    │                               │                               │
                    ▼                               ▼                               ▼
             ┌────────────┐                  ┌────────────┐                  ┌────────────┐
             │  storage.js │                  │   auth.js   │                  │ Spotify API │
             │ (preferences│                  │ (OAuth PKCE)│                  │ play/pause  │
             │  + tokens)  │                  └────────────┘                  └────────────┘
             └────────────┘
                    ▲
                    │ GET_STATUS / SAVE_PREFERENCES / AUTH_*
             ┌──────┴──────┐
             │  popup.js   │
             │ (popup UI)  │
             └─────────────┘
```

### Data flow

1. **content.js** listens to the YouTube `<video>` element for `play`, `pause`, and `ended` events.
2. It detects ads via YouTube player CSS classes (`.ad-showing`, overlays) and ignores them for sync purposes.
3. State updates are throttled and sent to **background.js** as `YOUTUBE_STATE` messages.
4. **background.js** maintains a map of all YouTube tab states and computes aggregate playback.
5. When any non-ad YouTube video plays → Spotify is paused (if Auto Pause is on) and the current track/context is saved.
6. When all YouTube tabs are paused → Spotify resumes after the configured delay (if Auto Resume is on and Spotify was previously playing).

---

## Spotify Developer App Setup

### 1. Create a Spotify App

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Log in and click **Create app**.
3. Fill in:
   - **App name**: `AutoSpotify` (or any name)
   - **App description**: Chrome extension for YouTube/Spotify sync
   - **Redirect URI**: leave empty for now — you'll add it in step 3
4. Accept the terms and create the app.
5. Open the app and copy the **Client ID**.

### 2. Configure the extension

1. Open `config.js` in this project.
2. Replace `YOUR_SPOTIFY_CLIENT_ID_HERE` with your Client ID:

```javascript
SPOTIFY_CLIENT_ID: 'abc123yourclientid',
```

### 3. Register the redirect URI

The redirect URI is tied to your extension ID and looks like:

```
https://<extension-id>.chromiumapp.org/
```

**Steps:**

1. Load the unpacked extension in Chrome (see Installation below).
2. Go to `chrome://extensions` and copy the **Extension ID**.
3. Your redirect URI is: `https://<extension-id>.chromiumapp.org/`
4. In the Spotify Developer Dashboard → your app → **Settings** → **Redirect URIs**, add that URI exactly (trailing slash included).
5. Click **Save**.

The popup also displays this redirect URI after you open it once.

> **Tip:** During development, the extension ID changes unless you pin it with a `"key"` in `manifest.json`. For a stable ID, see [Chrome extension key](https://developer.chrome.com/docs/extensions/reference/manifest/key).

### 4. OAuth scopes

The extension requests these scopes (configured in `config.js`):

- `user-read-playback-state`
- `user-modify-playback-state`
- `user-read-currently-playing`

---

## Authentication Flow

AutoSpotify uses **OAuth 2.0 Authorization Code with PKCE** (no client secret in the extension):

```
User clicks "Connect Spotify"
        │
        ▼
popup.js ──► background.js ──► auth.js
        │
        ▼
Generate code_verifier + code_challenge (S256)
        │
        ▼
chrome.identity.launchWebAuthFlow()
  → Spotify /authorize page (user logs in)
        │
        ▼
Redirect to https://<extension-id>.chromiumapp.org/?code=...
        │
        ▼
POST /api/token with code + code_verifier
        │
        ▼
Store access_token, refresh_token, expiresAt in chrome.storage.local
        │
        ▼
Auto-refresh access token before expiry
```

Tokens are stored locally via the Chrome Storage API (`storage.js`). The refresh token is used silently when the access token expires.

---

## Installation

1. **Clone or download** this repository to a folder on your computer.

2. **Set your Client ID** in `config.js` (see Spotify setup above).

3. Open Chrome and navigate to `chrome://extensions`.

4. Enable **Developer mode** (top-right toggle).

5. Click **Load unpacked** and select the `spotifytool` folder.

6. Copy the **Extension ID** from the extensions page.

7. Add the redirect URI to your Spotify app (see step 3 in Spotify setup).

8. Click the AutoSpotify icon in the toolbar → **Connect Spotify** → authorize the app.

9. Enable **AutoSpotify** and adjust toggles as desired.

10. Open YouTube, play a video, and confirm Spotify pauses/resumes as expected.

---

## Usage

### Popup controls

| Control | Description |
|---------|-------------|
| **Enable AutoSpotify** | Master ON/OFF switch |
| **Auto Pause** | Pause Spotify when YouTube plays |
| **Auto Resume** | Resume Spotify when YouTube pauses |
| **Resume delay** | Seconds to wait before resuming (0–30) |

### Expected behavior

- Start playing music on Spotify (any device).
- Open YouTube and play a video → Spotify pauses.
- Pause the YouTube video → Spotify resumes after the delay.
- If Spotify was already paused before YouTube started, it stays paused.
- YouTube ads are ignored — Spotify won't pause/resume for ad playback.
- When a video ends on its own, Spotify does not resume.

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Spotify doesn't pause/resume | Ensure Spotify Premium and an active playback device |
| "Client ID not configured" | Edit `config.js` with your Spotify Client ID |
| OAuth redirect error | Verify redirect URI matches exactly in Spotify Dashboard |
| Token expired / disconnected | Click **Connect Spotify** again |
| No active device | Open Spotify on desktop, web, or phone and start playback once |

---

## Security Notes

- Access and refresh tokens are stored in `chrome.storage.local` (encrypted by Chrome per profile).
- PKCE is used so no client secret is embedded in the extension.
- Only request the minimum Spotify scopes needed for playback control.

---

## Development

### Key files

- **content.js** — DOM observers and video event listeners for YouTube SPA navigation.
- **background.js** — Debouncing, multi-tab aggregation, Spotify REST calls.
- **auth.js** — PKCE helpers and token lifecycle.
- **storage.js** — Preferences and token persistence.

### Permissions

| Permission | Purpose |
|------------|---------|
| `storage` | Save preferences and OAuth tokens |
| `identity` | OAuth redirect via `launchWebAuthFlow` |
| `tabs` | Track YouTube tab lifecycle |
| `host_permissions` | Spotify API and YouTube content scripts |

---

## License

MIT — use and modify freely.
