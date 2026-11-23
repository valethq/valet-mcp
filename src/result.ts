import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Store } from "@valethq/sdk";
import type { ToolResult } from "@valethq/sdk";

type Content = NonNullable<CallToolResult["content"]>[number];

const text = (t: string): ToolResult["content"][number] => ({ type: "text", text: t });

async function mapContent(item: Content, blobs: Store["blobs"]): Promise<ToolResult["content"]> {
  if (item.type === "text") return [text(item.text)];
  if (item.type === "image") {
    const bytes = Buffer.from(item.data, "base64");
    const blob = await blobs.put(bytes, { mime: item.mimeType });
    return [{ type: "image", mime: item.mimeType, blobId: blob.id }];
  }
  if (item.type === "audio")
    return [text(`[audio ${item.mimeType}: ${item.data.length} base64 chars omitted]`)];
  if (item.type === "resource") {
    if ("text" in item.resource) {
      return [text(`[resource ${item.resource.uri}]\n${item.resource.text}`)];
    }
    return [
      text(
        `[binary resource ${item.resource.uri}${item.resource.mimeType ? ` ${item.resource.mimeType}` : ""}]`,
      ),
    ];
  }
  return [text(JSON.stringify(item, null, 2))];
}

export async function toToolResult(
  result: CallToolResult | { toolResult?: unknown },
  blobs: Store["blobs"],
): Promise<ToolResult> {
  if (!("content" in result) || !Array.isArray(result.content)) {
    return { content: [text(JSON.stringify(result, null, 2))], isError: true };
  }
  const content: ToolResult["content"] = [];
  for (const item of result.content) content.push(...(await mapContent(item, blobs)));
  if (result.structuredContent !== undefined) {
    content.push(text(JSON.stringify(result.structuredContent, null, 2)));
  }
  if (content.length === 0) content.push(text("No content returned."));
  return { content, ...(result.isError === true && { isError: true }) };
}
