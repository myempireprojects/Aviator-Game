/* =====================================================================
   game.js  –  Aviator client-side engine
   Listens to Firestore `game_state/current` and drives all UI/canvas.
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
  let gameStatus  = "waiting"; // "waiting" | "flying" | "crashed"
  let currentMult = 1.0;
  let history     = JSON.parse(localStorage.getItem("aviator_history") || "[]");

  // Canvas curve data
  let curvePoints = [];
  let planeX = 0, planeY = 0;
  let animFrame;

  // ── Helpers ───────────────────────────────────────────────────────────
  function saveBalance() {
    localStorage.setItem("aviator_balance", balance.toFixed(2));
  }
  function saveHistory() {
    localStorage.setItem("aviator_history", JSON.stringify(history.slice(-20)));
  }

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
        top:${Math.random() * 100}%;
        left:${Math.random() * 100}%;
        --d:${(Math.random() * 3 + 1.5).toFixed(1)}s;
        animation-delay:${(Math.random() * 3).toFixed(1)}s
      `;
      container.appendChild(s);
    }
  }

  // ── Canvas drawing ────────────────────────────────────────────────────
  const W = () => canvas.offsetWidth;
  const H = () => canvas.offsetHeight;

  function mapMult(m) {
    // Map multiplier → x,y position on canvas
    const progress = Math.min((m - 1) / 15, 1); // saturate at 16x
    const x = progress * W() * 0.88;
    // Exponential curve upward
    const y = H() - 30 - (progress * progress * (H() - 60));
    return { x, y };
  }

  function drawScene(mult) {
    const w = W(), h = H();
    ctx.clearRect(0, 0, w, h);

    if (curvePoints.length < 2) return;

    // ── Gradient fill under curve ──
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

    // ── Glowing curve line ──
    ctx.beginPath();
    ctx.moveTo(curvePoints[0].x, curvePoints[0].y);
    for (const p of curvePoints) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = "#e91e63";
    ctx.lineWidth   = 3;
    ctx.shadowColor = "#e91e63";
    ctx.shadowBlur  = 16;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // ── Grid lines (faint) ──
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx < w; gx += w / 5) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    }
    for (let gy = 0; gy < h; gy += h / 4) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }

    // ── Plane ──
    if (gameStatus === "flying" && curvePoints.length > 1) {
      const tip = curvePoints[curvePoints.length - 1];
      const prev = curvePoints[curvePoints.length - 2];
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

    // Simple SVG-style plane drawn with canvas paths
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    // Fuselage
    ctx.ellipse(0, 0, 22, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Wing
    ctx.beginPath();
    ctx.moveTo(-4, 0);
    ctx.lineTo(-14, -18);
    ctx.lineTo(-20, -18);
    ctx.lineTo(-8, 0);
    ctx.fill();

    // Tail fin
    ctx.beginPath();
    ctx.moveTo(-18, 0);
    ctx.lineTo(-28, -10);
    ctx.lineTo(-28, 0);
    ctx.fill();

    // Engine glow trail
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

  // ── Game round handling ───────────────────────────────────────────────
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
    // Limit array so old points don't persist forever
    if (curvePoints.length > 300) curvePoints.shift();

    drawScene(mult);

    // Update cashout button label
    if (hasBet) {
      const potential = (betAmount * mult).toFixed(2);
      actionBtn.textContent = `CASH OUT  $${potential}`;
    }
  }

  function handleCrash(finalMult) {
    gameStatus = "crashed";

    // Player lost their bet
    if (hasBet) {
      hasBet = false;
      setButtonState("bet");
    }

    multDisplay.classList.add("crashed");
    multDisplay.textContent = `CRASHED @ ${finalMult.toFixed(2)}x`;
    phaseBadge.textContent  = "CRASHED";

    // Push to history
    history.unshift(finalMult);
    if (history.length > 20) history.pop();
    saveHistory();
    renderHistory();

    // Draw final scene with red line
    drawScene(finalMult);

    // Countdown to next round (assumes server does 5s wait)
    startCountdown(5);
  }

  function handleWaiting() {
    gameStatus = "waiting";
    phaseBadge.textContent = "WAITING FOR NEXT ROUND";
    multDisplay.classList.remove("crashed", "cashed");
    multDisplay.textContent = "1.00x";
    curvePoints = [];
    ctx.clearRect(0, 0, W(), H());
  }

  function handleFlying(mult) {
    if (gameStatus !== "flying") {
      gameStatus = "flying";
      phaseBadge.textContent = "FLYING";
      startRound();
      // Activate bet if player had queued one
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
      if (s <= 0) {
        clearInterval(countdownTimer);
        countdownEl.classList.remove("visible");
      } else {
        countdownEl.textContent = s;
      }
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

  // ── Action button handler ─────────────────────────────────────────────
  actionBtn.addEventListener("click", () => {
    const bet = parseFloat(betInput.value) || 10;

    if (!hasBet && gameStatus !== "flying") {
      // Queue bet for next round
      if (bet > balance) {
        shakeElement(betInput);
        return;
      }
      betAmount = bet;
      balance -= betAmount;
      setBalance(balance);
      hasBet = true;
      setButtonState("waiting");

    } else if (!hasBet && gameStatus === "flying") {
      // Bet mid-flight (allowed)
      if (bet > balance) {
        shakeElement(betInput);
        return;
      }
      betAmount = bet;
      balance -= betAmount;
      setBalance(balance);
      hasBet = true;
      setButtonState("cashout");

    } else if (hasBet && gameStatus === "flying") {
      // CASH OUT
      const winnings = betAmount * currentMult;
      balance += winnings;
      setBalance(balance);
      hasBet = false;

      multDisplay.classList.add("cashed");
      showToast(winnings);
      setButtonState("bet");
    }
  });

  // ── Quick bet buttons ─────────────────────────────────────────────────
  document.querySelectorAll(".qb").forEach(btn => {
    btn.addEventListener("click", () => {
      betInput.value = btn.dataset.amt;
    });
  });

  // ── Toast ─────────────────────────────────────────────────────────────
  let toastTimeout;
  function showToast(amount) {
    toastAmt.textContent = `+$${amount.toFixed(2)}`;
    toast.classList.add("show");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("show"), 2500);
  }

  // ── Shake helper ──────────────────────────────────────────────────────
  function shakeElement(el) {
    el.style.animation = "none";
    requestAnimationFrame(() => {
      el.style.animation = "shake 0.4s ease";
    });
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

  // ── Firebase listener ─────────────────────────────────────────────────
  function initFirebase() {
    if (!window.db || !window.onSnapshot || !window.firestoreDoc) {
      console.warn("Firebase not ready yet – retrying in 500ms");
      setTimeout(initFirebase, 500);
      return;
    }

    const gameRef = window.firestoreDoc(window.db, "game_state", "current");

    window.onSnapshot(gameRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      const mult = Number(data.multiplier) || 1.0;
      const status = data.status || "waiting";

      if (status === "crashed") {
        handleCrash(mult);
      } else if (status === "flying") {
        handleFlying(mult);
      } else {
        handleWaiting();
      }
    }, (err) => {
      console.error("Firestore error:", err);
      phaseBadge.textContent = "CONNECTION ERROR";
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────
  resizeCanvas();
  buildStars();
  setBalance(balance);
  renderHistory();

  window.addEventListener("resize", () => {
    resizeCanvas();
    drawScene(currentMult);
  });

  // Wait for firebase-ready event OR just start polling
  if (window.db) {
    initFirebase();
  } else {
    window.addEventListener("firebase-ready", initFirebase, { once: true });
    setTimeout(initFirebase, 3000); // fallback
  }
})();
