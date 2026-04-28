# AZKanban PWA

iPhone/iPad companion for the [AZKanban](../AZKanban/) Windows desktop app. A
Progressive Web App that signs into your personal Microsoft account and reads
and writes the existing `boards.json` directly on OneDrive via the Microsoft
Graph API. OneDrive remains the single source of truth — this PWA never stores
your data anywhere else, and the GitHub repo holds only code.

> **Status: scaffold (build-sequence step 2).** Sign-in, fetch, and read-only
> board list. Editing, archive, search, push notifications still to come.

## Architecture in one paragraph

`boards.json` lives at `OneDrive/AZKanban/boards.json`. The Windows desktop app
writes to it normally and (in v2.3) optionally mirrors a copy into iCloud Drive
for read-only iOS Files access. This PWA, served from GitHub Pages, signs you
into the same personal Microsoft account via MSAL.js and uses the Microsoft
Graph API to read and write the same file with eTag-based optimistic concurrency.
Push notifications for due dates are handled by a separate Cloudflare Worker
(future). Full design: `..\..\..\..\.claude\plans\look-at-program-az-golden-dahl.md`.

## One-time setup

### 1. Register the app in Microsoft Entra (Azure)

You only need a personal Microsoft account — no Azure subscription required.

1. Go to <https://entra.microsoft.com/> and sign in with the personal account
   that owns the OneDrive containing `boards.json`.
2. **Identity → Applications → App registrations → New registration**.
3. Name: `AZKanban PWA`.
4. Supported account types: **"Personal Microsoft accounts only"**.
5. Redirect URI: choose **"Single-page application (SPA)"** and enter
   `https://<YOUR_GITHUB_USERNAME>.github.io/azkanban-pwa/redirect.html`.
6. Click **Register**.
7. After registration, open **Authentication** in the left nav and add a second
   SPA redirect URI for local dev: `http://localhost:5173/redirect.html`.
8. Copy the **Application (client) ID** from the Overview page.

### 2. Configure the PWA

1. Copy `src/config.template.js` to `src/config.js`.
2. Set `clientId` to the Application (client) ID from step 1.
3. Set `redirectUri` to the production URI (`https://<user>.github.io/azkanban-pwa/redirect.html`).
4. `src/config.js` is gitignored — your client ID never gets committed. (The
   client ID is a public identifier per OAuth spec, but keeping it out of the
   public repo means anyone who forks the repo doesn't accidentally inherit
   your app registration's quotas and audit trail.)

### 3. Local development

No build step — pure static files. Any local HTTP server works:

```bash
cd azkanban-pwa
python -m http.server 5173
```

Open <http://localhost:5173/> in a browser, sign in, and verify your boards
load. The localhost redirect URI is registered in step 1 so OAuth works locally.

### 4. Deploy to GitHub Pages

```bash
cd azkanban-pwa
git init
git remote add origin https://github.com/<YOUR_USERNAME>/azkanban-pwa.git
git add .
git commit -m "Initial PWA scaffold"
git push -u origin main
```

Then on GitHub:

1. Create the repo (private is fine — Pages works on private repos for paid
   accounts; for free accounts, Pages requires public).
2. Settings → Pages → Source = `Deploy from a branch` → Branch = `main` → Folder = `/ (root)`.
3. Wait ~1 minute, then visit `https://<YOUR_USERNAME>.github.io/azkanban-pwa/`.

### 5. Install on iPhone/iPad

1. Open the GitHub Pages URL in **Safari** (not another browser — iOS PWAs work
   only via Safari).
2. Tap **Share → Add to Home Screen**.
3. Open from the home screen icon (not from Safari) — that triggers PWA mode.
4. Sign in once. Subsequent launches are silent.

## Folder layout

```
azkanban-pwa/
├── README.md               # this file
├── index.html              # main app shell
├── redirect.html           # MSAL OAuth callback page
├── manifest.webmanifest    # PWA manifest (icons, name, display mode)
├── service-worker.js       # offline asset cache (registered by index.html)
├── src/
│   ├── config.template.js  # copy to config.js and fill in client ID
│   ├── auth.js             # MSAL.js wrapper (sign-in, token acquisition)
│   ├── graph.js            # OneDrive Graph client (read/write with eTag)
│   ├── store.js            # in-memory state + IndexedDB cache
│   └── app.js              # entry point: bootstrap + render
├── styles/
│   └── app.css             # all styling
└── icons/                  # PWA icons (placeholder SVGs — replace with PNGs)
```

## Sync semantics (matches plan)

- On open + on visibility change: GET `boards.json` via Graph, capture eTag, render.
- Polling every 30 s while focused: GET, compare eTag; if changed, refresh.
- On user edit: 500 ms debounce → PUT with `If-Match: <eTag>`.
  - 2xx → update local eTag.
  - 412 → refetch and surface a "data changed elsewhere — refresh" prompt.
- Offline: edits queue in IndexedDB; replay against Graph when online.

## Repo hygiene

- `src/config.js` is in `.gitignore` — the client ID never gets committed.
- No `boards.json` content is ever stored in this repo. The PWA holds it only in
  memory and IndexedDB on each device.
- No telemetry, no analytics, no third-party scripts other than the MSAL.js
  CDN bundle (loaded from Microsoft's official CDN at runtime).
