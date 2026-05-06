# ✈ Aviator Game — Setup Guide

## File Structure
```
/
├── index.html          ← Main game UI (already has your Firebase config)
├── game.js             ← Client-side canvas engine + Firestore listener
└── functions/
    └── index.js        ← Firebase Cloud Function (server-side game loop)
```

---

## 1. Firestore Setup

In the Firebase console for `aviatorgame-18041`:

1. Go to **Firestore → Create database** (if not already done)
2. Create a collection: `game_state`
3. Create a document with ID: `current`
4. Add these fields:
   - `status` (string): `"waiting"`
   - `multiplier` (number): `1.00`

### Firestore Security Rules (for dev)
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /game_state/{doc} {
      allow read: if true;  // Public read for game state
      allow write: if false; // Only Cloud Functions can write
    }
    match /round_history/{doc} {
      allow read: if true;
      allow write: if false;
    }
  }
}
```

---

## 2. Deploy Cloud Functions

```bash
npm install -g firebase-tools
firebase login
firebase init functions   # choose aviatorgame-18041, Node.js 18

cd functions
npm install firebase-admin firebase-functions

cd ..
firebase deploy --only functions
```

Enable **Cloud Scheduler API** in Google Cloud Console if prompted.

---

## 3. Enable Cloud Scheduler

The function runs on `pubsub.schedule("every 1 minutes")`.  
Go to GCP Console → Cloud Scheduler and verify the job is active.

> ⚠️ **Important:** One Cloud Function invocation = one round.  
> If a round takes less than 60s, the next invocation starts automatically.  
> For production with very high multipliers (rounds > 60s), migrate to **Cloud Run**.

---

## 4. Serve Locally

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080`

---

## Game Mechanics

| Phase    | Duration      | Description                          |
|----------|---------------|--------------------------------------|
| WAITING  | ~5 seconds    | Betting window before flight         |
| FLYING   | Varies        | Multiplier rises until crash point   |
| CRASHED  | ~3 seconds    | Round over, history updated          |

- **Crash point** generated server-side with ~3% house edge
- **Instant crash** (1.00x) happens ~3% of rounds
- Balance persists in `localStorage`
- Last 20 crash results shown in history ribbon
