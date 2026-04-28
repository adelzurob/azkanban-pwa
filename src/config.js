// Copy this file to src/config.js and fill in the values from your Microsoft
// Entra app registration. src/config.js is gitignored.
//
// See README.md "One-time setup" for step-by-step Azure registration instructions.

export const config = {
  // Application (client) ID from your Entra app registration overview page.
  // Format: a UUID like "12345678-1234-1234-1234-123456789012".
  clientId: "ca06dbdc-82ea-4cbe-9d49-826f34e55d1c",

  // The redirect URI you configured in Entra. Must EXACTLY match (including trailing slashes).
  // Production:  https://<your-github-username>.github.io/azkanban-pwa/redirect.html
  // Local dev:   http://localhost:5173/redirect.html
  // The PWA picks the right one at runtime based on window.location.origin.
  redirectUri: typeof window !== "undefined" && window.location.origin.includes("localhost")
    ? "http://localhost:5173/redirect.html"
    : `${typeof window !== "undefined" ? window.location.origin : ""}/azkanban-pwa/redirect.html`,

  // Path to the data file inside your OneDrive. Must match the desktop app's
  // DEFAULT_DIRECTORY (which is %USERPROFILE%\OneDrive\AZKanban\boards.json).
  // The leading slash is the OneDrive root.
  dataFilePath: "/AZKanban/boards.json",

  // OneDrive scopes the PWA needs. Files.ReadWrite is the minimum for read+write
  // access to user-owned files. offline_access lets MSAL silently refresh tokens
  // for ~90 days; without it, you'd have to sign in every hour.
  scopes: ["Files.ReadWrite", "User.Read", "offline_access"],

  // Polling interval for external changes while the PWA is focused.
  // Match the desktop's SYNC_INTERVAL_MS (30000) for consistent UX.
  pollIntervalMs: 30_000,

  // Save debounce after the last edit before pushing to OneDrive.
  saveDebounceMs: 500,
};
