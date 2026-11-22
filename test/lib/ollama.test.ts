import { describe, it, expect, afterEach } from "bun:test";
import { isLoopbackUrl, postEmbed, OllamaError } from "../../src/lib/ollama";
import { resolveEmbedSettings, type EmbedSettings } from "../../src/lib/embed-config";

type Handler = (req: Request) => Response | Promise<Response>;
let server: ReturnType<typeof Bun.serve> | null = null;
const requests: any[] = [];

function serve(handler: Handler): string {
  requests.length = 0;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      requests.push(await req.clone().json().catch(() => null));
      return handler(req);
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

afterEach(() => {
  server?.stop(true);
  server = null;
});

function settings(url: string, over: Partial<EmbedSettings> = {}): EmbedSettings {
  return {
    backend: "ollama", url, model: "qwen3-embedding:0.6b", dims: 4,
    keep_alive: "60s", timeout_ms: 2000, allow_remote: false, ...over,
  };
}

const vec = (n: number) => Array.from({ length: n }, () => 0.5);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof OllamaError ? e.code : `other: ${e}`;
  }
}

describe("postEmbed against a fake server", () => {
  it("sends one batch with model, input, keep_alive and truncate", async () => {
    const url = serve(() => Response.json({ embeddings: [vec(4), vec(4)] }));
    const r = await postEmbed(settings(url), ["a", "b"]);
    expect(r).toEqual({ ok: true, embeddings: [vec(4), vec(4)] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "qwen3-embedding:0.6b", input: ["a", "b"], keep_alive: "60s", truncate: true,
    });
  });

  it("returns other server errors as a value", async () => {
    const url = serve(() => Response.json({ error: "input length exceeds context length" }, { status: 400 }));
    const r = await postEmbed(settings(url), ["a"]);
    expect(r).toEqual({ ok: false, error: "input length exceeds context length" });
  });

  it("model not found is model_missing", async () => {
    const url = serve(() => Response.json({ error: 'model "x" not found, try pulling it first' }, { status: 404 }));
    expect(await code(postEmbed(settings(url), ["a"]))).toBe("model_missing");
  });

  it("a refused connection is ollama_down", async () => {
    const url = serve(() => Response.json({}));
    server!.stop(true);
    expect(await code(postEmbed(settings(url), ["a"]))).toBe("ollama_down");
  });

  it("a timeout is ollama_down", async () => {
    const url = serve(async () => {
      await Bun.sleep(300);
      return Response.json({ embeddings: [vec(4)] });
    });
    expect(await code(postEmbed(settings(url, { timeout_ms: 50 }), ["a"]))).toBe("ollama_down");
  });

  it("a vector of another length is dims_mismatch", async () => {
    const url = serve(() => Response.json({ embeddings: [vec(4), vec(3)] }));
    expect(await code(postEmbed(settings(url), ["a", "b"]))).toBe("dims_mismatch");
  });

  it("does not follow a redirect out of the server", async () => {
    const url = serve(() => new Response(null, { status: 302, headers: { location: "http://192.0.2.10/" } }));
    expect(await code(postEmbed(settings(url), ["a"]))).toBe("ollama_down");
  });
});

describe("loopback rule", () => {
  const accepted = [
    "http://localhost:11434", "http://LOCALHOST", "http://127.0.0.1:11434",
    "http://127.1.2.3:1", "http://[::1]:11434",
  ];
  const refused = [
    "http://192.0.2.10:11434", "https://example.org", "http://0.0.0.0:11434",
    "http://127.0.0.1.example.org", "http://localhost@example.org", "http://[::ffff:127.0.0.1]",
    "not a url",
  ];
  for (const u of accepted) it(`accepts ${u}`, () => expect(isLoopbackUrl(u)).toBe(true));
  for (const u of refused) it(`refuses ${u}`, () => expect(isLoopbackUrl(u)).toBe(false));

  it("a remote URL is ollama_remote and sends no request", async () => {
    let hit = false;
    const url = serve(() => { hit = true; return Response.json({}); });
    // Same server, reached by a non-loopback name through the settings only.
    const s = settings(url.replace("127.0.0.1", "localhost.example.org"));
    expect(await code(postEmbed(s, ["a"]))).toBe("ollama_remote");
    expect(hit).toBe(false);
  });

  it("allow_remote from the file lifts it (the request is then attempted)", async () => {
    const s = settings("http://192.0.2.10:1", { allow_remote: true, timeout_ms: 100 });
    expect(await code(postEmbed(s, ["a"]))).toBe("ollama_down");
  });

  it("allow_remote comes from the config file only, never from the environment", () => {
    const env = { TRAUL_ALLOW_REMOTE: "1", ALLOW_REMOTE: "true", TRAUL_OLLAMA_URL: "http://192.0.2.10:11434" };
    expect(resolveEmbedSettings({}, env).allow_remote).toBe(false);
    expect(resolveEmbedSettings({ allow_remote: true }, {}).allow_remote).toBe(true);
  });
});

describe("resolveEmbedSettings", () => {
  it("defaults: ollama, qwen3-embedding:0.6b, 1024 dims", () => {
    const s = resolveEmbedSettings({}, {});
    expect(s).toMatchObject({
      backend: "ollama", url: "http://127.0.0.1:11434", model: "qwen3-embedding:0.6b",
      dims: 1024, keep_alive: "60s", timeout_ms: 30000, allow_remote: false,
    });
  });

  it("environment overrides the file: TRAUL_OLLAMA_URL, then OLLAMA_URL, model, dims", () => {
    const file = { url: "http://localhost:1", model: "m1", dims: 8 };
    expect(resolveEmbedSettings(file, { OLLAMA_URL: "http://localhost:2" }).url).toBe("http://localhost:2");
    expect(
      resolveEmbedSettings(file, { OLLAMA_URL: "http://localhost:2", TRAUL_OLLAMA_URL: "http://localhost:3" }).url,
    ).toBe("http://localhost:3");
    const s = resolveEmbedSettings(file, { TRAUL_EMBED_MODEL: "m2", TRAUL_EMBED_DIMS: "16" });
    expect(s.model).toBe("m2");
    expect(s.dims).toBe(16);
    expect(resolveEmbedSettings(file, { TRAUL_EMBED_DIMS: "zero" }).dims).toBe(8);
  });

  it("the llama backend gets the Hugging Face model by default", () => {
    const s = resolveEmbedSettings({ backend: "llama" }, {});
    expect(s.backend).toBe("llama");
    expect(s.model).toContain("Qwen3-Embedding-0.6B");
  });

  it("an unknown backend falls back to ollama", () => {
    expect(resolveEmbedSettings({ backend: "nope" as any }, {}).backend).toBe("ollama");
  });
});
