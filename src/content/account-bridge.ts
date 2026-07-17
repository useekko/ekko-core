// Google sign-in for the extension, by way of a page that can already do it.
//
// Safari web extensions have NO `browser.identity`, so `chrome.identity.launchWebAuthFlow` — the
// canonical Chrome way to run an OAuth flow from an extension — does not exist in half the browsers
// we ship to. What DOES exist in every browser is a tab.
//
// So: the popup asks the background to open the Google flow, it lands back on
// account.useekko.app (already in Supabase's redirect allowlist, already signs in with Google),
// that page writes its session to localStorage exactly as it always has, and this content script
// hands it to the background. No `identity` permission, no new backend, no server change, and it
// works identically in Chrome and Safari.
//
// The background will only accept what we send here while it is EXPECTING a sign-in (a flag the
// popup's button sets, valid for a few minutes) and only from this exact origin. Merely visiting
// the account page must never silently sign the extension in.

const KEY = 'ekko.account.session'; // must match STORE_KEY in worker/account/index.js

interface PageSession {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
}

function readSession(): PageSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PageSession) : null;
  } catch {
    return null; // a page that stored junk is not a session
  }
}

let handed = false;

async function hand(): Promise<boolean> {
  if (handed) return true;
  const s = readSession();
  if (typeof s?.access_token !== 'string' || typeof s?.refresh_token !== 'string') return false;

  handed = true;
  await chrome.runtime.sendMessage({
    type: 'acctAdoptSession',
    session: {
      accessToken: s.access_token,
      refreshToken: s.refresh_token,
      // The page counts in SECONDS (`expires_at`), the extension in MILLISECONDS. Get this wrong
      // and the session reads as expired the moment it lands, so every call refreshes on its first
      // use — which works, and hides the bug until the refresh token is the only thing left.
      expiresAt: Number(s.expires_at) * 1000,
    },
  });
  return true;
}

// The session is written by the page's own JS after Google redirects back, which may land before or
// after this script runs — so poll rather than race it. Bounded: a tab left open on the account page
// must not poll forever.
void (async () => {
  if (await hand()) return;
  const started = Date.now();
  const timer = setInterval(() => {
    void hand().then((done) => {
      if (done || Date.now() - started > 120_000) clearInterval(timer);
    });
  }, 500);
})();
