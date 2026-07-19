// The web invite link (useekko.app/i#…) → the extension. A friend who isn't on Ekko yet lands
// on the /i page holding an invite in the URL fragment; this reads that fragment and hands it
// to the background, which stages it behind an explicit "Add" tap (it never auto-adds — a link
// must never be the same act as trusting a key).
//
// The payload lives in the FRAGMENT, which the browser never sends to any server, so the key
// only ever exists on this device and the friend's. This script just relays it in-process.
//
// Origin is enforced two ways, neither on this script's word: the manifest only injects it on
// https://useekko.app/i*, and the background re-checks sender.origin before trusting anything.

const FLAG = '__ekkoInvitePicked';
const w = window as unknown as Record<string, unknown>;
// On first install the background also injects this file into an already-open invite tab; if
// that races the manifest-declared injection, the flag keeps the second one from double-sending.
if (!w[FLAG]) {
  w[FLAG] = true;
  let invite = '';
  try {
    invite = decodeURIComponent(location.hash.slice(1)).trim();
  } catch {
    // A %-sequence mangled by a messenger's linkifier is not an invite — stay silent.
  }
  if (invite) void chrome.runtime.sendMessage({ type: 'adoptInvite', invite });
}
