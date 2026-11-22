/** IMAP modified UTF-7 (RFC 3501 5.1.3) for folder names. */

export function utf7Decode(s: string): string {
  return s.replace(/&([^-]*)-/g, (_, b64: string) => {
    if (!b64) return "&";
    const buf = Buffer.from(b64.replace(/,/g, "/"), "base64");
    return buf.subarray(0, buf.length - (buf.length % 2)).swap16().toString("utf16le");
  });
}

export function utf7Encode(s: string): string {
  return s.replace(/&/g, "&-").replace(/[^\x20-\x7e]+/g, (run) =>
    `&${Buffer.from(run, "utf16le").swap16().toString("base64").replace(/=+$/, "").replace(/\//g, ",")}-`);
}
