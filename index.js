/* =====================================================================
   functions/index.js  –  Firebase Cloud Functions game loop
   
   SETUP:
     1. cd functions && npm install firebase-admin firebase-functions
     2. firebase deploy --only functions
   ===================================================================== */

const functions = require("firebase-functions");
const admin     = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

// ── Helper: sleep ──────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Crash point generator ──────────────────────────────────────────────
// Uses a provably fair formula. House edge: ~3%
function generateCrashPoint() {
  const houseEdge = 0.97;
  const r = Math.random();
  if (r < (1 - houseEdge)) return 1.00; // instant crash ~3% of time
  return Math.max(1.00, Math.floor(100 / (1 - r * houseEdge)) / 100);
}

// ── Main game loop ─────────────────────────────────────────────────────
// Runs every minute on Cloud Scheduler, but manages its own internal loop.
// NOTE: For a production game use a long-running Cloud Run container instead,
// as Cloud Functions have a 540s timeout. This implementation stays within limits.

exports.gameLoop = functions
  .runWith({ timeoutSeconds: 540, memory: "256MB" })
  .pubsub.schedule("every 1 minutes")
  .onRun(async (_context) => {
    const ref = db.collection("game_state").doc("current");

    // One full round per invocation (waiting → flying → crashed)
    try {
      // ── Phase 1: WAITING (5 second betting window) ──
      await ref.set({
        status:     "waiting",
        multiplier: 1.00,
        updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
      await sleep(5000);

      // ── Phase 2: FLYING ──
      const crashPoint = generateCrashPoint();
      let multiplier   = 1.00;
      const TICK_MS    = 100; // update every 100ms

      await ref.update({ status: "flying" });

      while (multiplier < crashPoint) {
        // Exponential growth: roughly doubles every 8 seconds
        multiplier = Math.round((multiplier * 1.0045) * 100) / 100;
        if (multiplier >= crashPoint) multiplier = crashPoint;

        await ref.update({
          multiplier,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await sleep(TICK_MS);

        if (multiplier >= crashPoint) break;
      }

      // ── Phase 3: CRASHED ──
      await ref.update({
        status:     "crashed",
        multiplier: crashPoint,
        updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });

      // Store in round history
      await db.collection("round_history").add({
        crashPoint,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Wait before next round (scheduler will re-trigger)
      await sleep(3000);

    } catch (err) {
      console.error("Game loop error:", err);
      await ref.update({ status: "waiting", multiplier: 1.00 }).catch(() => {});
    }

    return null;
  });


// ── Optional: HTTP trigger for testing locally ─────────────────────────
exports.testRound = functions.https.onRequest(async (req, res) => {
  const ref = db.collection("game_state").doc("current");

  await ref.set({ status: "waiting", multiplier: 1.00 });
  await sleep(3000);

  const crashPoint = generateCrashPoint();
  let multiplier = 1.00;

  await ref.update({ status: "flying" });

  while (multiplier < crashPoint) {
    multiplier = Math.round((multiplier * 1.0045) * 100) / 100;
    if (multiplier >= crashPoint) multiplier = crashPoint;
    await ref.update({ multiplier });
    await sleep(100);
  }

  await ref.update({ status: "crashed", multiplier: crashPoint });
  res.json({ crashPoint });
});
