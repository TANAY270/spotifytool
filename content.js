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
    if (document.querySelector('.ytp-ad-player-overlay, .video-ads, .ytp-ad-text')) {
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
    const video = videoElement || document.querySelector('video');
    if (!video) {
      return { playing: false, isAd: false, ended: false };
    }

    const isAd = isAdPlaying();
    const ended = video.ended || (video.duration > 0 && video.currentTime >= video.duration - 0.5);

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

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  /**
   * Send state to background, throttled and deduplicated.
   * @param {string} [trigger]
   */
  function reportState(trigger) {
    if (throttleTimer) return;

    throttleTimer = setTimeout(() => {
      throttleTimer = null;

      const state = readVideoState();
      const signature = stateSignature(state);

      if (signature === lastReportedSignature) return;
      lastReportedSignature = signature;

      chrome.runtime.sendMessage(
        { type: 'YOUTUBE_STATE', payload: state, trigger },
        () => {
          // Extension context may be invalidated on reload — ignore
          void chrome.runtime.lastError;
        },
      );
    }, REPORT_THROTTLE_MS);
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

    reportState('bind');
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
    // Natural video end should not trigger Spotify resume
    if (event.type === 'ended') {
      lastReportedSignature = ''; // force report
      reportState('ended');
      return;
    }

    // Ignore timeupdate spam unless ad state may have changed
    if (event.type === 'timeupdate') {
      const adNow = isAdPlaying();
      const wasAd = lastReportedSignature.includes('|true|');
      if (adNow !== wasAd) {
        lastReportedSignature = '';
        reportState('ad-change');
      }
      return;
    }

    reportState(event.type);
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
      reportState('ad-mutation');
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
        reportState('navigate');
      }, 500);
    });

    // Fallback for navigation events
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastReportedSignature = '';
        setTimeout(() => {
          findAndBindVideo();
          observeAdState();
          reportState('url-change');
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
