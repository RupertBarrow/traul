import { describe, it, expect } from "bun:test";
import { parseMessage } from "../../src/lib/mime";
import { decodeMimeWords, decodeCharset } from "../../src/lib/mime-words";

const msg = (head: string[], body: string | Buffer): Buffer =>
  Buffer.concat([Buffer.from(head.join("\r\n") + "\r\n\r\n", "latin1"),
    typeof body === "string" ? Buffer.from(body, "utf-8") : body]);
const opts = { maxTextChars: 100000 };

describe("mime: structure", () => {
  it("plain text", () => {
    const m = parseMessage(msg(["Subject: Hi", "Content-Type: text/plain; charset=utf-8"], "Hello\r\nworld"), opts);
    expect(m.text).toBe("Hello\r\nworld");
    expect(m.subject).toBe("Hi");
  });

  it("no content type means plain text", () => {
    expect(parseMessage(msg(["Subject: x"], "bare"), opts).text).toBe("bare");
  });

  it("html only goes through html-to-text", () => {
    const m = parseMessage(msg(["Content-Type: text/html"], "<p>Bonjour <b>tout</b> le monde</p><img src='x'>"), opts);
    expect(m.text).toBe("Bonjour tout le monde");
  });

  it("alternative prefers text/plain", () => {
    const body = [
      "--b1", "Content-Type: text/plain; charset=utf-8", "", "plain version",
      "--b1", "Content-Type: text/html; charset=utf-8", "", "<p>html version</p>", "--b1--", "",
    ].join("\r\n");
    const m = parseMessage(msg(["Content-Type: multipart/alternative; boundary=b1"], body), opts);
    expect(m.text).toBe("plain version");
  });

  it("nested mixed(alternative(...), attachment) skips the attachment", () => {
    const body = [
      "--out", "Content-Type: multipart/alternative; boundary=in", "",
      "--in", "Content-Type: text/html", "", "<p>html</p>",
      "--in", "Content-Type: text/plain", "", "the text", "--in--",
      "--out", "Content-Type: application/pdf; name=a.pdf", "Content-Disposition: attachment; filename=a.pdf",
      "Content-Transfer-Encoding: base64", "", "SECRETPDFBYTES", "--out--", "",
    ].join("\r\n");
    const m = parseMessage(msg(["Content-Type: multipart/mixed; boundary=out"], body), opts);
    expect(m.text).toBe("the text");
    expect(m.text).not.toContain("SECRET");
  });

  it("a text attachment is skipped too", () => {
    const body = ["--o", "Content-Type: text/plain", "", "body", "--o",
      "Content-Type: text/plain", "Content-Disposition: attachment; filename=n.txt", "", "ATTACHED", "--o--", ""].join("\r\n");
    expect(parseMessage(msg(["Content-Type: multipart/mixed; boundary=o"], body), opts).text).toBe("body");
  });

  it("related: html with an inline image part", () => {
    const body = ["--r", "Content-Type: text/html", "", "<p>see</p>", "--r", "Content-Type: image/png",
      "Content-ID: <x>", "Content-Transfer-Encoding: base64", "", "AAAA", "--r--", ""].join("\r\n");
    expect(parseMessage(msg(["Content-Type: multipart/related; boundary=r"], body), opts).text).toBe("see");
  });

  it("an empty body gives empty text, not an error", () => {
    const m = parseMessage(msg(["Subject: only subject"], ""), opts);
    expect(m.text).toBe("");
    expect(m.subject).toBe("only subject");
  });

  it("accepts bare LF line endings", () => {
    const raw = Buffer.from("Subject: lf\nContent-Type: text/plain\n\nbody\n", "latin1");
    expect(parseMessage(raw, opts).text.trim()).toBe("body");
  });
});

describe("mime: transfer encodings and charsets", () => {
  it("base64", () => {
    const b64 = Buffer.from("Été à Paris", "utf-8").toString("base64");
    const m = parseMessage(msg(["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"], b64), opts);
    expect(m.text).toBe("Été à Paris");
  });

  it("quoted-printable with soft breaks, utf-8", () => {
    const qp = "Caf=C3=A9 cr=C3=A8me, un tr=\r\n=C3=A8s long mot";
    const m = parseMessage(msg(["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable"], qp), opts);
    expect(m.text).toBe("Café crème, un très long mot");
  });

  it("ISO-8859-1 and windows-1252 French samples", () => {
    const l1 = parseMessage(msg(["Content-Type: text/plain; charset=ISO-8859-1", "Content-Transfer-Encoding: quoted-printable"],
      "=E0 la fran=E7aise, =EA=EE=F4"), opts);
    expect(l1.text).toBe("à la française, êîô");
    const w = parseMessage(msg(["Content-Type: text/plain; charset=windows-1252"], Buffer.from([0x93, 0x6f, 0x75, 0x69, 0x94, 0x20, 0x80])), opts);
    expect(w.text).toBe("“oui” €");
  });

  it("ISO-8859-15 maps its eight differing code points", () => {
    const bytes = Buffer.from([0xa4, 0xa6, 0xa8, 0xb4, 0xb8, 0xbc, 0xbd, 0xbe, 0xe9]);
    expect(decodeCharset("iso-8859-15", bytes)).toBe("€ŠšŽžŒœŸé".replace("Ž", "Ž"));
    const m = parseMessage(msg(["Content-Type: text/plain; charset=iso-8859-15"], bytes), opts);
    expect(m.text).toBe("€ŠšŽžŒœŸé");
  });

  it("an unknown charset falls back to utf-8 without throwing", () => {
    expect(decodeCharset("x-no-such", Buffer.from("abc"))).toBe("abc");
  });
});

