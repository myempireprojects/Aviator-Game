/* =====================================================================
   game.js  –  Aviator client-side engine
   Primary:  Firestore `game_state/current` real-time listener
   Fallback: Local simulation engine (activates if Firebase fails/times out)
   ===================================================================== */

(function () {
  "use strict";

  // ── DOM refs ──────────────────────────────────────────────────────────
  const canvas      = document.getElementById("gameCanvas");
  const ctx         = canvas.getContext("2d");
  const multDisplay = document.getElementById("multiplier");
  const actionBtn   = document.getElementById("actionBtn");
  const balDisplay  = document.getElementById("balance-val");
  const phaseBadge  = document.getElementById("phase-badge");
  const historyEl   = document.getElementById("history");
  const toast       = document.getElementById("toast");
  const toastAmt    = document.getElementById("toast-amt");
  const betInput    = document.getElementById("betInput");
  const countdownEl = document.getElementById("countdown-overlay");

  // ── State ─────────────────────────────────────────────────────────────
  let balance     = parseFloat(localStorage.getItem("aviator_balance") || "100");
  let hasBet      = false;
  let betAmount   = 10;
  let gameStatus  = "waiting";
  let currentMult = 1.0;
  let history     = JSON.parse(localStorage.getItem("aviator_history") || "[]");

  let curvePoints = [];

  // Connection tracking
  let firebaseConnected = false;
  let usingLocalMode    = false;
  let firebaseTimeoutId = null;

  // ── Helpers ───────────────────────────────────────────────────────────
  function saveBalance() { localStorage.setItem("aviator_balance", balance.toFixed(2)); }
  function saveHistory()  { localStorage.setItem("aviator_history", JSON.stringify(history.slice(-20))); }

  function setBalance(val) {
    balance = val;
    balDisplay.textContent = balance.toFixed(2);
    saveBalance();
  }

  function resizeCanvas() {
    canvas.width  = canvas.offsetWidth  * window.devicePixelRatio;
    canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  // ── Stars ─────────────────────────────────────────────────────────────
  function buildStars() {
    const container = document.getElementById("stars");
    container.innerHTML = "";
    for (let i = 0; i < 80; i++) {
      const s = document.createElement("div");
      s.className = "star";
      const size = Math.random() * 2.5 + 0.5;
      s.style.cssText = `
        width:${size}px; height:${size}px;
        top:${Math.random()*100}%;
        left:${Math.random()*100}%;
        --d:${(Math.random()*3+1.5).toFixed(1)}s;
        animation-delay:${(Math.random()*3).toFixed(1)}s
      `;
      container.appendChild(s);
    }
  }

  // ── Canvas drawing ────────────────────────────────────────────────────
  const W = () => canvas.offsetWidth;
  const H = () => canvas.offsetHeight;

  function mapMult(m) {
    const progress = Math.min((m - 1) / 15, 1);
    const x = progress * W() * 0.88;
    const y = H() - 30 - (progress * progress * (H() - 60));
    return { x, y };
  }

  function drawScene() {
    const w = W(), h = H();
    ctx.clearRect(0, 0, w, h);
    if (curvePoints.length < 2) return;

    // Gradient fill
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "rgba(233,30,99,0.25)");
    grad.addColorStop(1, "rgba(233,30,99,0)");
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (const p of curvePoints) ctx.lineTo(p.x, p.y);
    ctx.lineTo(curvePoints[curvePoints.length - 1].x, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Glowing curve line
    ctx.beginPath();
    ctx.moveTo(curvePoints[0].x, curvePoints[0].y);
    for (const p of curvePoints) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = "#e91e63";
    ctx.lineWidth   = 3;
    ctx.shadowColor = "#e91e63";
    ctx.shadowBlur  = 16;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // Grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx < w; gx += w / 5) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    }
    for (let gy = 0; gy < h; gy += h / 4) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }

    // Plane
    if (gameStatus === "flying" && curvePoints.length > 1) {
      const tip   = curvePoints[curvePoints.length - 1];
      const prev  = curvePoints[curvePoints.length - 2];
      const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x);
      drawPlane(tip.x, tip.y, angle);
    }
  }

  function drawPlane(x, y, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.shadowColor = "#fff";
    ctx.shadowBlur  = 10;
    ctx.fillStyle   = "#ffffff";

    ctx.beginPath();
    ctx.ellipse(0, 0, 22, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(-4, 0); ctx.lineTo(-14, -18); ctx.lineTo(-20, -18); ctx.lineTo(-8, 0);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(-18, 0); ctx.lineTo(-28, -10); ctx.lineTo(-28, 0);
    ctx.fill();

    const trail = ctx.createLinearGradient(-22, 0, -50, 0);
    trail.addColorStop(0, "rgba(255,100,50,0.8)");
    trail.addColorStop(1, "rgba(255,100,50,0)");
    ctx.fillStyle = trail;
    ctx.beginPath();
    ctx.ellipse(-30, 0, 18, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // ── Shared round handlers ─────────────────────────────────────────────
  function badgeText(label) {
    return usingLocalMode ? label + "  •  OFFLINE MODE" : label;
  }

  function startRound() {
    curvePoints = [];
    multDisplay.classList.remove("crashed", "cashed");
    countdownEl.classList.remove("visible");
  }

  function updateFlying(mult) {
    currentMult = mult;
    multDisplay.textContent = mult.toFixed(2) + "x";
    const pos = mapMult(mult);
    curvePoints.push({ x: pos.x, y: pos.y });
    if (curvePoints.length > 300) curvePoints.shift();
    drawScene();
    if (hasBet) actionBtn.textContent = `CASH OUT  $${(betAmount * mult).toFixed(2)}`;
  }

  function handleCrash(finalMult) {
    gameStatus = "crashed";
    if (hasBet) { hasBet = false; setButtonState("bet"); }
    multDisplay.classList.add("crashed");
    multDisplay.textContent = `CRASHED @ ${finalMult.toFixed(2)}x`;
    phaseBadge.textContent  = badgeText("CRASHED");
    history.unshift(finalMult);
    if (history.length > 20) history.pop();
    saveHistory();
    renderHistory();
    drawScene();
    startCountdown(5);
  }

  function handleWaiting() {
    gameStatus = "waiting";
    phaseBadge.textContent = badgeText("WAITING FOR NEXT ROUND");
    multDisplay.classList.remove("crashed", "cashed");
    multDisplay.textContent = "1.00x";
    curvePoints = [];
    ctx.clearRect(0, 0, W(), H());
  }

  function handleFlying(mult) {
    if (gameStatus !== "flying") {
      gameStatus = "flying";
      phaseBadge.textContent = badgeText("FLYING");
      startRound();
      if (hasBet) setButtonState("cashout");
    }
    updateFlying(mult);
  }

  // ── Countdown ─────────────────────────────────────────────────────────
  let countdownTimer;
  function startCountdown(seconds) {
    clearInterval(countdownTimer);
    let s = seconds;
    countdownEl.textContent = s;
    countdownEl.classList.add("visible");
    countdownTimer = setInterval(() => {
      s--;
      if (s <= 0) { clearInterval(countdownTimer); countdownEl.classList.remove("visible"); }
      else countdownEl.textContent = s;
    }, 1000);
  }

  // ── Button states ─────────────────────────────────────────────────────
  function setButtonState(state) {
    actionBtn.className = "";
    if (state === "bet") {
      actionBtn.classList.add("state-bet");
      actionBtn.textContent = "PLACE BET";
      actionBtn.disabled = false;
    } else if (state === "cashout") {
      actionBtn.classList.add("state-cashout");
      actionBtn.textContent = `CASH OUT  $${(betAmount * currentMult).toFixed(2)}`;
      actionBtn.disabled = false;
    } else if (state === "waiting") {
      actionBtn.classList.add("state-waiting");
      actionBtn.textContent = "BET QUEUED ✓";
      actionBtn.disabled = true;
    }
  }

  // ── Action button ──────────────────────────────────────────────────────
  actionBtn.addEventListener("click", () => {
    const bet = parseFloat(betInput.value) || 10;

    if (!hasBet && gameStatus !== "flying") {
      if (bet > balance) { shakeElement(betInput); return; }
      betAmount = bet; balance -= betAmount; setBalance(balance);
      hasBet = true; setButtonState("waiting");

    } else if (!hasBet && gameStatus === "flying") {
      if (bet > balance) { shakeElement(betInput); return; }
      betAmount = bet; balance -= betAmount; setBalance(balance);
      hasBet = true; setButtonState("cashout");

    } else if (hasBet && gameStatus === "flying") {
      const winnings = betAmount * currentMult;
      balance += winnings; setBalance(balance);
      hasBet = false;
      multDisplay.classList.add("cashed");
      showToast(winnings);
      setButtonState("bet");
    }
  });

  document.querySelectorAll(".qb").forEach(btn => {
    btn.addEventListener("click", () => { betInput.value = btn.dataset.amt; });
  });

  // ── Toast ─────────────────────────────────────────────────────────────
  let toastTimeout;
  function showToast(amount) {
    toastAmt.textContent = `+$${amount.toFixed(2)}`;
    toast.classList.add("show");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("show"), 2500);
  }

  function shakeElement(el) {
    el.style.animation = "none";
    requestAnimationFrame(() => { el.style.animation = "shake 0.4s ease"; });
  }

  // ── History ribbon ────────────────────────────────────────────────────
  function renderHistory() {
    historyEl.innerHTML = "";
    history.forEach(m => {
      const chip = document.createElement("div");
      chip.className = "hist-item " + (m < 2 ? "low" : m < 5 ? "mid" : "high");
      chip.textContent = m.toFixed(2) + "x";
      historyEl.appendChild(chip);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  //  LOCAL SIMULATION ENGINE
  //  Full Aviator game loop running entirely in the browser.
  //  Activated automatically when Firebase is unavailable.
  // ══════════════════════════════════════════════════════════════════════

  let localRafId      = null;
  let localPhase      = "idle";
  let localCrashPoint = 1.0;
  let localRoundStart = 0;

  // Crash point generator with ~5% house edge and exponential distribution
  function generateCrashPoint() {
    const r = Math.random();
    // Guarantee at least a few 1.00x rounds (~5% of time)
    if (r < 0.05) return 1.00;
    const crash = Math.floor((0.95 / (1 - r)) * 100) / 100;
    return Math.max(1.01, Math.min(crash, 200));
  }

  function showLocalModeBadge() {
    if (document.getElementById("local-badge")) return;
    const logo = document.querySelector("#topbar .logo");
    if (!logo) return;
    const badge = document.createElement("span");
    badge.id = "local-badge";
    badge.textContent = "OFFLINE";
    badge.style.cssText = `
      margin-left:10px; font-size:0.5rem; letter-spacing:2px;
      background:rgba(255,107,53,0.15); border:1px solid rgba(255,107,53,0.45);
      color:#ff6b35; padding:2px 7px; border-radius:4px;
      vertical-align:middle; -webkit-text-fill-color:#ff6b35;
    `;
    logo.appendChild(badge);
  }

  function hideLocalModeBadge() {
    const b = document.getElementById("local-badge");
    if (b) b.remove();
  }

  // rAF loop: grows multiplier exponentially until crash point is hit
  function localFlightLoop(timestamp) {
    if (localPhase !== "flying") return;

    const elapsed = timestamp - localRoundStart;
    // e^(k*t) — k=0.00006 gives smooth growth starting at ~1x/sec
    const mult    = Math.pow(Math.E, 0.00006 * elapsed);
    const rounded = Math.floor(mult * 100) / 100;

    if (rounded >= localCrashPoint) {
      localPhase = "crashed";
      handleCrash(parseFloat(localCrashPoint.toFixed(2)));
      setTimeout(localStartWaiting, 5500);
      return;
    }

    handleFlying(rounded);
    localRafId = requestAnimationFrame(localFlightLoop);
  }

  function localStartWaiting() {
    if (!usingLocalMode) return;
    localPhase = "waiting";
    handleWaiting();
    startCountdown(5);
    setTimeout(localStartFlying, 5000);
  }

  function localStartFlying() {
    if (!usingLocalMode) return;
    localPhase      = "flying";
    localCrashPoint = generateCrashPoint();
    localRoundStart = performance.now();

    if (hasBet) setButtonState("cashout");
    phaseBadge.textContent = badgeText("FLYING");
    multDisplay.classList.remove("crashed", "cashed");
    curvePoints = [];
    countdownEl.classList.remove("visible");

    cancelAnimationFrame(localRafId);
    localRafId = requestAnimationFrame(localFlightLoop);
  }

  function startLocalMode() {
    if (usingLocalMode) return;
    usingLocalMode = true;
    console.warn("[Aviator] Firebase unavailable – switching to LOCAL MODE");
    showLocalModeBadge();
    if (typeof window.hideLoader === "function") window.hideLoader();
    localStartWaiting();
  }

  // ══════════════════════════════════════════════════════════════════════
  //  FIREBASE LISTENER
  // ══════════════════════════════════════════════════════════════════════

  function initFirebase() {
    if (!window.db || !window.onSnapshot || !window.firestoreDoc) {
      setTimeout(initFirebase, 500);
      return;
    }

    const gameRef = window.firestoreDoc(window.db, "game_state", "current");

    window.onSnapshot(
      gameRef,
      (snap) => {
        if (!firebaseConnected) {
          firebaseConnected = true;
          clearTimeout(firebaseTimeoutId);

          // Firebase came back while local mode was already running
          if (usingLocalMode) {
            console.info("[Aviator] Firebase reconnected – leaving offline mode");
            usingLocalMode = false;
            localPhase     = "idle";
            cancelAnimationFrame(localRafId);
            clearInterval(countdownTimer);
            hideLocalModeBadge();
          }

          if (typeof window.hideLoader === "function") window.hideLoader();
        }

        if (!snap.exists()) return;
        const data   = snap.data();
        const mult   = Number(data.multiplier) || 1.0;
        const status = data.status || "waiting";

        if (status === "crashed")     handleCrash(mult);
        else if (status === "flying") handleFlying(mult);
        else                          handleWaiting();
      },
      (err) => {
        console.error("[Aviator] Firestore error:", err);
        if (!firebaseConnected) startLocalMode();
        else phaseBadge.textContent = badgeText("CONNECTION ERROR – RETRYING");
      }
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════════════════
  resizeCanvas();
  buildStars();
  setBalance(balance);
  renderHistory();

  window.addEventListener("resize", () => { resizeCanvas(); drawScene(); });

  // 5-second window for Firebase to respond before local mode kicks in
  firebaseTimeoutId = setTimeout(() => {
    if (!firebaseConnected) {
      console.warn("[Aviator] No Firebase response in 5 s – activating offline mode");
      startLocalMode();
    }
  }, 5000);

  if (window.db) {
    initFirebase();
  } else {
    window.addEventListener("firebase-ready", initFirebase, { once: true });
    setTimeout(initFirebase, 3000);
  }

})();
