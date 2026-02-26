/**
 * AnyRouter Proxy — 请求/响应转换逻辑
 *
 * 1. 深度清理 "[undefined]" 字符串值（Cherry Studio 兼容）
 * 2. 工具名 PascalCase 转换（OpenCode 兼容）
 * 3. 修复数组被序列化为字符串的问题
 * 4. SSE 流中工具名转换
 */

import type {
  RequestBody,
  ResponseBody,
  SSEData,
  ToolNameMap,
} from "./types.js";

// ============================================================
// 工具名映射
// ============================================================

const NAME_MAP: ToolNameMap = {
  todowrite: "TodoWrite",
  webfetch: "WebFetch",
  google_search: "Google_Search",
};

// Anthropic 内置服务端工具的 type 前缀
// 这些工具的 name 不能被修改
const BUILTIN_TOOL_TYPES = [
  "web_search",
  "computer",
  "text_editor",
  "bash",
  "code_execution",
  "memory",
  "web_fetch",
  "tool_search",
];

/** 判断工具是否为 Anthropic 内置工具 */
function isBuiltinTool(tool: { type?: string; [key: string]: unknown }): boolean {
  if (!tool.type || typeof tool.type !== "string") return false;
  return BUILTIN_TOOL_TYPES.some((prefix) => tool.type!.startsWith(prefix));
}


/** 映射工具名：先查表，否则首字母大写 */
export function mapName(
  name: string | undefined | null,
): string | undefined | null {
  if (!name || typeof name !== "string") return name;
  if (NAME_MAP[name]) return NAME_MAP[name];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ============================================================
// 深度清理 "[undefined]"
// ============================================================

/**
 * 递归移除对象中所有值为 "[undefined]" 的字段。
 * Cherry Studio 会把 JS 的 undefined 序列化成字符串 "[undefined]"，
 * Anthropic API 无法识别这些值导致请求被拒绝。
 */
export function cleanUndefined(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.filter((item) => item !== "[undefined]").map(cleanUndefined);
  }
  if (obj !== null && typeof obj === "object") {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (value === "[undefined]") continue;
      cleaned[key] = cleanUndefined(value);
    }
    return cleaned;
  }
  return obj;
}

// ============================================================
// 请求体转换
// ============================================================

/** 转换请求体中的工具名为 PascalCase（跳过 Anthropic 内置工具） */
export function transformRequestBody(body: RequestBody): RequestBody {
  if (!body || typeof body !== "object") return body;

  if (Array.isArray(body.tools)) {
    body.tools.forEach((tool) => {
      // 跳过 Anthropic 内置服务端工具（web_search、computer 等）
      if (isBuiltinTool(tool)) return;
      if (tool?.name) tool.name = mapName(tool.name) ?? tool.name;
    });
  }

  if (Array.isArray(body.messages)) {
    body.messages.forEach((message) => {
      if (!Array.isArray(message?.content)) return;
      message.content.forEach((block) => {
        if (block?.type === "tool_use" && block.name) {
          block.name = mapName(block.name) ?? block.name;
        }
      });
    });
  }

  return body;
}

// ============================================================
// 响应体转换：修复数组序列化
// ============================================================

/** 修复 tool_use input 中被字符串化的数组/对象 */
export function transformResponseBody(body: ResponseBody): ResponseBody {
  if (!body || !Array.isArray(body.content)) return body;

  body.content.forEach((block) => {
    if (
      block?.type !== "tool_use" ||
      !block.input ||
      typeof block.input !== "object"
    )
      return;

    for (const key of Object.keys(block.input)) {
      const value = block.input[key];
      if (
        typeof value === "string" &&
        (value.startsWith("[") || value.startsWith("{"))
      ) {
        try {
          block.input[key] = JSON.parse(value);
        } catch {
          // 解析失败则保留原值
        }
      }
    }
  });

  return body;
}

// ============================================================
// SSE 流转换
// ============================================================

/** 转换单行 SSE data 中的工具名 */
export function transformSSELine(line: string): string {
  if (!line.startsWith("data:")) return line;

  const jsonStr = line.slice(5).trim();
  if (!jsonStr || jsonStr === "[DONE]") return line;

  try {
    const data: SSEData = JSON.parse(jsonStr);

    if (
      data.type === "content_block_start" &&
      data.content_block?.type === "tool_use" &&
      data.content_block.name
    ) {
      data.content_block.name =
        mapName(data.content_block.name) ?? data.content_block.name;
      return `data: ${JSON.stringify(data)}`;
    }

    return line;
  } catch {
    return line;
  }
}
