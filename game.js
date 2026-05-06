/* ================================================================
   game.js – Aviator ZM  |  Complete rewrite
   - Plane animates smoothly via rAF (independent of Firebase ticks)
   - Curve grows from bottom-left upward
   - Smoke/exhaust particle trail
   - Correct bet logic: bets during flight are QUEUED for next round
   - 5-second countdown after crash before next round
   - Auto-bet + Auto cash-out
   - Kwacha (K), K0.50 minimum
================================================================ */
(function () {
  "use strict";

  /* ─────────────────────────────────────────────────────────
     CANVAS
  ───────────────────────────────────────────────────────── */
  const canvas = document.getElementById("gc");
  const ctx    = canvas.getContext("2d");

  function W() { return canvas.offsetWidth; }
  function H() { return canvas.offsetHeight; }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = canvas.offsetWidth  * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ─────────────────────────────────────────────────────────
     DOM REFS
  ───────────────────────────────────────────────────────── */
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

  /* Wallet */
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

  /* Auto controls — injected below in HTML patch */
  let autoBetChk, autoCashChk, autoCashInput;

  /* ─────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────── */
  const MIN_BET      = 0.50;
  const COUNTDOWN_S  = 5;
  const MULT_SPEED   = 0.0045;   // per tick at 100ms → matches server

  /* ─────────────────────────────────────────────────────────
     PERSISTENT STATE
  ───────────────────────────────────────────────────────── */
  let balance      = parseFloat(localStorage.getItem("zav_bal") || "0");
  let txHistory    = JSON.parse(localStorage.getItem("zav_tx")  || "[]");
  let roundHist    = JSON.parse(localStorage.getItem("zav_rh")  || "[]");

  /* ─────────────────────────────────────────────────────────
     GAME STATE
  ───────────────────────────────────────────────────────── */
  //  status: "waiting" | "flying" | "crashed"
  let status       = "waiting";
  let currentMult  = 1.00;
  let crashPoint   = 0;          // set when round begins (demo) or from Firebase

  // Bet state
  let activeBet    = null;       // { amount } — current round live bet
  let queuedBet    = null;       // { amount } — bet waiting for next round
  let activeTab    = "dep";

  /* ─────────────────────────────────────────────────────────
     ANIMATION STATE
  ───────────────────────────────────────────────────────── */
  let rafId        = null;
  let lastTs       = 0;
  let bounceT      = 0;
  let curvePoints  = [];         // {x,y} history of plane path
  let smoke        = [];         // particles

  /* ─────────────────────────────────────────────────────────
     BALANCE HELPERS
  ───────────────────────────────────────────────────────── */
  function saveBalance() {
    localStorage.setItem("zav_bal", balance.toFixed(2));
    balDisp.textContent  = balance.toFixed(2);
    mBalDisp.textContent = balance.toFixed(2);
  }

  /* ─────────────────────────────────────────────────────────
     MULTIPLIER → CANVAS POSITION
     Plane starts at bottom-left (x≈30, y≈H-30)
     and curves up toward top-right.
  ───────────────────────────────────────────────────────── */
  function multToPos(m) {
    // progress: 0 at 1x, saturates toward 1 at ~14x
    const prog = Math.min((m - 1) / 13, 1);

    // Ease: slow start, faster rise
    const ease = prog * prog;

    const x = 30 + ease * (W() * 0.90);
    // Y: bottom of canvas → near top
    const yBot = H() - 30;
    const yTop = H() * 0.10;
    const y    = yBot - ease * (yBot - yTop);
    return { x, y };
  }

  /* ─────────────────────────────────────────────────────────
     SMOKE PARTICLES
  ───────────────────────────────────────────────────────── */
  function spawnSmoke(x, y, angle) {
    for (let i = 0; i < 3; i++) {
      const sp = (Math.random() - 0.5) * 0.5;
      smoke.push({
        x, y,
        vx: Math.cos(angle + Math.PI + sp) * (1 + Math.random() * 2),
        vy: Math.sin(angle + Math.PI + sp) * (1 + Math.random() * 2) - 0.3,
        life: 1.0,
        decay: 0.022 + Math.random() * 0.018,
        r: 4 + Math.random() * 7,
        hot: Math.random() > 0.45   // orange flame vs grey smoke
      });
    }
  }

  function tickSmoke() {
    smoke = smoke.filter(p => p.life > 0.01);
    for (const p of smoke) {
      p.x    += p.vx;
      p.y    += p.vy;
      p.r    *= 1.05;
      p.life -= p.decay;
    }
  }

  function drawSmoke() {
    for (const p of smoke) {
      const col = p.hot ? `255,130,40` : `180,190,210`;
      const g   = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      g.addColorStop(0, `rgba(${col},${(p.life * 0.7).toFixed(2)})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ─────────────────────────────────────────────────────────
     DRAW PLANE
  ───────────────────────────────────────────────────────── */
  function drawPlane(x, y, angle, bounce) {
    ctx.save();
    ctx.translate(x, y + bounce);
    ctx.rotate(angle);

    // shadow glow
    ctx.shadowColor = "rgba(180,210,255,0.8)";
    ctx.shadowBlur  = 16;

    // Fuselage
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(30, 0);
    ctx.bezierCurveTo(18, -6, -12, -5, -20, 0);
    ctx.bezierCurveTo(-12,  5,  18,  6,  30, 0);
    ctx.fill();

    // Main wing (swept back)
    ctx.fillStyle = "#dde4ff";
    ctx.beginPath();
    ctx.moveTo(8,  -1);
    ctx.lineTo(-4, -24);
    ctx.lineTo(-14,-24);
    ctx.lineTo(-2,  -1);
    ctx.closePath();
    ctx.fill();

    // Horizontal stabilizer (tail)
    ctx.fillStyle = "#c0caff";
    ctx.beginPath();
    ctx.moveTo(-15, 0);
    ctx.lineTo(-24,-13);
    ctx.lineTo(-27, 0);
    ctx.closePath();
    ctx.fill();

    // Cockpit glass
    ctx.fillStyle = "rgba(80,200,255,0.75)";
    ctx.beginPath();
    ctx.ellipse(17, -2, 6, 3.5, -0.15, 0, Math.PI * 2);
    ctx.fill();

    // Engine pod under wing
    ctx.fillStyle = "#aab4cc";
    ctx.beginPath();
    ctx.ellipse(-1, 3, 7, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.restore();
  }

  /* ─────────────────────────────────────────────────────────
     DRAW FULL SCENE
  ───────────────────────────────────────────────────────── */
  function drawScene() {
    const w = W(), h = H();
    ctx.clearRect(0, 0, w, h);

    // Faint grid
    ctx.strokeStyle = "rgba(255,255,255,0.032)";
    ctx.lineWidth   = 1;
    for (let gx = w / 5; gx < w; gx += w / 5) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    }
    for (let gy = h / 4; gy < h; gy += h / 4) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }

    if (curvePoints.length < 2) {
      // Draw plane at start position even before curve builds
      if (status === "flying") {
        const pos = multToPos(1.00);
        drawPlane(pos.x, pos.y, -0.3, 0);
      }
      return;
    }

    // Gradient fill under curve
    const last  = curvePoints[curvePoints.length - 1];
    const first = curvePoints[0];
    const fill  = ctx.createLinearGradient(0, 0, 0, h);
    if (status === "crashed") {
      fill.addColorStop(0, "rgba(255,23,68,0.22)");
      fill.addColorStop(1, "rgba(255,23,68,0)");
    } else {
      fill.addColorStop(0, "rgba(233,30,99,0.30)");
      fill.addColorStop(1, "rgba(233,30,99,0.02)");
    }
    ctx.beginPath();
    ctx.moveTo(first.x, h);
    for (const p of curvePoints) ctx.lineTo(p.x, p.y);
    ctx.lineTo(last.x, h);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    // Curve line
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const p of curvePoints) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = status === "crashed" ? "#ff1744" : "#e91e63";
    ctx.lineWidth   = 3.5;
    ctx.shadowColor = status === "crashed" ? "#ff1744" : "#e91e63";
    ctx.shadowBlur  = 20;
    ctx.lineJoin    = "round";
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // Smoke
    drawSmoke();

    // Plane at tip of curve
    if (status === "flying") {
      const tip  = curvePoints[curvePoints.length - 1];
      const prev = curvePoints[Math.max(0, curvePoints.length - 4)];
      const angle  = Math.atan2(tip.y - prev.y, tip.x - prev.x);
      const bounce = Math.sin(bounceT * 4) * 4;
      drawPlane(tip.x, tip.y, angle, bounce);
    }
  }

  /* ─────────────────────────────────────────────────────────
     RAF ANIMATION LOOP
     Runs continuously while status === "flying"
     Drives multiplier growth locally (smooth 60fps)
  ───────────────────────────────────────────────────────── */
  function startLoop() {
    cancelAnimationFrame(rafId);
    lastTs = performance.now();

    function loop(ts) {
      const dt = Math.min(ts - lastTs, 50); // cap at 50ms
      lastTs   = ts;

      bounceT += dt * 0.001;

      if (status === "flying") {
        // Advance multiplier locally for smooth animation
        // Server is authoritative for crash; we just animate between ticks
        const increment = currentMult * MULT_SPEED * (dt / 100);
        currentMult = Math.round((currentMult + increment) * 1000) / 1000;

        multEl.textContent = currentMult.toFixed(2) + "x";

        // Auto cash-out check
        if (activeBet && autoCashChk && autoCashChk.checked) {
          const target = parseFloat(autoCashInput.value) || 0;
          if (target >= 1.01 && currentMult >= target) {
            doCashOut();
          }
        }

        // Add point to curve
        const pos = multToPos(currentMult);
        curvePoints.push({ x: pos.x, y: pos.y });
        if (curvePoints.length > 600) curvePoints.shift();

        // Update cash-out button label
        if (activeBet) {
          actionBtn.textContent = `CASH OUT  K${(activeBet.amount * currentMult).toFixed(2)}`;
        }

        // Spawn smoke at plane position
        if (curvePoints.length >= 2) {
          const tip  = curvePoints[curvePoints.length - 1];
          const prev = curvePoints[Math.max(0, curvePoints.length - 4)];
          const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x);
          spawnSmoke(tip.x, tip.y, angle);
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
    multEl.textContent     = "1.00x";
    phaseBadge.textContent = "NEXT ROUND STARTING…";
    stopLoop();
    drawScene(); // clear canvas
  }

  function beginFlying(serverMult) {
    // Only trigger once
    if (status === "flying") return;
    status      = "flying";
    currentMult = serverMult || 1.00;
    curvePoints = [];
    smoke       = [];
    bounceT     = 0;

    multEl.classList.remove("crashed", "cashed");
    phaseBadge.textContent = "FLYING";
    cdownEl.classList.remove("on");

    // Activate queued bet → becomes active bet
    if (queuedBet) {
      activeBet  = queuedBet;
      queuedBet  = null;
      setBtn("cash");
    } else if (!activeBet) {
      setBtn("bet");
    }

    startLoop();
  }

  function beginCrashed(finalMult) {
    if (status === "crashed") return;
    status = "crashed";
    stopLoop();

    currentMult            = finalMult;
    multEl.textContent     = `CRASHED @ ${finalMult.toFixed(2)}x`;
    multEl.classList.add("crashed");
    phaseBadge.textContent = "CRASHED!";

    // Lose active bet
    if (activeBet) {
      showErr(`Crashed at ${finalMult.toFixed(2)}x — K${activeBet.amount.toFixed(2)} lost`);
      activeBet = null;
      setBtn("bet");
    }
    // Keep queued bet — it'll activate next round
    if (queuedBet) {
      setBtn("wait");
    }

    // Push to history
    roundHist.unshift(finalMult);
    if (roundHist.length > 30) roundHist.pop();
    localStorage.setItem("zav_rh", JSON.stringify(roundHist));
    renderHistory();

    drawScene();

    // Auto-bet next round
    const doAutoBet = autoBetChk && autoBetChk.checked;

    // 5s countdown then next round
    let s = COUNTDOWN_S;
    cdownEl.textContent = s;
    cdownEl.classList.add("on");

    const cd = setInterval(() => {
      s--;
      if (s <= 0) {
        clearInterval(cd);
        cdownEl.classList.remove("on");

        if (doAutoBet && !queuedBet && !activeBet) {
          queueBet(parseFloat(betInput.value) || MIN_BET, true);
        }

        beginWaiting();
        // Small gap before flying (simulates server betting window)
        setTimeout(() => beginFlying(1.00), 800);
      } else {
        cdownEl.textContent = s;
      }
    }, 1000);
  }

  /* ─────────────────────────────────────────────────────────
     BET LOGIC
  ───────────────────────────────────────────────────────── */
  function queueBet(amount, silent) {
    if (amount < MIN_BET) {
      if (!silent) showErr(`Minimum bet is K${MIN_BET.toFixed(2)}`);
      return false;
    }
    if (amount > balance) {
      if (!silent) { showErr("Insufficient balance"); openWallet("dep"); }
      return false;
    }
    balance -= amount;
    saveBalance();
    queuedBet = { amount };
    setBtn("wait");
    if (!silent) showInfo(`K${amount.toFixed(2)} bet queued for next round`);
    return true;
  }

  function placeLiveBet(amount) {
    if (amount < MIN_BET) { showErr(`Minimum bet is K${MIN_BET.toFixed(2)}`); return false; }
    if (amount > balance) { showErr("Insufficient balance"); openWallet("dep"); return false; }
    balance  -= amount;
    saveBalance();
    activeBet = { amount };
    setBtn("cash");
    return true;
  }

  function doCashOut() {
    if (!activeBet || status !== "flying") return;
    const win  = activeBet.amount * currentMult;
    balance   += win;
    saveBalance();
    activeBet  = null;
    multEl.classList.add("cashed");
    showToast(win);
    setBtn("bet");
  }

  /* ─────────────────────────────────────────────────────────
     ACTION BUTTON CLICK
  ───────────────────────────────────────────────────────── */
  actionBtn.addEventListener("click", () => {
    const bet = Math.round(parseFloat(betInput.value) * 100) / 100 || 0;

    if (status === "flying") {
      if (activeBet) {
        // Cash out
        doCashOut();
      } else if (!queuedBet) {
        // Allow live bet mid-flight
        placeLiveBet(bet);
      }
    } else {
      // waiting or crashed — queue for next round
      if (!queuedBet && !activeBet) {
        if (balance < MIN_BET) { showErr("Please deposit funds first"); openWallet("dep"); return; }
        queueBet(bet, false);
      } else if (queuedBet) {
        // Cancel queued bet
        balance  += queuedBet.amount;
        saveBalance();
        queuedBet = null;
        setBtn("bet");
        showInfo("Queued bet cancelled");
      }
    }
  });

  /* ─────────────────────────────────────────────────────────
     BUTTON STATE
  ───────────────────────────────────────────────────────── */
  function setBtn(state) {
    actionBtn.className = "";
    actionBtn.disabled  = false;

    if (state === "bet") {
      actionBtn.classList.add("s-bet");
      actionBtn.textContent = "PLACE BET";
    } else if (state === "cash") {
      actionBtn.classList.add("s-cash");
      actionBtn.textContent = `CASH OUT  K${((activeBet ? activeBet.amount : 0) * currentMult).toFixed(2)}`;
    } else if (state === "wait") {
      actionBtn.classList.add("s-wait");
      actionBtn.textContent = `K${queuedBet ? queuedBet.amount.toFixed(2) : "?"} QUEUED — TAP TO CANCEL`;
      actionBtn.disabled = false; // allow cancel
    }
  }

  /* ─────────────────────────────────────────────────────────
     QUICK BET BUTTONS
  ───────────────────────────────────────────────────────── */
  document.querySelectorAll(".qb").forEach(b =>
    b.addEventListener("click", () => { betInput.value = b.dataset.a; })
  );

  /* ─────────────────────────────────────────────────────────
     AUTO CONTROLS (injected into bottom panel)
  ───────────────────────────────────────────────────────── */
  function buildAutoControls() {
    const btm = document.getElementById("btm");
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:12px;align-items:center;flex-wrap:wrap;";
    row.innerHTML = `
      <label style="display:flex;align-items:center;gap:6px;font-size:.78rem;color:var(--muted);cursor:pointer;user-select:none">
        <input type="checkbox" id="autoBetChk" style="accent-color:#e91e63;width:15px;height:15px"/>
        AUTO BET
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:.78rem;color:var(--muted);cursor:pointer;user-select:none">
        <input type="checkbox" id="autoCashChk" style="accent-color:#00e676;width:15px;height:15px"/>
        AUTO CASH-OUT AT
      </label>
      <div style="position:relative;flex:1;min-width:80px">
        <input id="autoCashInput" type="number" value="2.00" min="1.01" step="0.01"
          style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;
                 color:var(--text);font-family:'Orbitron',sans-serif;font-size:.82rem;
                 padding:7px 28px 7px 10px;outline:none;-moz-appearance:textfield"/>
        <span style="position:absolute;right:9px;top:50%;transform:translateY(-50%);
                     font-size:.72rem;color:var(--muted);pointer-events:none">x</span>
      </div>
    `;
    // Insert before action button
    btm.insertBefore(row, document.getElementById("actionBtn"));

    autoBetChk   = document.getElementById("autoBetChk");
    autoCashChk  = document.getElementById("autoCashChk");
    autoCashInput= document.getElementById("autoCashInput");

    // Clamp auto cash-out to >= 1.01
    autoCashInput.addEventListener("blur", () => {
      const v = parseFloat(autoCashInput.value);
      if (isNaN(v) || v < 1.01) autoCashInput.value = "1.20";
    });

    // Style the input's webkit spinner off
    const st = document.createElement("style");
    st.textContent = "#autoCashInput::-webkit-inner-spin-button,#autoCashInput::-webkit-outer-spin-button{-webkit-appearance:none}";
    document.head.appendChild(st);
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
      histEl.appendChild(c);
    });
  }

  /* ─────────────────────────────────────────────────────────
     TOASTS
  ───────────────────────────────────────────────────────── */
  let toastTm, errTm;

  function showToast(amt) {
    tAmt.textContent = `+K${amt.toFixed(2)}`;
    toast.classList.add("on");
    clearTimeout(toastTm);
    toastTm = setTimeout(() => toast.classList.remove("on"), 2800);
  }

  function showErr(msg) {
    errToast.style.cssText = "";
    errToast.textContent   = msg;
    errToast.classList.add("on");
    clearTimeout(errTm);
    errTm = setTimeout(() => errToast.classList.remove("on"), 2800);
  }

  function showInfo(msg) {
    errToast.style.background   = "#0a2218";
    errToast.style.borderColor  = "var(--green)";
    errToast.style.color        = "#69f0ae";
    errToast.textContent        = msg;
    errToast.classList.add("on");
    clearTimeout(errTm);
    errTm = setTimeout(() => {
      errToast.classList.remove("on");
      setTimeout(() => { errToast.style.cssText = ""; }, 400);
    }, 2500);
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
     WALLET MODAL
  ───────────────────────────────────────────────────────── */
  function openWallet(tab) {
    setWalletTab(tab || activeTab);
    mBalDisp.textContent = balance.toFixed(2);
    modalOv.classList.add("open");
  }
  function closeWallet() { modalOv.classList.remove("open"); }

  walletBtn.addEventListener("click", () => openWallet(activeTab));
  closeBtn.addEventListener("click",  closeWallet);
  modalOv.addEventListener("click",   e => { if (e.target === modalOv) closeWallet(); });
  tDep.addEventListener("click",      () => setWalletTab("dep"));
  tWit.addEventListener("click",      () => setWalletTab("wit"));
  tHistBtn.addEventListener("click",  () => setWalletTab("hist"));

  function setWalletTab(t) {
    activeTab = t;
    [tDep, tWit, tHistBtn].forEach(b => b.classList.remove("on"));
    tabForm.style.display   = "none";
    tabHistEl.style.display = "none";
    wdFields.classList.remove("vis");
    confirmBtn.className    = "";

    if (t === "dep") {
      tDep.classList.add("on");
      tabForm.style.display    = "block";
      confirmBtn.className     = "dep";
      confirmBtn.textContent   = "DEPOSIT FUNDS";
    } else if (t === "wit") {
      tWit.classList.add("on");
      tabForm.style.display    = "block";
      wdFields.classList.add("vis");
      confirmBtn.className     = "wit";
      confirmBtn.textContent   = "REQUEST WITHDRAWAL";
    } else {
      tHistBtn.classList.add("on");
      tabHistEl.style.display  = "block";
      renderTx();
    }
  }

  document.querySelectorAll(".qa").forEach(q =>
    q.addEventListener("click", () => { mAmt.value = q.dataset.qa; })
  );

  confirmBtn.addEventListener("click", () => {
    const amt = parseFloat(mAmt.value) || 0;
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
      if (!account) { showErr("Enter account / mobile number"); return; }
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
      const d   = new Date(t.ts);
      const ts  = d.toLocaleDateString("en-ZM", { day:"2-digit", month:"short" }) + " " +
                  d.toLocaleTimeString("en-ZM", { hour:"2-digit", minute:"2-digit" });
      const pos = t.amt > 0;
      return `<div class="tx-item">
        <div><div>${t.type}</div><div class="tx-meta">${ts}</div></div>
        <div class="tx-amt ${pos?"d":"w"}">${pos?"+":""}K${Math.abs(t.amt).toFixed(2)}</div>
      </div>`;
    }).join("");
  }

  /* ─────────────────────────────────────────────────────────
     OFFLINE DEMO — full self-contained round loop
     Used when Firebase is unavailable
  ───────────────────────────────────────────────────────── */
  let demoActive = false;

  function genCrash() {
    const r = Math.random();
    if (r < 0.03) return 1.00;
    return Math.max(1.01, parseFloat((1 / (1 - r * 0.97)).toFixed(2)));
  }

  function runDemoRound() {
    if (demoActive) return;
    demoActive = true;

    beginWaiting();

    let s = COUNTDOWN_S;
    cdownEl.textContent = s;
    cdownEl.classList.add("on");
    phaseBadge.textContent = "BETTING OPEN";

    // Allow bets during countdown
    const cdInterval = setInterval(() => {
      s--;
      if (s <= 0) {
        clearInterval(cdInterval);
        cdownEl.classList.remove("on");
        launchDemoFlight();
      } else {
        cdownEl.textContent = s;
      }
    }, 1000);
  }

  function launchDemoFlight() {
    const crash = genCrash();
    beginFlying(1.00);

    // Poll every 120ms — check if local mult has reached crash
    const crashPoll = setInterval(() => {
      if (status !== "flying") { clearInterval(crashPoll); return; }
      if (currentMult >= crash) {
        clearInterval(crashPoll);
        // Snap to exact crash value
        currentMult = crash;
        multEl.textContent = crash.toFixed(2) + "x";
        beginCrashed(crash);
        setTimeout(() => {
          demoActive = false;
          runDemoRound();
        }, (COUNTDOWN_S + 1) * 1000);
      }
    }, 120);
  }

  /* ─────────────────────────────────────────────────────────
     FIREBASE LISTENER
  ───────────────────────────────────────────────────────── */
  let fbOk = false;

  function initFirebase() {
    if (!window._db || !window._snap || !window._doc) {
      setTimeout(initFirebase, 400);
      return;
    }

    // Fallback if Firebase takes too long
    const fbFallback = setTimeout(() => {
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
        clearTimeout(fbFallback);
        connBadge.textContent = "ONLINE";
        connBadge.classList.remove("offline");
        // Stop any demo loop
        demoActive = true;
      }

      const d    = snap.data();
      const mult = Number(d.multiplier) || 1.00;
      const st   = d.status || "waiting";

      if (st === "flying") {
        if (status !== "flying") {
          // Sync our local mult to server on round start
          currentMult = mult;
        }
        beginFlying(mult);
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
     INIT
  ───────────────────────────────────────────────────────── */
  resizeCanvas();
  buildStars();
  buildAutoControls();
  saveBalance();
  renderHistory();

  window.addEventListener("resize", () => {
    resizeCanvas();
    drawScene();
  });

  if (window._db) {
    initFirebase();
  } else {
    window.addEventListener("fb-ready", initFirebase, { once: true });
  }

  // Start demo immediately — Firebase will take over if it connects
  setTimeout(() => { if (!fbOk && !demoActive) runDemoRound(); }, 1000);

})();
