/* ================================================================
   game.js – Aviator ZM  |  Zambian Kwacha Edition
   Features:
   • Animated plane that rises from bottom-left, curves upward
   • Gentle hover/bounce while flying
   • Animated smoke/exhaust trail particles behind engine
   • Curve line with gradient fill
   • Firestore real-time listener with offline demo fallback
   • Wallet: deposit / withdraw / history (localStorage)
   • K0.50 minimum bet
================================================================ */
(function () {
  "use strict";

  /* ── Canvas setup ───────────────────────────────────────── */
  const canvas = document.getElementById("gc");
  const ctx    = canvas.getContext("2d");
  const W = () => canvas.offsetWidth;
  const H = () => canvas.offsetHeight;

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = canvas.offsetWidth  * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ── DOM refs ───────────────────────────────────────────── */
  const multEl    = document.getElementById("multiplier");
  const actionBtn = document.getElementById("actionBtn");
  const balDisp   = document.getElementById("bal-disp");
  const mBalDisp  = document.getElementById("m-bal");
  const phaseBadge= document.getElementById("phase-badge");
  const histEl    = document.getElementById("history");
  const cdownEl   = document.getElementById("cdown");
  const connBadge = document.getElementById("conn-badge");
  const betInput  = document.getElementById("betInput");
  const toast     = document.getElementById("toast");
  const tAmt      = document.getElementById("t-amt");
  const errToast  = document.getElementById("err-toast");

  /* ── Wallet modal refs ──────────────────────────────────── */
  const modalOv   = document.getElementById("modal-ov");
  const closeBtn  = document.getElementById("closeModal");
  const walletBtn = document.getElementById("walletBtn");
  const tDep      = document.getElementById("tDep");
  const tWit      = document.getElementById("tWit");
  const tHist     = document.getElementById("tHist");
  const tabForm   = document.getElementById("tab-form");
  const tabHist   = document.getElementById("tab-hist");
  const wdFields  = document.getElementById("wdraw-fields");
  const mAmt      = document.getElementById("mAmt");
  const confirmBtn= document.getElementById("confirmBtn");
  const txList    = document.getElementById("txList");

  /* ── State ──────────────────────────────────────────────── */
  const MIN_BET   = 0.50;
  let balance     = parseFloat(localStorage.getItem("zav_balance") || "0");
  let txHistory   = JSON.parse(localStorage.getItem("zav_tx") || "[]");
  let roundHistory= JSON.parse(localStorage.getItem("zav_rounds") || "[]");

  let hasBet      = false;
  let betAmount   = 0.50;
  let status      = "waiting"; // waiting | flying | crashed
  let currentMult = 1.0;
  let activeTab   = "dep";

  /* ── Plane animation state ──────────────────────────────── */
  let curvePoints = [];        // {x,y} trail of the curve
  let smokeParticles = [];     // exhaust smoke particles
  let bounceT     = 0;         // time counter for hover bounce
  let animRaf     = null;

  /* ── Smoke particle pool ────────────────────────────────── */
  function spawnSmoke(x, y, angle) {
    // Spawn 2 particles per frame when flying
    for (let i = 0; i < 2; i++) {
      const spread = (Math.random() - 0.5) * 0.4;
      smokeParticles.push({
        x, y,
        vx: Math.cos(angle + Math.PI + spread) * (1.5 + Math.random() * 1.5),
        vy: Math.sin(angle + Math.PI + spread) * (1.5 + Math.random() * 1.5),
        life: 1.0,
        decay: 0.025 + Math.random() * 0.02,
        size: 4 + Math.random() * 6,
        // Alternate orange/white smoke
        color: Math.random() > 0.5 ? "255,140,60" : "200,200,220"
      });
    }
  }

  function updateSmoke() {
    smokeParticles = smokeParticles.filter(p => p.life > 0);
    for (const p of smokeParticles) {
      p.x   += p.vx;
      p.y   += p.vy;
      p.size *= 1.04; // expand as it fades
      p.life -= p.decay;
    }
  }

  function drawSmoke() {
    for (const p of smokeParticles) {
      ctx.save();
      ctx.globalAlpha = p.life * 0.55;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
      g.addColorStop(0, `rgba(${p.color},0.8)`);
      g.addColorStop(1, `rgba(${p.color},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /* ── Map multiplier → canvas position ──────────────────── */
  function multToPos(m) {
    // progress 0→1 as mult goes 1→~12
    const prog  = Math.min((m - 1) / 11, 1);
    const x     = 30 + prog * (W() - 80);
    // Quadratic curve: starts near bottom-left, arcs upward
    const yFull = H() - 40;  // bottom
    const yTop  = H() * 0.12; // near top
    const y     = yFull - (prog * prog) * (yFull - yTop);
    return { x, y, prog };
  }

  /* ── Draw the plane ─────────────────────────────────────── */
  function drawPlane(x, y, angle, bounce) {
    ctx.save();
    ctx.translate(x, y + bounce);
    ctx.rotate(angle);

    // Glow halo
    ctx.shadowColor = "rgba(255,255,255,0.6)";
    ctx.shadowBlur  = 14;

    // Body / fuselage
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(28, 0);         // nose
    ctx.bezierCurveTo(20,-5, -10,-5, -18,0);
    ctx.bezierCurveTo(-10, 5,  20,  5,  28,0);
    ctx.fill();

    // Main wing
    ctx.fillStyle = "#e0e4ff";
    ctx.beginPath();
    ctx.moveTo(6,  0);
    ctx.lineTo(-2,-22);
    ctx.lineTo(-12,-22);
    ctx.lineTo(-4,  0);
    ctx.closePath();
    ctx.fill();

    // Small rear stabilizer
    ctx.fillStyle = "#c5caff";
    ctx.beginPath();
    ctx.moveTo(-14, 0);
    ctx.lineTo(-22,-12);
    ctx.lineTo(-24, 0);
    ctx.closePath();
    ctx.fill();

    // Cockpit window
    ctx.fillStyle = "rgba(100,200,255,0.7)";
    ctx.beginPath();
    ctx.ellipse(16, -2, 5, 3, -0.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.restore();
  }

  /* ── Draw full scene ────────────────────────────────────── */
  function drawScene() {
    const w = W(), h = H();
    ctx.clearRect(0, 0, w, h);

    // Faint grid
    ctx.strokeStyle = "rgba(255,255,255,0.035)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx < w; gx += w / 5) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    }
    for (let gy = 0; gy < h; gy += h / 4) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }

    if (curvePoints.length < 2) return;

    // Gradient fill under curve
    const last = curvePoints[curvePoints.length - 1];
    const fill = ctx.createLinearGradient(0, 0, 0, h);
    if (status === "crashed") {
      fill.addColorStop(0, "rgba(233,30,99,0.18)");
      fill.addColorStop(1, "rgba(233,30,99,0)");
    } else {
      fill.addColorStop(0, "rgba(233,30,99,0.28)");
      fill.addColorStop(1, "rgba(233,30,99,0)");
    }
    ctx.beginPath();
    ctx.moveTo(curvePoints[0].x, h);
    for (const p of curvePoints) ctx.lineTo(p.x, p.y);
    ctx.lineTo(last.x, h);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    // Curve line
    ctx.beginPath();
    ctx.moveTo(curvePoints[0].x, curvePoints[0].y);
    for (const p of curvePoints) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = status === "crashed" ? "#ff1744" : "#e91e63";
    ctx.lineWidth   = 3;
    ctx.shadowColor = status === "crashed" ? "#ff1744" : "#e91e63";
    ctx.shadowBlur  = 18;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // Smoke
    drawSmoke();

    // Plane (only while flying, with bounce)
    if (status === "flying" && curvePoints.length >= 2) {
      const tip  = curvePoints[curvePoints.length - 1];
      const prev = curvePoints[curvePoints.length - 2];
      const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x);
      const bounce = Math.sin(bounceT * 3.5) * 3.5; // gentle hover
      drawPlane(tip.x, tip.y, angle, bounce);
    }
  }

  /* ── Animation loop (runs while flying) ────────────────── */
  function startAnimLoop() {
    cancelAnimationFrame(animRaf);
    function loop() {
      bounceT += 0.016;
      updateSmoke();

      // Spawn smoke at plane tip if we have curve points
      if (status === "flying" && curvePoints.length >= 2) {
        const tip  = curvePoints[curvePoints.length - 1];
        const prev = curvePoints[curvePoints.length - 2];
        const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x);
        spawnSmoke(tip.x, tip.y, angle);
      }

      drawScene();
      animRaf = requestAnimationFrame(loop);
    }
    loop();
  }

  function stopAnimLoop() {
    cancelAnimationFrame(animRaf);
    animRaf = null;
  }

  /* ── Game state handlers ────────────────────────────────── */
  function onFlying(mult) {
    if (status !== "flying") {
      status = "flying";
      curvePoints = [];
      smokeParticles = [];
      bounceT = 0;
      multEl.classList.remove("crashed", "cashed");
      cdownEl.classList.remove("on");
      phaseBadge.textContent = "FLYING";
      if (hasBet) setBtn("cash");
      startAnimLoop();
    }

    currentMult = mult;
    multEl.textContent = mult.toFixed(2) + "x";

    const pos = multToPos(mult);
    curvePoints.push({ x: pos.x, y: pos.y });
    if (curvePoints.length > 400) curvePoints.shift();

    if (hasBet) {
      const pot = (betAmount * mult).toFixed(2);
      actionBtn.textContent = `CASH OUT  K${pot}`;
    }
  }

  function onCrashed(finalMult) {
    status = "crashed";
    stopAnimLoop();

    if (hasBet) {
      hasBet = false;
      setBtn("bet");
      showErr("Round crashed — bet lost");
    }

    multEl.classList.add("crashed");
    multEl.textContent = `CRASHED @ ${finalMult.toFixed(2)}x`;
    phaseBadge.textContent = "CRASHED";

    roundHistory.unshift(finalMult);
    if (roundHistory.length > 30) roundHistory.pop();
    localStorage.setItem("zav_rounds", JSON.stringify(roundHistory));
    renderHistory();

    drawScene(); // final frame
    startCountdown(5);
  }

  function onWaiting() {
    status = "waiting";
    stopAnimLoop();
    curvePoints = [];
    smokeParticles = [];
    multEl.classList.remove("crashed", "cashed");
    multEl.textContent = "1.00x";
    phaseBadge.textContent = "WAITING FOR NEXT ROUND";
    ctx.clearRect(0, 0, W(), H());
  }

  /* ── Countdown ──────────────────────────────────────────── */
  let cdTimer;
  function startCountdown(s) {
    clearInterval(cdTimer);
    cdownEl.textContent = s;
    cdownEl.classList.add("on");
    cdTimer = setInterval(() => {
      s--;
      if (s <= 0) { clearInterval(cdTimer); cdownEl.classList.remove("on"); }
      else cdownEl.textContent = s;
    }, 1000);
  }

  /* ── Button state ───────────────────────────────────────── */
  function setBtn(state) {
    actionBtn.className = "";
    actionBtn.disabled  = false;
    if (state === "bet") {
      actionBtn.classList.add("s-bet");
      actionBtn.textContent = "PLACE BET";
    } else if (state === "cash") {
      actionBtn.classList.add("s-cash");
      actionBtn.textContent = `CASH OUT  K${(betAmount * currentMult).toFixed(2)}`;
    } else {
      actionBtn.classList.add("s-wait");
      actionBtn.textContent = "BET QUEUED ✓";
      actionBtn.disabled = true;
    }
  }

  /* ── Action button ──────────────────────────────────────── */
  actionBtn.addEventListener("click", () => {
    const bet = parseFloat(betInput.value) || 0;

    if (bet < MIN_BET) { showErr(`Minimum bet is K${MIN_BET.toFixed(2)}`); return; }
    if (balance < MIN_BET) { showErr("Please deposit funds first"); openWallet("dep"); return; }

    if (!hasBet && status !== "flying") {
      if (bet > balance) { showErr("Insufficient balance"); return; }
      betAmount = bet;
      balance -= betAmount;
      saveBalance();
      hasBet = true;
      setBtn("wait");
    } else if (!hasBet && status === "flying") {
      if (bet > balance) { showErr("Insufficient balance"); return; }
      betAmount = bet;
      balance -= betAmount;
      saveBalance();
      hasBet = true;
      setBtn("cash");
    } else if (hasBet && status === "flying") {
      const win = betAmount * currentMult;
      balance += win;
      saveBalance();
      hasBet = false;
      multEl.classList.add("cashed");
      showToast(win);
      setBtn("bet");
    }
  });

  /* ── Quick bet buttons ──────────────────────────────────── */
  document.querySelectorAll(".qb").forEach(b =>
    b.addEventListener("click", () => { betInput.value = b.dataset.a; })
  );

  /* ── Balance helpers ────────────────────────────────────── */
  function saveBalance() {
    localStorage.setItem("zav_balance", balance.toFixed(2));
    balDisp.textContent = balance.toFixed(2);
    mBalDisp.textContent = balance.toFixed(2);
  }

  /* ── History ribbon ─────────────────────────────────────── */
  function renderHistory() {
    histEl.innerHTML = "";
    roundHistory.forEach(m => {
      const c = document.createElement("div");
      c.className = "hchip " + (m < 2 ? "lo" : m < 5 ? "mi" : "hi");
      c.textContent = m.toFixed(2) + "x";
      histEl.appendChild(c);
    });
  }

  /* ── Stars ──────────────────────────────────────────────── */
  function buildStars() {
    const el = document.getElementById("stars");
    el.innerHTML = "";
    for (let i = 0; i < 80; i++) {
      const s = document.createElement("div");
      s.className = "star";
      const sz = Math.random() * 2.4 + 0.4;
      s.style.cssText = `width:${sz}px;height:${sz}px;top:${Math.random()*100}%;left:${Math.random()*100}%;--d:${(Math.random()*3+1.5).toFixed(1)}s;animation-delay:${(Math.random()*3).toFixed(1)}s`;
      el.appendChild(s);
    }
  }

  /* ── Toast / error ──────────────────────────────────────── */
  let toastTm, errTm;
  function showToast(amt) {
    tAmt.textContent = `+K${amt.toFixed(2)}`;
    toast.classList.add("on");
    clearTimeout(toastTm);
    toastTm = setTimeout(() => toast.classList.remove("on"), 2600);
  }
  function showErr(msg) {
    errToast.textContent = msg;
    errToast.classList.add("on");
    clearTimeout(errTm);
    errTm = setTimeout(() => errToast.classList.remove("on"), 2800);
  }

  /* ── WALLET MODAL ───────────────────────────────────────── */
  function openWallet(tab) {
    tab = tab || "dep";
    setTab(tab);
    modalOv.classList.add("open");
    mBalDisp.textContent = balance.toFixed(2);
  }
  function closeWallet() { modalOv.classList.remove("open"); }

  walletBtn.addEventListener("click", () => openWallet(activeTab));
  closeBtn.addEventListener("click", closeWallet);
  modalOv.addEventListener("click", e => { if (e.target === modalOv) closeWallet(); });

  function setTab(t) {
    activeTab = t;
    [tDep, tWit, tHist].forEach(b => b.classList.remove("on"));
    tabForm.style.display = "none";
    tabHist.style.display = "none";
    wdFields.classList.remove("vis");
    confirmBtn.className = "";

    if (t === "dep") {
      tDep.classList.add("on");
      tabForm.style.display = "block";
      confirmBtn.className  = "dep";
      confirmBtn.textContent = "DEPOSIT FUNDS";
    } else if (t === "wit") {
      tWit.classList.add("on");
      tabForm.style.display = "block";
      wdFields.classList.add("vis");
      confirmBtn.className  = "wit";
      confirmBtn.textContent = "REQUEST WITHDRAWAL";
    } else {
      tHist.classList.add("on");
      tabHist.style.display = "block";
      renderTx();
    }
  }

  tDep.addEventListener("click",  () => setTab("dep"));
  tWit.addEventListener("click",  () => setTab("wit"));
  tHist.addEventListener("click", () => setTab("hist"));

  // Quick amount chips
  document.querySelectorAll(".qa").forEach(q =>
    q.addEventListener("click", () => { mAmt.value = q.dataset.qa; })
  );

  /* ── Confirm deposit / withdraw ─────────────────────────── */
  confirmBtn.addEventListener("click", () => {
    const amt = parseFloat(mAmt.value) || 0;
    if (amt < MIN_BET) { showErr(`Minimum amount is K${MIN_BET.toFixed(2)}`); return; }

    if (activeTab === "dep") {
      // Simulate instant deposit (in real app, integrate payment gateway here)
      balance += amt;
      saveBalance();
      addTx("DEPOSIT", amt);
      showErr(`K${amt.toFixed(2)} deposited ✓`);
      errToast.style.background = "#0a2a12";
      errToast.style.borderColor= "var(--green)";
      errToast.style.color      = "#69f0ae";
      mAmt.value = "";
      closeWallet();
      // Reset error toast style after
      setTimeout(() => {
        errToast.style.background = "";
        errToast.style.borderColor= "";
        errToast.style.color      = "";
      }, 3200);
    } else if (activeTab === "wit") {
      if (amt > balance) { showErr("Insufficient balance"); return; }
      const method  = document.getElementById("wMethod").value;
      const account = document.getElementById("wAccount").value.trim();
      if (!method)  { showErr("Select a payment method"); return; }
      if (!account) { showErr("Enter account / mobile number"); return; }
      balance -= amt;
      saveBalance();
      addTx("WITHDRAW", -amt);
      showErr(`Withdrawal of K${amt.toFixed(2)} requested ✓`);
      mAmt.value = "";
      closeWallet();
    }
  });

  /* ── Transaction log ────────────────────────────────────── */
  function addTx(type, amt) {
    txHistory.unshift({ type, amt, time: Date.now() });
    if (txHistory.length > 50) txHistory.pop();
    localStorage.setItem("zav_tx", JSON.stringify(txHistory));
  }

  function renderTx() {
    if (!txHistory.length) {
      txList.innerHTML = '<div style="color:var(--muted);font-size:.85rem;text-align:center;padding:24px 0">No transactions yet</div>';
      return;
    }
    txList.innerHTML = txHistory.map(t => {
      const d   = new Date(t.time);
      const ts  = d.toLocaleDateString("en-ZM", { day:"2-digit", month:"short" }) + " " +
                  d.toLocaleTimeString("en-ZM", { hour:"2-digit", minute:"2-digit" });
      const pos = t.amt > 0;
      return `
        <div class="tx-item">
          <div>
            <div>${t.type}</div>
            <div class="tx-meta">${ts}</div>
          </div>
          <div class="tx-amt ${pos ? "d":"w"}">${pos?"+":""}K${Math.abs(t.amt).toFixed(2)}</div>
        </div>`;
    }).join("");
  }

  /* ── Offline demo mode (runs if Firebase fails) ─────────── */
  let demoRunning = false;
  function runDemoRound() {
    if (demoRunning) return;
    demoRunning = true;

    // Generate crash point
    const r = Math.random();
    const crash = r < 0.03 ? 1.00 : Math.max(1.0, Math.floor(100 / (1 - r * 0.97)) / 100);

    onWaiting();
    startCountdown(5);

    setTimeout(() => {
      let mult = 1.00;
      const tick = setInterval(() => {
        mult = Math.round(mult * 1.0045 * 100) / 100;
        if (mult >= crash) {
          clearInterval(tick);
          onCrashed(crash);
          setTimeout(() => { demoRunning = false; runDemoRound(); }, 5000);
        } else {
          onFlying(mult);
        }
      }, 100);
    }, 5000);
  }

  /* ── Firebase init ──────────────────────────────────────── */
  let fbConnected = false;
  let fbTimeout;

  function initFirebase() {
    if (!window._db || !window._snap || !window._doc) {
      setTimeout(initFirebase, 500);
      return;
    }

    fbTimeout = setTimeout(() => {
      if (!fbConnected) {
        connBadge.textContent = "OFFLINE";
        connBadge.classList.add("offline");
        runDemoRound();
      }
    }, 6000);

    const ref = window._doc(window._db, "game_state", "current");
    window._snap(ref, snap => {
      if (!snap.exists()) return;
      fbConnected = true;
      clearTimeout(fbTimeout);
      connBadge.textContent = "ONLINE";
      connBadge.classList.remove("offline");

      const d      = snap.data();
      const mult   = Number(d.multiplier) || 1.0;
      const st     = d.status || "waiting";

      if (st === "crashed")      onCrashed(mult);
      else if (st === "flying")  onFlying(mult);
      else                       onWaiting();
    }, err => {
      console.error("Firestore:", err);
      connBadge.textContent = "OFFLINE";
      connBadge.classList.add("offline");
      if (!demoRunning) runDemoRound();
    });
  }

  /* ── Bootstrap ──────────────────────────────────────────── */
  resizeCanvas();
  buildStars();
  saveBalance();   // render initial balance
  renderHistory();

  window.addEventListener("resize", () => {
    resizeCanvas();
    if (status !== "flying") drawScene();
  });

  if (window._db) {
    initFirebase();
  } else {
    window.addEventListener("fb-ready", initFirebase, { once: true });
    // Start demo if firebase never loads
    setTimeout(() => { if (!fbConnected && !demoRunning) runDemoRound(); }, 4000);
  }

})();
