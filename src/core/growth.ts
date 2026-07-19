// The one message a user sends to bring a friend onto Ekko — shared by onboarding's done
// step, the popup's empty-contacts state, and the in-page "invite peer" glyph so the pitch
// never forks. It now carries an invite LINK (useekko.app/i#…): a claimed @handle makes a
// short link the friend opens on any device; a ghost identity carries its whole public key
// bundle in the link's fragment (~1,650 chars) so the friend lands ready to add them. The key
// rides the URL FRAGMENT, which the browser never sends to any server — it stays on the two
// devices. `maxLen` gates the ghost case: where a composer caps message length (Instagram's
// ~1,000), a too-long link degrades to the plain pitch and invites are traded the old way.
const SITE = 'https://useekko.app';

export function inviteLink(username?: string, token?: string): string {
  if (username) return `${SITE}/i#@${username}`;
  if (token) return `${SITE}/i#${token}`;
  return SITE;
}

export function inviteMessage(username?: string, token?: string, maxLen = Infinity): string {
  const base =
    'I started using Ekko for our chats — messages get sealed on my device before Instagram or WhatsApp ever see them.';
  const link = inviteLink(username, token);
  const msg = username
    ? `${base} Add me on Ekko: ${link}`
    : token
      ? `${base} Here's my Ekko invite — open it to add me: ${link}`
      : `${base} Get it at ${link} — then send me your Ekko invite and I'll send you mine.`;
  if (msg.length <= maxLen) return msg;
  // The link (a ghost's ~1,650-char key bundle) won't fit this composer: fall back to the
  // plain pitch and trade invites directly, the way it worked before links.
  return `${base} Get it at ${SITE} — then send me your Ekko invite and I'll send you mine.`;
}