describe("mime: RFC 2047", () => {
  it("decodes B and Q words, utf-8 and latin1", () => {
    expect(decodeMimeWords("=?UTF-8?B?Q2Fmw6k=?=")).toBe("Café");
    expect(decodeMimeWords("=?ISO-8859-1?Q?Caf=E9_cr=E8me?=")).toBe("Café crème");
    expect(decodeMimeWords("=?iso-8859-15?Q?=A4_5?=")).toBe("€ 5");
  });

  it("drops whitespace between adjacent words and joins a split multibyte character", () => {
    const e = Buffer.from("é", "utf-8");
    const a = `=?UTF-8?B?${e.subarray(0, 1).toString("base64")}?=`;
    const b = `=?UTF-8?B?${e.subarray(1).toString("base64")}?=`;
    expect(decodeMimeWords(`${a}\r\n ${b}`)).toBe("é");
    expect(decodeMimeWords("=?UTF-8?Q?a?= =?UTF-8?Q?b?= tail")).toBe("ab tail");
  });

  it("leaves a malformed word alone", () => {
    expect(decodeMimeWords("=?bad?X?zz?= plain")).toBe("=?bad?X?zz?= plain");
  });

  it("decodes folded subjects and addresses", () => {
    const m = parseMessage(msg([
      "Subject:", " =?UTF-8?B?w4l0w6k=?=",
      "From: =?ISO-8859-1?Q?Andr=E9_Dupont?= <andre@example.org>",
      "To: a@example.org, \"Z, Y\" <z@example.org>",
    ], "x"), opts);
    expect(m.subject).toBe("Été");
    expect(m.from).toEqual({ address: "andre@example.org", name: "André Dupont" });
    expect(m.to).toEqual(["a@example.org", "z@example.org"]);
  });
});

describe("mime: headers and limits", () => {
  it("reads ids, dates and list headers", () => {
    const m = parseMessage(msg([
      "Message-ID: <abc@example.org>", "References: <r1@example.org> <r2@example.org>",
      "In-Reply-To: <p@example.org>", "Date: Tue, 03 Nov 2026 10:00:00 +0100",
      "List-Unsubscribe: <mailto:u@example.org>", "List-Id: <l.example.org>",
    ], "x"), opts);
    expect(m.messageId).toBe("abc@example.org");
    expect(m.references).toEqual(["r1@example.org", "r2@example.org"]);
    expect(m.inReplyTo).toBe("p@example.org");
    expect(m.date).toBe("2026-11-03T09:00:00.000Z");
    expect(m.listUnsubscribe).toBe("<mailto:u@example.org>");
    expect(m.listId).toBe("<l.example.org>");
  });

  it("an unparseable date is null", () => {
    expect(parseMessage(msg(["Date: not a date"], "x"), opts).date).toBeNull();
  });

  it("cuts the text at maxTextChars", () => {
    const m = parseMessage(msg(["Content-Type: text/plain"], "a".repeat(500)), { maxTextChars: 100 });
    expect(m.text).toHaveLength(100);
    expect(m.truncated).toBe(true);
  });

  it("a part cut by the partial fetch is decoded as far as it goes and flagged", () => {
    const body = ["--b", "Content-Type: text/plain", "Content-Transfer-Encoding: base64", "",
      Buffer.from("The quick brown fox").toString("base64").slice(0, 16)].join("\r\n");
    const m = parseMessage(msg(["Content-Type: multipart/mixed; boundary=b"], body), opts);
    expect(m.truncated).toBe(true);
    expect(m.text.startsWith("The quick")).toBe(true);
  });

  it("a truncated quoted-printable escape does not leak the half escape", () => {
    const m = parseMessage(msg(["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable"], "ok =C"), opts);
    expect(m.text).toBe("ok ");
  });
});
