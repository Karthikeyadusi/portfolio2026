/**
 * karthikeyadusi.dev — Teaser Page
 * Countdown timer & interactive tease
 */

(function () {
  'use strict';

  // ── DOM Elements ─────────────────────────────────

  const cdHours = document.getElementById('cd-hours');
  const cdMinutes = document.getElementById('cd-minutes');
  const cdSeconds = document.getElementById('cd-seconds');
  const countdown = document.getElementById('countdown');
  const tease = document.getElementById('tease');
  const teaseDim = document.getElementById('tease-dim');

  if (!cdHours || !cdMinutes || !cdSeconds) return;


  // ── Countdown Timer ──────────────────────────────
  // 21 hours = 75600 seconds
  // Store end timestamp in localStorage so it persists

  const TOTAL_SECONDS = 21 * 3600; // 21 hours (75600s)
  const STORAGE_KEY = 'kd_countdown_end_v2';

  function getEndTimestamp() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const ts = parseInt(stored, 10);
      if (!isNaN(ts) && ts > Date.now()) return ts;
    }
    // Set a fresh 21-hour countdown
    const end = Date.now() + TOTAL_SECONDS * 1000;
    localStorage.setItem(STORAGE_KEY, end.toString());
    return end;
  }

  const endTimestamp = getEndTimestamp();
  let countdownFinished = false;
  let tickInterval = null;

  function getRemainingSeconds() {
    return Math.max(0, (endTimestamp - Date.now()) / 1000);
  }

  function updateCountdown() {
    const remaining = getRemainingSeconds();
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = Math.floor(remaining % 60);

    cdHours.textContent = String(h).padStart(2, '0');
    cdMinutes.textContent = String(m).padStart(2, '0');
    cdSeconds.textContent = String(s).padStart(2, '0');

    if (remaining <= 0 && !countdownFinished) {
      countdownFinished = true;
      onCountdownComplete();
    }
  }

  function onCountdownComplete() {
    if (tickInterval) clearInterval(tickInterval);
    cdHours.textContent = '00';
    cdMinutes.textContent = '00';
    cdSeconds.textContent = '00';
    if (countdown) countdown.classList.add('completed');
  }

  // Start after entrance animations
  setTimeout(() => {
    updateCountdown();

    if (getRemainingSeconds() <= 0) {
      countdownFinished = true;
      onCountdownComplete();
      return;
    }

    tickInterval = setInterval(updateCountdown, 1000);
  }, 2000);


  // ── Interactive Tease ("Worth the wait.") ────────

  let teaseTimeout = null;
  let teaseActive = false;

  function activateTease() {
    if (teaseActive) return;
    teaseActive = true;

    tease.classList.add('focused');
    if (teaseDim) teaseDim.classList.add('active');

    clearTimeout(teaseTimeout);
    teaseTimeout = setTimeout(deactivateTease, 3000);
  }

  function deactivateTease() {
    teaseActive = false;
    tease.classList.remove('focused');
    if (teaseDim) teaseDim.classList.remove('active');
    clearTimeout(teaseTimeout);
  }

  if (tease) {
    tease.addEventListener('mouseenter', activateTease);
    tease.addEventListener('mouseleave', () => {
      clearTimeout(teaseTimeout);
      teaseTimeout = setTimeout(deactivateTease, 800);
    });

    tease.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (teaseActive) {
        deactivateTease();
      } else {
        activateTease();
      }
    }, { passive: false });

    tease.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (teaseActive) {
          deactivateTease();
        } else {
          activateTease();
        }
      }
    });

    if (teaseDim) {
      teaseDim.addEventListener('click', deactivateTease);
    }
  }


  // ── Ambient Light Drift ──────────────────────────

  const ambient = document.querySelector('.ambient-light');
  if (ambient) {
    let driftX = 0;
    let driftY = 0;
    let targetDriftX = 0;
    let targetDriftY = 0;

    function newDriftTarget() {
      targetDriftX = (Math.random() - 0.5) * 60;
      targetDriftY = (Math.random() - 0.5) * 40;
    }

    function updateDrift() {
      driftX += (targetDriftX - driftX) * 0.008;
      driftY += (targetDriftY - driftY) * 0.008;
      ambient.style.transform = `translate(calc(-50% + ${driftX}px), calc(-50% + ${driftY}px))`;
      requestAnimationFrame(updateDrift);
    }

    newDriftTarget();
    updateDrift();
    setInterval(newDriftTarget, 6000);
  }


  // ── Grain Refresh ────────────────────────────────

  const grain = document.querySelector('.grain');
  if (grain) {
    function shiftGrain() {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      grain.style.backgroundPosition = `${x}px ${y}px`;
      requestAnimationFrame(shiftGrain);
    }
    shiftGrain();
  }

})();
