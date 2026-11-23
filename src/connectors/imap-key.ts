/**
 * The key of a stored message, identical to the consumer's (shared vectors in test/fixtures/triage-keys.json):
 * `mid:<Message-ID without angle brackets>`, or without a Message-ID `imap:<account>:<folder>:<uidValidity>:<uid>`.
 * The expression is kept exactly as the consumer's, quirks included, so that both sides derive the same key.
 */

export function messageIdKey(headersText: string): string | null {
  const m = /^Message-ID:\s*(.+)$/im.exec(headersText || "");
  if (!m) return null;
  const id = m[1].trim().replace(/^<|>$/g, "");
  return id ? `mid:${id}` : null;
}

export function locatorKey(account: string, folder: string, uidValidity: number, uid: number): string {
  return `imap:${account}:${folder}:${uidValidity}:${uid}`;
}

export function messageKey(headersText: string, account: string, folder: string, uidValidity: number, uid: number): string {
  return messageIdKey(headersText) ?? locatorKey(account, folder, uidValidity, uid);
}
