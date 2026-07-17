// The one message a user sends to bring a friend onto Ekko — shared by onboarding's done
// step and the popup's empty-contacts state so the pitch never forks. Handle-aware: with a
// claimed @handle the friend can add them by name; a ghost identity trades invites instead.
export function inviteMessage(username?: string): string {
  const base =
    'I started using Ekko for our chats — messages get sealed on my device before Instagram or WhatsApp ever see them. Get it at https://useekko.app';
  return username
    ? `${base} and add me there: I'm @${username}.`
    : `${base} — then send me your Ekko invite and I'll send you mine.`;
}
