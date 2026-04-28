// MSAL.js wrapper for personal Microsoft account sign-in.
//
// We use the redirect flow rather than popup because (a) iOS Safari blocks
// pop-ups in PWAs unless explicitly user-initiated, and (b) the redirect flow
// is the most reliable on mobile. handleRedirectPromise() must be called
// exactly once on every load to consume any pending OAuth response.

import { config } from "./config.js";

let pca = null;
let initPromise = null;

function getPca() {
  // The MSAL CDN script declares a global `msal` namespace.
  if (typeof msal === "undefined") {
    throw new Error(
      "MSAL.js failed to load from the CDN. Check network connectivity."
    );
  }
  if (pca) return pca;
  pca = new msal.PublicClientApplication({
    auth: {
      clientId: config.clientId,
      // /consumers = personal Microsoft accounts only (live.com, outlook.com, etc.)
      authority: "https://login.microsoftonline.com/consumers",
      redirectUri: config.redirectUri,
      navigateToLoginRequestUrl: true,
    },
    cache: {
      // sessionStorage clears when the PWA is closed; localStorage persists.
      // For an Add-to-Home-Screen PWA that the user expects to "stay signed in",
      // localStorage is the right choice — MSAL still stores tokens in encrypted
      // form on iOS Keychain via the browser's secure storage layer.
      cacheLocation: "localStorage",
      storeAuthStateInCookie: false,
    },
  });
  return pca;
}

/**
 * Initialize MSAL and consume any pending redirect response.
 * Must be awaited before any other auth call.
 */
export async function initAuth() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const p = getPca();
    await p.initialize();
    // handleRedirectPromise resolves with the AuthenticationResult if we just
    // returned from a sign-in redirect, or null otherwise. It MUST be called.
    await p.handleRedirectPromise();
    return p;
  })();
  return initPromise;
}

/**
 * Returns the currently signed-in account, or null.
 */
export function getActiveAccount() {
  if (!pca) return null;
  const accounts = pca.getAllAccounts();
  return accounts.length > 0 ? accounts[0] : null;
}

/**
 * Begin the sign-in redirect flow. The user is sent to login.live.com and
 * returned to redirect.html, which then navigates back to index.html.
 */
export async function signIn() {
  const p = await initAuth();
  await p.loginRedirect({
    scopes: config.scopes,
    prompt: "select_account",
  });
}

/**
 * Acquire an access token for the configured Graph scopes. Tries silent first,
 * falls back to interactive redirect on InteractionRequiredAuthError.
 */
export async function getAccessToken() {
  const p = await initAuth();
  const account = getActiveAccount();
  if (!account) {
    throw new Error("Not signed in.");
  }
  try {
    const result = await p.acquireTokenSilent({
      scopes: config.scopes,
      account,
    });
    return result.accessToken;
  } catch (err) {
    if (err && err.name === "InteractionRequiredAuthError") {
      // Silent failed (e.g., refresh token expired). Force interactive redirect.
      await p.acquireTokenRedirect({ scopes: config.scopes, account });
      // acquireTokenRedirect navigates away; nothing returns here.
      throw err;
    }
    throw err;
  }
}

/**
 * Sign out the active account and clear local state. Performs a redirect to
 * login.microsoftonline.com so the OAuth session is also terminated server-side.
 */
export async function signOut() {
  const p = await initAuth();
  const account = getActiveAccount();
  if (!account) return;
  await p.logoutRedirect({
    account,
    postLogoutRedirectUri: config.redirectUri.replace("/redirect.html", "/index.html"),
  });
}
