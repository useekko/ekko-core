// A provider conversation ID is only unique inside that provider. Keep the platform in
// every persistent key so two unrelated chats can never share a contact binding.
export function scopedThreadId(platform: string, providerThreadId: string): string {
  return `${platform}:${providerThreadId}`;
}

const SCOPED_THREAD_ID_RE = /^[a-z][a-z0-9-]{0,31}:[!-~]+$/i;

export function isScopedThreadId(threadId: unknown): threadId is string {
  return typeof threadId === 'string' && threadId.length <= 512 && SCOPED_THREAD_ID_RE.test(threadId);
}

// Copy/paste is the sanctioned cross-platform path. Keep its session context separate
// per delivery app; the popup itself owns the ID because there is no provider chat ID.
export const MANUAL_PLATFORMS = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'messenger', label: 'Messenger' },
  { id: 'x', label: 'X' },
] as const;

export type ManualPlatformId = (typeof MANUAL_PLATFORMS)[number]['id'];

export function manualThreadId(platform: ManualPlatformId): string {
  return scopedThreadId('popup', `manual:${platform}`);
}

// True for any popup-owned (non-transport) context. Owned here, next to manualThreadId,
// so a change to the manual scoping scheme can't silently strand callers that need to
// tell manual contexts apart from real conversations (e.g. the vault migration).
export function isManualThreadId(threadId: string): boolean {
  return threadId.startsWith('popup:');
}
