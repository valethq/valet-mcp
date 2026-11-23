import { expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toToolResult } from "../src/result";

const blobs = {
  put: async (bytes: Uint8Array, meta?: { mime?: string }) => ({
    id: `blob-${meta?.mime ?? "bin"}-${bytes.length}`,
  }),
  path: (id: string) => `/tmp/${id}`,
};

test("maps text and structured content", async () => {
  const result = await toToolResult(
    { content: [{ type: "text", text: "hello" }], structuredContent: { answer: 42 } },
    blobs,
  );
  expect(result.isError).toBeUndefined();
  expect(result.content.map((c) => (c.type === "text" ? c.text : ""))).toEqual([
    "hello",
    JSON.stringify({ answer: 42 }, null, 2),
  ]);
});

test("stores MCP images as blobs", async () => {
  const png = Buffer.from("png").toString("base64");
  const result: CallToolResult = { content: [{ type: "image", data: png, mimeType: "image/png" }] };
  const out = await toToolResult(result, blobs);
  expect(out.content).toEqual([{ type: "image", mime: "image/png", blobId: "blob-image/png-3" }]);
});

test("passes through MCP errors and handles task-shaped results", async () => {
  const errored = await toToolResult({ content: [{ type: "text", text: "bad" }], isError: true }, blobs);
  expect(errored.isError).toBe(true);
  const task = await toToolResult({ toolResult: { value: 1 } }, blobs);
  expect(task.isError).toBe(true);
  expect(task.content[0]).toMatchObject({ type: "text" });
});
