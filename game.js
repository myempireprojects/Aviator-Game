/* ================================================================
   game.js – Aviator ZM  |  Fixed curve + plane rendering
   
   KEY FIX: Uses logarithmic mapping so:
   - Curve starts steep from bottom-left
   - Gradually flattens and levels off toward the right
   - Plane ALWAYS stays within canvas bounds
   - Smoke trail stays on canvas
================================================================ */
(function () {
  "use strict";

  /* ── Canvas ─────────────────────────────────────────────── */
  const canvas = document.getElementById("gc");
  const ctx    = canvas.getContext("2d");
  const W = () => canvas.offsetWidth;
  const H = () => canvas.offsetHeight;

  function resizeCanvas() {
    const dpr     = window.devicePixelRatio || 1;
    canvas.width  = canvas.offsetWidth  * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ── DOM ────────────────────────────────────────────────── */
  const multEl     = document.getElementById("multiplier");
  const actionBtn  = document.getElementById("actionBtn");
  const balDisp    = document.getElementById("bal-disp");
  const mBalDisp   = document.getElementById("m-bal");
  const phaseBadge = document.getElementById("phase-badge");
  const histEl     = document.getElementById("history");
  const cdownEl    = document.getElementById("cdown");
  const connBadge  = document.getElementById("conn-badge");
  const betInput   = document.getElementById("betInput");
  const toast      = document.getElementById("toast");
  const tAmt       = document.getElementById("t-amt");
  const errToast   = document.getElementById("err-toast");
  const modalOv    = document.getElementById("modal-ov");
  const closeBtn   = document.getElementById("closeModal");
  const walletBtn  = document.getElementById("walletBtn");
  const tDep       = document.getElementById("tDep");
  const tWit       = document.getElementById("tWit");
  const tHistBtn   = document.getElementById("tHist");
  const tabForm    = document.getElementById("tab-form");
  const tabHistEl  = document.getElementById("tab-hist");
  const wdFields   = document.getElementById("wdraw-fields");
  const mAmt       = document.getElementById("mAmt");
  const confirmBtn = document.getElementById("confirmBtn");
  const txList     = document.getElementById("txList");

  let autoBetChk, autoCashChk, autoCashInput;

  /* ── Constants ──────────────────────────────────────────── */
  const MIN_BET     = 0.50;
  const COUNTDOWN_S = 5;

  /* ── Storage ────────────────────────────────────────────── */
  let balance   = parseFloat(localStorage.getItem("zav_bal") || "0");
  let txHistory = JSON.parse(localStorage.getItem("zav_tx")  || "[]");
  let roundHist = JSON.parse(localStorage.getItem("zav_rh")  || "[]");

  /* ── Game state ─────────────────────────────────────────── */
  let status      = "waiting";
  let currentMult = 1.00;
  let activeBet   = null;   // { amount } live this round
  let queuedBet   = null;   // { amount } for next round
  let activeTab   = "dep";
  let fbOk        = false;

  /* ── Animation state ────────────────────────────────────── */
  let rafId       = null;
  let lastTs      = 0;
  let bounceT     = 0;
  let curvePoints = [];     // raw multiplier values (not pixel coords)
  let smoke       = [];

  /* ── Balance ────────────────────────────────────────────── */
  function saveBalance() {
    localStorage.setItem("zav_bal", balance.toFixed(2));
    balDisp.textContent  = balance.toFixed(2);
    mBalDisp.textContent = balance.toFixed(2);
  }

  /* ─────────────────────────────────────────────────────────
     CURVE MATH
     
     Maps a multiplier value → pixel (x, y) on canvas.
     
     Uses log scale so:
       1.00x → bottom-left  (x=MARGIN, y=H-MARGIN)
       2.00x → ~30% across, curve bending up
       5.00x → ~60% across, starting to flatten
       10x+  → ~80-90% across, nearly horizontal
     
     This mirrors real Aviator behaviour exactly.
  ───────────────────────────────────────────────────────── */
  const MARGIN = 30; // px padding from edges

  function multToXY(m) {
    const w = W();
    const h = H();

    // X: linear in log space — spreads low mults across more of the canvas
    // log(1)=0, log(2)≈0.69, log(10)≈2.30
    // We cap display at ~50x max visible
    const logMax = Math.log(50);
    const logM   = Math.log(Math.max(m, 1.001));
    const xPct   = Math.min(logM / logMax, 1);
    const x      = MARGIN + xPct * (w - MARGIN * 2);

    // Y: starts at bottom, rises quickly at first then flattens
    // Use square root of xPct so it levels off
    const yRange = h - MARGIN * 2;
    const yPct   = Math.sqrt(xPct);          // fast rise → gradual flatten
    const y      = (h - MARGIN) - yPct * yRange;

    return { x, y };
  }

  /* ─────────────────────────────────────────────────────────
     SMOKE PARTICLES
  ───────────────────────────────────────────────────────── */
  function spawnSmoke(x, y, angle) {
    for (let i = 0; i < 3; i++) {
      const sp = (Math.random() - 0.5) * 0.6;
      const speed = 0.8 + Math.random() * 1.6;
      smoke.push({
        x, y,
        vx: Math.cos(angle + Math.PI + sp) * speed,
        vy: Math.sin(angle + Math.PI + sp) * speed,
        life: 1.0,
        decay: 0.018 + Math.random() * 0.016,
        r: 5 + Math.random() * 8,
        hot: Math.random() > 0.4
      });
    }
  }

  function tickSmoke() {
    smoke = smoke.filter(p => p.life > 0.02);
    for (const p of smoke) {
      p.x    += p.vx;
      p.y    += p.vy;
      p.r    *= 1.045;
      p.life -= p.decay;
    }
  }

  function drawSmoke() {
    for (const p of smoke) {
      const col = p.hot ? "255,140,40" : "180,190,215";
      const g   = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      g.addColorStop(0, `rgba(${col},${(p.life * 0.65).toFixed(2)})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ─────────────────────────────────────────────────────────
     DRAW PLANE
     x,y = tip position (nose of plane)
     angle = direction of travel
  ───────────────────────────────────────────────────────── */
  function drawPlane(x, y, angle, bounce) {
    ctx.save();
    ctx.translate(x, y + bounce);
    ctx.rotate(angle);

    ctx.shadowColor = "rgba(180,220,255,0.9)";
    ctx.shadowBlur  = 18;

    // Fuselage
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(28, 0);
    ctx.bezierCurveTo(18, -5, -10, -5, -18, 0);
    ctx.bezierCurveTo(-10,  5,  18,  5,  28, 0);
    ctx.fill();

    // Main wing
    ctx.fillStyle = "#dde4ff";
    ctx.beginPath();
    ctx.moveTo(6, -1);
    ctx.lineTo(-3, -22);
    ctx.lineTo(-13, -22);
    ctx.lineTo(-2, -1);
    ctx.closePath();
    ctx.fill();

    // Tail fin
    ctx.fillStyle = "#c0caff";
    ctx.beginPath();
    ctx.moveTo(-13, 0);
    ctx.lineTo(-22, -12);
    ctx.lineTo(-25, 0);
    ctx.closePath();
    ctx.fill();

    // Cockpit
    ctx.fillStyle = "rgba(80,200,255,0.8)";
    ctx.beginPath();
    ctx.ellipse(16, -2, 5.5, 3, -0.1, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.restore();
  }

  /* ─────────────────────────────────────────────────────────
     DRAW SCENE
  ───────────────────────────────────────────────────────── */
  function drawScene() {
    const w = W(), h = H();
    ctx.clearRect(0, 0, w, h);

    // Faint grid
    ctx.strokeStyle = "rgba(255,255,255,0.03)";
    ctx.lineWidth   = 1;
    for (let gx = w / 5; gx < w; gx += w / 5) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    }
    for (let gy = h / 4; gy < h; gy += h / 4) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }

    // Need at least 2 points to draw curve
    if (curvePoints.length < 2) {
      // Show plane sitting at start before curve builds
      if (status === "flying") {
        const pos = multToXY(1.00);
        drawPlane(pos.x, pos.y, -0.35, 0);
      }
      return;
    }

    // Convert stored multiplier values → pixel coords
    const pixels = curvePoints.map(m => multToXY(m));
    const first  = pixels[0];
    const last   = pixels[pixels.length - 1];

    // Gradient fill under curve
    const fill = ctx.createLinearGradient(0, first.y, 0, h);
    if (status === "crashed") {
      fill.addColorStop(0, "rgba(255,23,68,0.20)");
      fill.addColorStop(1, "rgba(255,23,68,0.02)");
    } else {
      fill.addColorStop(0, "rgba(233,30,99,0.28)");
      fill.addColorStop(1, "rgba(233,30,99,0.02)");
    }
    ctx.beginPath();
    ctx.moveTo(first.x, h - MARGIN);
    for (const p of pixels) ctx.lineTo(p.x, p.y);
    ctx.lineTo(last.x, h - MARGIN);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    // Curve line with glow
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const p of pixels) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = status === "crashed" ? "#ff1744" : "#e91e63";
    ctx.lineWidth   = 3;
    ctx.shadowColor = status === "crashed" ? "#ff1744" : "#e91e63";
    ctx.shadowBlur  = 18;
    ctx.lineJoin    = "round";
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // Smoke
    drawSmoke();

    // Plane at tip (only while flying)
    if (status === "flying" && pixels.length >= 2) {
      const tip  = pixels[pixels.length - 1];
      // Use several points back for a smoother angle
      const back = pixels[Math.max(0, pixels.length - 8)];
      const angle  = Math.atan2(tip.y - back.y, tip.x - back.x);
      const bounce = Math.sin(bounceT * 4) * 3;
      drawPlane(tip.x, tip.y, angle, bounce);

      // Spawn smoke at engine (behind plane)
      spawnSmoke(tip.x, tip.y, angle);
    }
  }

  /* ─────────────────────────────────────────────────────────
     RAF LOOP — runs at 60fps while flying
  ───────────────────────────────────────────────────────── */
  function startLoop() {
    cancelAnimationFrame(rafId);
    lastTs = performance.now();

    function loop(ts) {
      const dt = Math.min(ts - lastTs, 50);
      lastTs   = ts;
      bounceT += dt * 0.001;

      if (status === "flying") {
        // Grow multiplier locally for smooth animation
        // Formula matches server: compound growth ~0.45% per 100ms
        const growth = currentMult * 0.0045 * (dt / 100);
        currentMult  = Math.round((currentMult + growth) * 100) / 100;

        multEl.textContent = currentMult.toFixed(2) + "x";

        // Store multiplier value (not pixels — pixels recalculated in draw)
        curvePoints.push(currentMult);
        // Keep only enough for a smooth visual — older points still render correctly
        if (curvePoints.length > 800) curvePoints.shift();

        // Auto cash-out
        if (activeBet && autoCashChk && autoCashChk.checked) {
          const target = parseFloat(autoCashInput.value) || 99999;
          if (target >= 1.20 && currentMult >= target) {
            doCashOut();
          }
        }

        // Update cash-out button
        if (activeBet) {
          actionBtn.textContent = `CASH OUT  K${(activeBet.amount * currentMult).toFixed(2)}`;
        }
      }

      tickSmoke();
      drawScene();
      rafId = requestAnimationFrame(loop);
    }

    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  /* ─────────────────────────────────────────────────────────
     GAME PHASE HANDLERS
  ───────────────────────────────────────────────────────── */
  function beginWaiting() {
    status      = "waiting";
    currentMult = 1.00;
    curvePoints = [];
    smoke       = [];
    multEl.classList.remove("crashed", "cashed");
    multEl.textContent     = "";
    phaseBadge.textContent = "BETTING OPEN";
    stopLoop();
    ctx.clearRect(0, 0, W(), H());
    drawScene();
  }

  function beginFlying(serverMult) {
    if (status === "flying") return;
    status      = "flying";
    currentMult = serverMult || 1.00;
    curvePoints = [currentMult];
    smoke       = [];
    bounceT     = 0;

    multEl.classList.remove("crashed", "cashed");
    multEl.textContent     = currentMult.toFixed(2) + "x";
    phaseBadge.textContent = "FLYING";
    cdownEl.classList.remove("on");

    // Promote queued bet → active bet
    if (queuedBet) {
      activeBet = queuedBet;
      queuedBet = null;
      setBtn("cash");
    } else {
      // No bet this round — show locked state
      setBtn("locked");
    }

    startLoop();
  }

  function beginCrashed(finalMult) {
    if (status === "crashed") return;
    status = "crashed";
    stopLoop();

    currentMult = finalMult;
    curvePoints.push(finalMult);

    multEl.classList.add("crashed");
    multEl.textContent     = `CRASHED @ ${finalMult.toFixed(2)}x`;
    phaseBadge.textContent = "CRASHED!";

    // Lose active bet
    if (activeBet) {
      showErr(`Crashed at ${finalMult.toFixed(2)}x — K${activeBet.amount.toFixed(2)} lost`);
      activeBet = null;
    }

    // Keep queued bet — it fires next round
    // Show appropriate button
    if (queuedBet) {
      setBtn("wait");
    } else {
      setBtn("bet");
    }

    // Record crash
    roundHist.unshift(finalMult);
    if (roundHist.length > 30) roundHist.pop();
    localStorage.setItem("zav_rh", JSON.stringify(roundHist));
    renderHistory();
    drawScene();

    // ── 5-second countdown ──────────────────────────────
    // Phase 1 (5s): show "CRASHED" with countdown
    // Phase 2 (after 0): switch to "BETTING OPEN", accept new bets
    // Phase 3 (after short gap): begin flying

    const doAutoBet = autoBetChk && autoBetChk.checked;
    let s = COUNTDOWN_S;

    // Show countdown overlay
    cdownEl.innerHTML = `<div style="text-align:center">
      <div style="font-size:1rem;letter-spacing:3px;color:#7986cb;margin-bottom:8px">NEXT ROUND IN</div>
      <div id="cd-num" style="font-size:4rem;font-weight:900">${s}</div>
    </div>`;
    cdownEl.classList.add("on");
    phaseBadge.textContent = "CRASHED — BETTING OPEN";

    const cdNum = () => document.getElementById("cd-num");

    const cd = setInterval(() => {
      s--;
      if (cdNum()) cdNum().textContent = s;

      if (s <= 0) {
        clearInterval(cd);
        cdownEl.classList.remove("on");

        // Auto-bet queues before round starts
        if (doAutoBet && !queuedBet && !activeBet) {
          queueBet(Math.round((parseFloat(betInput.value) || MIN_BET) * 100) / 100, true);
        }

        // Brief "Starting…" flash
        beginWaiting();

        // Start flight after tiny gap
        setTimeout(() => {
          // Only self-start in demo mode (Firebase will push its own "flying" event)
          if (!fbOk) beginFlying(1.00);
        }, 700);
      }
    }, 1000);
  }

  /* ─────────────────────────────────────────────────────────
     BET LOGIC
  ───────────────────────────────────────────────────────── */
  function queueBet(amount, silent) {
    amount = Math.round(amount * 100) / 100;
    if (amount < MIN_BET) {
      if (!silent) showErr(`Minimum bet is K${MIN_BET.toFixed(2)}`);
      return false;
    }
    if (amount > balance) {
      if (!silent) { showErr("Insufficient balance"); openWallet("dep"); }
      return false;
    }
    balance  -= amount;
    saveBalance();
    queuedBet = { amount };
    setBtn("wait");
    if (!silent) showInfo(`K${amount.toFixed(2)} queued for next round`);
    return true;
  }

  function doCashOut() {
    if (!activeBet || status !== "flying") return;
    const win  = Math.round(activeBet.amount * currentMult * 100) / 100;
    balance   += win;
    saveBalance();
    activeBet  = null;
    multEl.classList.add("cashed");
    showToast(win);
    setBtn("bet");
  }

  /* ─────────────────────────────────────────────────────────
     ACTION BUTTON
  ───────────────────────────────────────────────────────── */
  actionBtn.addEventListener("click", () => {
    const bet = Math.round((parseFloat(betInput.value) || 0) * 100) / 100;

    if (status === "flying") {
      // During flight: ONLY cash out is allowed — no new bets
      if (activeBet) {
        doCashOut();
      } else {
        // No active bet during flight — show info, do nothing
        showInfo("Round in progress — bet queued for next round");
      }
    } else {
      // Waiting or crashed: queue bet for next round
      if (!queuedBet && !activeBet) {
        if (balance < MIN_BET) { showErr("Please deposit first"); openWallet("dep"); return; }
        queueBet(bet, false);
      } else if (queuedBet) {
        // Tap again to cancel queued bet
        balance  += queuedBet.amount;
        saveBalance();
        queuedBet = null;
        setBtn("bet");
        showInfo("Queued bet cancelled — refunded");
      }
    }
  });

  /* ── Button state ─────────────────────────────────────── */
  function setBtn(state) {
    actionBtn.className = "";
    actionBtn.disabled  = false;

    if (state === "bet") {
      actionBtn.classList.add("s-bet");
      actionBtn.textContent = "PLACE BET";
    } else if (state === "cash") {
      actionBtn.classList.add("s-cash");
      const val = activeBet ? (activeBet.amount * currentMult).toFixed(2) : "0.00";
      actionBtn.textContent = `CASH OUT  K${val}`;
    } else if (state === "locked") {
      // Round in progress, no bet placed
      actionBtn.classList.add("s-wait");
      actionBtn.textContent = "ROUND IN PROGRESS…";
      actionBtn.disabled = true;
    } else {
      // "wait" — queued bet pending
      actionBtn.classList.add("s-wait");
      const qa = queuedBet ? queuedBet.amount.toFixed(2) : "?";
      actionBtn.textContent = `K${qa} QUEUED — TAP TO CANCEL`;
    }
  }

  /* ── Quick bet ────────────────────────────────────────── */
  document.querySelectorAll(".qb").forEach(b =>
    b.addEventListener("click", () => { betInput.value = b.dataset.a; })
  );

  /* ─────────────────────────────────────────────────────────
     AUTO CONTROLS
  ───────────────────────────────────────────────────────── */
  function buildAutoControls() {
    const btm = document.getElementById("btm");
    const row = document.createElement("div");
    row.id = "auto-row";
    row.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:2px 0";
    row.innerHTML = `
      <label style="display:flex;align-items:center;gap:6px;font-size:.76rem;color:var(--muted);cursor:pointer;user-select:none;white-space:nowrap">
        <input type="checkbox" id="autoBetChk" style="accent-color:#e91e63;width:15px;height:15px;flex-shrink:0"/>
        AUTO BET
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:.76rem;color:var(--muted);cursor:pointer;user-select:none;white-space:nowrap">
        <input type="checkbox" id="autoCashChk" style="accent-color:#00e676;width:15px;height:15px;flex-shrink:0"/>
        AUTO CASH-OUT @
      </label>
      <div style="display:flex;align-items:center;gap:4px;flex:1;min-width:70px;max-width:110px">
        <input id="autoCashInput" type="number" value="1.50" min="1.20" step="0.01"
          style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;
                 color:var(--text);font-family:'Orbitron',sans-serif;font-size:.82rem;
                 padding:7px 8px;outline:none;text-align:center;-moz-appearance:textfield;"/>
        <span style="font-size:.72rem;color:var(--muted);flex-shrink:0">x</span>
      </div>
    `;
    btm.insertBefore(row, document.getElementById("actionBtn"));

    autoBetChk    = document.getElementById("autoBetChk");
    autoCashChk   = document.getElementById("autoCashChk");
    autoCashInput = document.getElementById("autoCashInput");

    // Remove webkit spinners
    const st = document.createElement("style");
    st.textContent = `
      #autoCashInput::-webkit-inner-spin-button,
      #autoCashInput::-webkit-outer-spin-button { -webkit-appearance: none; }
      #autoCashInput:focus { border-color: var(--green) !important; }
    `;
    document.head.appendChild(st);

    // Clamp to minimum 1.20
    autoCashInput.addEventListener("blur", () => {
      const v = parseFloat(autoCashInput.value);
      if (isNaN(v) || v < 1.20) autoCashInput.value = "1.20";
    });
  }

  /* ─────────────────────────────────────────────────────────
     HISTORY RIBBON
  ───────────────────────────────────────────────────────── */
  function renderHistory() {
    histEl.innerHTML = "";
    roundHist.forEach(m => {
      const c = document.createElement("div");
      c.className   = "hchip " + (m < 2 ? "lo" : m < 5 ? "mi" : "hi");
      c.textContent = m.toFixed(2) + "x";
      histEl.prepend(c);  // newest first on left
    });
  }

  /* ─────────────────────────────────────────────────────────
     STARS
  ───────────────────────────────────────────────────────── */
  function buildStars() {
    const el = document.getElementById("stars");
    el.innerHTML = "";
    for (let i = 0; i < 80; i++) {
      const s  = document.createElement("div");
      s.className = "star";
      const sz = Math.random() * 2.4 + 0.3;
      s.style.cssText = `width:${sz}px;height:${sz}px;top:${Math.random()*100}%;left:${Math.random()*100}%;--d:${(Math.random()*3+1.5).toFixed(1)}s;animation-delay:${(Math.random()*3).toFixed(1)}s`;
      el.appendChild(s);
    }
  }

  /* ─────────────────────────────────────────────────────────
     TOASTS
  ───────────────────────────────────────────────────────── */
  let toastTm, errTm;

  function showToast(amt) {
    tAmt.textContent = `+K${amt.toFixed(2)}`;
    toast.classList.add("on");
    clearTimeout(toastTm);
    toastTm = setTimeout(() => toast.classList.remove("on"), 2600);
  }

  function showErr(msg) {
    errToast.removeAttribute("style");
    errToast.textContent = msg;
    errToast.classList.add("on");
    clearTimeout(errTm);
    errTm = setTimeout(() => errToast.classList.remove("on"), 2800);
  }

  function showInfo(msg) {
    errToast.style.cssText = "background:#0a2218;border-color:var(--green);color:#69f0ae";
    errToast.textContent   = msg;
    errToast.classList.add("on");
    clearTimeout(errTm);
    errTm = setTimeout(() => {
      errToast.classList.remove("on");
      setTimeout(() => errToast.removeAttribute("style"), 400);
    }, 2500);
  }

  /* ─────────────────────────────────────────────────────────
     WALLET MODAL
  ───────────────────────────────────────────────────────── */
  function openWallet(tab) {
    setWalletTab(tab || activeTab);
    mBalDisp.textContent = balance.toFixed(2);
    modalOv.classList.add("open");
  }
  function closeWallet() { modalOv.classList.remove("open"); }

  walletBtn.addEventListener("click", () => openWallet(activeTab));
  closeBtn.addEventListener("click", closeWallet);
  modalOv.addEventListener("click", e => { if (e.target === modalOv) closeWallet(); });
  tDep.addEventListener("click",     () => setWalletTab("dep"));
  tWit.addEventListener("click",     () => setWalletTab("wit"));
  tHistBtn.addEventListener("click", () => setWalletTab("hist"));

  function setWalletTab(t) {
    activeTab = t;
    [tDep, tWit, tHistBtn].forEach(b => b.classList.remove("on"));
    tabForm.style.display   = "none";
    tabHistEl.style.display = "none";
    wdFields.classList.remove("vis");
    confirmBtn.className    = "";

    if (t === "dep") {
      tDep.classList.add("on");
      tabForm.style.display  = "block";
      confirmBtn.className   = "dep";
      confirmBtn.textContent = "DEPOSIT FUNDS";
    } else if (t === "wit") {
      tWit.classList.add("on");
      tabForm.style.display  = "block";
      wdFields.classList.add("vis");
      confirmBtn.className   = "wit";
      confirmBtn.textContent = "REQUEST WITHDRAWAL";
    } else {
      tHistBtn.classList.add("on");
      tabHistEl.style.display = "block";
      renderTx();
    }
  }

  document.querySelectorAll(".qa").forEach(q =>
    q.addEventListener("click", () => { mAmt.value = q.dataset.qa; })
  );

  confirmBtn.addEventListener("click", () => {
    const amt = Math.round((parseFloat(mAmt.value) || 0) * 100) / 100;
    if (amt < MIN_BET) { showErr(`Minimum is K${MIN_BET.toFixed(2)}`); return; }

    if (activeTab === "dep") {
      balance += amt;
      saveBalance();
      addTx("DEPOSIT", amt);
      showInfo(`K${amt.toFixed(2)} deposited ✓`);
      mAmt.value = "";
      closeWallet();
    } else if (activeTab === "wit") {
      if (amt > balance) { showErr("Insufficient balance"); return; }
      const method  = document.getElementById("wMethod").value;
      const account = document.getElementById("wAccount").value.trim();
      if (!method)  { showErr("Select payment method"); return; }
      if (!account) { showErr("Enter mobile / account number"); return; }
      balance -= amt;
      saveBalance();
      addTx("WITHDRAW", -amt);
      showInfo(`Withdrawal of K${amt.toFixed(2)} requested ✓`);
      mAmt.value = "";
      closeWallet();
    }
  });

  function addTx(type, amt) {
    txHistory.unshift({ type, amt, ts: Date.now() });
    if (txHistory.length > 60) txHistory.pop();
    localStorage.setItem("zav_tx", JSON.stringify(txHistory));
  }

  function renderTx() {
    if (!txHistory.length) {
      txList.innerHTML = '<div style="color:var(--muted);font-size:.85rem;text-align:center;padding:24px 0">No transactions yet</div>';
      return;
    }
    txList.innerHTML = txHistory.map(t => {
      const d  = new Date(t.ts);
      const ts = d.toLocaleDateString("en-ZM", { day:"2-digit", month:"short" }) + " " +
                 d.toLocaleTimeString("en-ZM", { hour:"2-digit", minute:"2-digit" });
      const pos = t.amt > 0;
      return `<div class="tx-item">
        <div><div>${t.type}</div><div class="tx-meta">${ts}</div></div>
        <div class="tx-amt ${pos ? "d":"w"}">${pos?"+":""}K${Math.abs(t.amt).toFixed(2)}</div>
      </div>`;
    }).join("");
  }

  /* ─────────────────────────────────────────────────────────
     OFFLINE DEMO LOOP
  ───────────────────────────────────────────────────────── */
  let demoActive = false;

  function genCrash() {
    // House edge ~3%
    const r = Math.random();
    if (r < 0.03) return 1.00;
    const c = 0.99 / (1 - r);
    return Math.max(1.01, Math.round(c * 100) / 100);
  }

  function runDemoRound() {
    if (demoActive) return;
    demoActive = true;

    beginWaiting();

    // Show betting open countdown on canvas overlay
    let s = COUNTDOWN_S;
    cdownEl.innerHTML = `<div style="text-align:center">
      <div style="font-size:1rem;letter-spacing:3px;color:#7986cb;margin-bottom:8px">STARTING IN</div>
      <div id="cd-num" style="font-size:4rem;font-weight:900">${s}</div>
    </div>`;
    cdownEl.classList.add("on");

    const cdNum = () => document.getElementById("cd-num");

    const cd = setInterval(() => {
      s--;
      if (cdNum()) cdNum().textContent = s;
      if (s <= 0) {
        clearInterval(cd);
        cdownEl.classList.remove("on");
        startDemoFlight();
      }
    }, 1000);
  }

  function startDemoFlight() {
    const crash = genCrash();
    beginFlying(1.00);

    const poll = setInterval(() => {
      if (status !== "flying") { clearInterval(poll); return; }
      if (currentMult >= crash) {
        clearInterval(poll);
        currentMult = crash;
        beginCrashed(crash);
        // Reset demoActive after countdown so runDemoRound can be called again if needed
        setTimeout(() => { demoActive = false; }, (COUNTDOWN_S + 2) * 1000);
      }
    }, 80);
  }

  /* ─────────────────────────────────────────────────────────
     FIREBASE
  ───────────────────────────────────────────────────────── */
  function initFirebase() {
    if (!window._db || !window._snap || !window._doc) {
      setTimeout(initFirebase, 400);
      return;
    }

    const fallback = setTimeout(() => {
      if (!fbOk) {
        connBadge.textContent = "OFFLINE";
        connBadge.classList.add("offline");
        if (!demoActive) runDemoRound();
      }
    }, 5000);

    const ref = window._doc(window._db, "game_state", "current");

    window._snap(ref, snap => {
      if (!snap.exists()) return;
      if (!fbOk) {
        fbOk = true;
        clearTimeout(fallback);
        connBadge.textContent = "ONLINE";
        connBadge.classList.remove("offline");
        demoActive = true; // block demo
      }

      const d    = snap.data();
      const mult = Number(d.multiplier) || 1.00;
      const st   = d.status || "waiting";

      if (st === "flying") {
        if (status !== "flying") { currentMult = mult; beginFlying(mult); }
      } else if (st === "crashed") {
        if (status !== "crashed") beginCrashed(mult);
      } else {
        if (status !== "waiting") beginWaiting();
      }
    }, err => {
      console.error("Firestore:", err);
      connBadge.textContent = "OFFLINE";
      connBadge.classList.add("offline");
      if (!demoActive) runDemoRound();
    });
  }

  /* ─────────────────────────────────────────────────────────
     BOOT
  ───────────────────────────────────────────────────────── */
  resizeCanvas();
  buildStars();
  buildAutoControls();
  saveBalance();
  renderHistory();

  window.addEventListener("resize", () => {
    resizeCanvas();
    // Redraw with same data, new canvas size
    if (status !== "flying") drawScene();
  });

  // Start demo after short delay (Firebase takes over if connected)
  setTimeout(() => {
    if (!fbOk && !demoActive) runDemoRound();
  }, 800);

  if (window._db) {
    initFirebase();
  } else {
    window.addEventListener("fb-ready", initFirebase, { once: true });
  }

})();
