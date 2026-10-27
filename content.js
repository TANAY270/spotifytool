/**
 * AutoSpotify Content Script — YouTube video event detection
 *
 * Runs on youtube.com and music.youtube.com. Observes the HTML5 video
 * element and player container to detect play, pause, end, and ad states.
 * Reports state changes to the background service worker.
 */

(function () {
  'use strict';

  /** Minimum interval between state reports to the background (ms) */
  const REPORT_THROTTLE_MS = 300;

  /** @type {ReturnType<typeof setTimeout>|null} */
  let throttleTimer = null;

  /** Last reported state signature to suppress duplicates */
  let lastReportedSignature = '';

  /** @type {HTMLVideoElement|null} */
  let videoElement = null;

  /** @type {MutationObserver|null} */
  let playerObserver = null;

  /** @type {MutationObserver|null} */
  let adObserver = null;

  // -------------------------------------------------------------------------
  // Ad detection
  // -------------------------------------------------------------------------

  /**
   * YouTube marks ad playback via CSS classes and overlay elements.
   * @returns {boolean}
   */
  function isAdPlaying() {
    const player = document.querySelector('#movie_player, .html5-video-player');
    if (!player) return false;

    if (player.classList.contains('ad-showing')) return true;
    if (player.classList.contains('ad-interrupting')) return true;

    // Check for ad overlays or text
    if (document.querySelector('.ytp-ad-player-overlay, .ytp-ad-text, .ytp-ad-skip-button, .ytp-ad-preview-container')) {
      return true;
    }

    // Check if the video-ads container actually contains active ad nodes
    const videoAdsContainer = document.querySelector('.video-ads');
    if (videoAdsContainer && videoAdsContainer.children.length > 0) {
      return true;
    }

    // YouTube internal API (may change, guarded)
    try {
      const ytPlayer = document.getElementById('movie_player');
      if (ytPlayer?.getAdState && ytPlayer.getAdState() === 1) return true;
    } catch {
      // ignore
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // State reading
  // -------------------------------------------------------------------------

  /**
   * Build current playback state from the video element.
   * @returns {{ playing: boolean, isAd: boolean, ended: boolean }}
   */
  function readVideoState() {
    const video = videoElement || document.querySelector('video.html5-main-video, #movie_player video, video');
    if (!video) {
      return { playing: false, isAd: false, ended: false };
    }

    const isAd = isAdPlaying();
    const ended =
      video.ended ||
      (Number.isFinite(video.duration) &&
        video.duration > 0 &&
        video.currentTime >= video.duration - 0.5);

    // During ads, treat as non-user playback (ignore for Spotify sync)
    const playing = !video.paused && !video.ended && video.readyState >= 2;

    return { playing, isAd, ended };
  }

  /**
   * Serialize state for duplicate detection.
   * @param {{ playing: boolean, isAd: boolean, ended: boolean }} state
   */
  function stateSignature(state) {
    return `${state.playing}|${state.isAd}|${state.ended}`;
  }

  /** Interval timer for fallback URL tracking */
  let urlInterval = null;

  /**
   * Check if extension runtime is still valid (not uninstalled or reloaded).
   * @returns {boolean}
   */
  function isContextValid() {
    try {
      return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  /**
   * Cease all activity and disconnect observers if extension context is invalidated.
   */
  function cleanup() {
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    if (urlInterval) {
      clearInterval(urlInterval);
      urlInterval = null;
    }
    if (playerObserver) {
      playerObserver.disconnect();
      playerObserver = null;
    }
    if (adObserver) {
      adObserver.disconnect();
      adObserver = null;
    }
    if (videoElement) {
      unbindVideo(videoElement);
      videoElement = null;
    }
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  /**
   * Send state to background immediately, clearing any pending debounce.
   * @param {string} [trigger]
   */
  function sendStateNow(trigger) {
    if (!isContextValid()) {
      cleanup();
      return;
    }

    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }

    const state = readVideoState();
    const signature = stateSignature(state);

    if (
      signature === lastReportedSignature &&
      trigger !== 'pause' &&
      trigger !== 'play' &&
      trigger !== 'ended'
    ) {
      return;
    }
    lastReportedSignature = signature;

    try {
      if (!isContextValid()) {
        cleanup();
        return;
      }

      chrome.runtime.sendMessage(
        { type: 'YOUTUBE_STATE', payload: state, trigger },
        () => {
          // Extension context may be invalidated on reload — ignore
          void chrome.runtime.lastError;
        },
      );
    } catch {
      // Extension context invalidated (e.g. extension was reloaded)
      cleanup();
    }
  }

  /**
   * Send state to background with trailing debounce.
   * @param {string} [trigger]
   */
  function reportStateDebounced(trigger) {
    if (!isContextValid()) {
      cleanup();
      return;
    }

    if (throttleTimer) {
      clearTimeout(throttleTimer);
    }

    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      sendStateNow(trigger);
    }, 150);
  }

  // -------------------------------------------------------------------------
  // Video element binding
  // -------------------------------------------------------------------------

  /**
   * Attach event listeners to the active video element.
   * @param {HTMLVideoElement} video
   */
  function bindVideo(video) {
    if (videoElement === video) return;

    if (videoElement) {
      unbindVideo(videoElement);
    }

    videoElement = video;

    const events = ['play', 'pause', 'ended', 'waiting', 'playing', 'timeupdate'];
    for (const event of events) {
      video.addEventListener(event, onVideoEvent, { passive: true });
    }

    sendStateNow('bind');
  }

  /**
   * @param {HTMLVideoElement} video
   */
  function unbindVideo(video) {
    const events = ['play', 'pause', 'ended', 'waiting', 'playing', 'timeupdate'];
    for (const event of events) {
      video.removeEventListener(event, onVideoEvent);
    }
  }

  function onVideoEvent(event) {
    // Explicit user action: natural end
    if (event.type === 'ended') {
      lastReportedSignature = '';
      sendStateNow('ended');
      return;
    }

    // Explicit user action: play or pause — report immediately!
    if (event.type === 'play' || event.type === 'pause') {
      lastReportedSignature = '';
      sendStateNow(event.type);
      return;
    }

    // Ignore timeupdate spam unless ad state may have changed
    if (event.type === 'timeupdate') {
      const adNow = isAdPlaying();
      const wasAd = lastReportedSignature.includes('|true|');
      if (adNow !== wasAd) {
        lastReportedSignature = '';
        reportStateDebounced('ad-change');
      }
      return;
    }

    reportStateDebounced(event.type);
  }

  /**
   * Find and bind the main YouTube video element (SPA navigation aware).
   */
  function findAndBindVideo() {
    const video = document.querySelector('video.html5-main-video, #movie_player video, video');
    if (video) {
      bindVideo(video);
    }
  }

  /**
   * Watch for YouTube SPA navigation replacing the player DOM.
   */
  function observePlayerContainer() {
    const target = document.querySelector('#player, #movie_player, ytd-app') || document.body;

    if (playerObserver) playerObserver.disconnect();

    playerObserver = new MutationObserver(() => {
      findAndBindVideo();
    });

    playerObserver.observe(target, { childList: true, subtree: true });
  }

  /**
   * Watch for ad-related class changes on the player element.
   */
  function observeAdState() {
    const player = document.querySelector('#movie_player, .html5-video-player');
    if (!player) return;

    if (adObserver) adObserver.disconnect();

    adObserver = new MutationObserver(() => {
      lastReportedSignature = '';
      reportStateDebounced('ad-mutation');
    });

    adObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  function init() {
    findAndBindVideo();
    observePlayerContainer();
    observeAdState();

    // YouTube SPA: re-bind on history navigation
    window.addEventListener('yt-navigate-finish', () => {
      lastReportedSignature = '';
      setTimeout(() => {
        findAndBindVideo();
        observeAdState();
        reportStateDebounced('navigate');
      }, 500);
    });

    // Fallback for navigation events
    let lastUrl = location.href;
    urlInterval = setInterval(() => {
      if (!isContextValid()) {
        cleanup();
        return;
      }
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastReportedSignature = '';
        setTimeout(() => {
          findAndBindVideo();
          observeAdState();
          reportStateDebounced('url-change');
        }, 500);
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
