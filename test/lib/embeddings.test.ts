import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { resolveEmbedSettings, _setEmbedSettings } from "../../src/lib/embed-config";

const fakeVector = new Float32Array(1024).fill(0.42);
const fakeVector2 = new Float32Array(1024).fill(0.84);

let llamaLoads = 0;
const mockLlama = {
  embedDoc: mock(() => Promise.resolve(fakeVector)),
  embedQuery: mock(() => Promise.resolve(fakeVector)),
  embedDocBatch: mock(() => Promise.resolve([fakeVector, fakeVector2])),
};

mock.module("../../src/lib/llama", () => {
  llamaLoads++;
  return mockLlama;
});

const { embed, embedQuery, embedBatch, vecToBytes, MAX_TEXT_LENGTH } = await import("../../src/lib/embeddings");

const originalFetch = globalThis.fetch;
const sent: any[] = [];
function mockFetch(handler: (body: any) => Response | Promise<Response>) {
  globalThis.fetch = mock(async (_url: any, opts: any) => {
    const body = JSON.parse(opts.body as string);
    sent.push(body);
    return handler(body);
  }) as unknown as typeof fetch;
}

function ollamaResponse(count: number, dims = 1024) {
  return Response.json({ embeddings: Array.from({ length: count }, () => Array.from({ length: dims }, () => 0.1)) });
}

function useBackend(backend: "ollama" | "llama") {
  _setEmbedSettings(resolveEmbedSettings({ backend }, {}));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setEmbedSettings(null);
});

describe("backend ollama (the default)", () => {
  beforeEach(() => {
    sent.length = 0;
    useBackend("ollama");
  });

  it("never loads the llama module", async () => {
    mockFetch((b) => ollamaResponse(b.input.length));
    const before = llamaLoads;
    await embed("hello");
    await embedQuery("hello");
    await embedBatch(["a", "b"]);
    expect(llamaLoads).toBe(before);
    expect(mockLlama.embedDoc).not.toHaveBeenCalled();
  });

  it("embed() uses the configured model and returns a Float32Array", async () => {
    mockFetch((b) => ollamaResponse(b.input.length));
    const result = await embed("hello");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(1024);
    expect(sent[0].model).toBe("qwen3-embedding:0.6b");
  });

  it("embedQuery() adds the Qwen instruction prefix, embed() does not", async () => {
    mockFetch((b) => ollamaResponse(b.input.length));
    await embedQuery("find me");
    await embed("a document");
    expect(sent[0].input[0]).toBe("Instruct: Retrieve relevant documents for the given query\nQuery: find me");
    expect(sent[1].input[0]).toBe("a document");
  });

  it("embedBatch() truncates long texts", async () => {
    mockFetch((b) => ollamaResponse(b.input.length));
    await embedBatch(["short", "x".repeat(5000)]);
    for (const text of sent[0].input) expect(text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
  });

  it("a batch of other failures is skipped and reported", async () => {
    mockFetch(() => Response.json({ error: "boom" }, { status: 500 }));
    const skipped: number[] = [];
    const out = await embedBatch(["a", "b"], (i) => skipped.push(i));
    expect(out).toEqual([null, null]);
    expect(skipped).toEqual([0, 1]);
  });

  it("falls back to single items when the batch overflows the context", async () => {
    mockFetch((b) =>
      b.input.length > 1 ? Response.json({ error: "input length exceeds context length" }, { status: 400 }) : ollamaResponse(1),
    );
    const out = await embedBatch(["a", "b"]);
    expect(out.every((v) => v instanceof Float32Array)).toBe(true);
  });

  it("a named failure is thrown, not skipped, and nothing is returned", async () => {
    mockFetch(() => Response.json({ error: "model not found" }, { status: 404 }));
    await expect(embedBatch(["a"])).rejects.toMatchObject({ code: "model_missing" });
  });

  it("a vector of another length is dims_mismatch", async () => {
    mockFetch((b) => ollamaResponse(b.input.length, 768));
    await expect(embed("a")).rejects.toMatchObject({ code: "dims_mismatch" });
  });
});

describe("backend llama (by configuration only)", () => {
  beforeEach(() => {
    useBackend("llama");
    mockLlama.embedDoc.mockClear();
    mockLlama.embedQuery.mockClear();
    mockLlama.embedDocBatch.mockClear();
    mockLlama.embedDoc.mockImplementation(() => Promise.resolve(fakeVector));
  });

  it("embed(), embedQuery() and embedBatch() go to llama", async () => {
    expect((await embed("hello")).length).toBe(1024);
    await embedQuery("q");
    expect(await embedBatch(["a", "b"])).toHaveLength(2);
    expect(mockLlama.embedDoc).toHaveBeenCalledWith("hello");
    expect(mockLlama.embedQuery).toHaveBeenCalledWith("q");
    expect(mockLlama.embedDocBatch).toHaveBeenCalled();
  });

  it("pre-truncates text", async () => {
    await embed("x".repeat(5000));
    const calledWith = (mockLlama.embedDoc.mock.calls as unknown[][])[0][0] as string;
    expect(calledWith.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
  });

  it("a llama failure is an error: no fall-through to Ollama", async () => {
    mockLlama.embedDoc.mockImplementation(() => { throw new Error("llama unavailable"); });
    let fetched = false;
    globalThis.fetch = mock(async () => { fetched = true; return ollamaResponse(1); }) as unknown as typeof fetch;
    await expect(embed("hello")).rejects.toThrow("llama unavailable");
    expect(fetched).toBe(false);
  });
});

describe("vecToBytes", () => {
  it("produces the right Uint8Array", () => {
    const bytes = vecToBytes(new Float32Array([1.0, 2.0]));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(8);
  });
});
