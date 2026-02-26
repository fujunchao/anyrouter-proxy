/**
 * AnyRouter Proxy — HTTP 反向代理服务器
 *
 * Cherry Studio / 任意 Anthropic 客户端 → 本代理 → AnyRouter → Claude API
 *
 * 处理流程：
 * 1. 接收请求，读取 body
 * 2. 深度清理 "[undefined]" 值（Cherry Studio 兼容）
 * 3. 工具名转为 PascalCase（OpenCode 兼容）
 * 4. 注入 Claude Code system prompt（通过 AnyRouter 验证的唯一必需项）
 * 5. 注入 thinking 参数（Cherry Studio "默认"模式自动启用思考）
 * 6. 通过原生 HTTPS 转发至上游 AnyRouter
 * 7. 响应透传（SSE 流式 / JSON 非流式）+ 工具名反向转换
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { RequestBody } from "./types.js";
import {
  cleanUndefined,
  transformRequestBody,
  transformResponseBody,
  transformSSELine,
} from "./transform.js";

// ============================================================
// 配置
// ============================================================

const TARGET_URL = process.env.TARGET_URL || "https://anyrouter.top";
const PORT = parseInt(process.env.PORT || "5489", 10);
const API_KEY = process.env.API_KEY || "";

// ============================================================
// Claude Code System Prompt — 通过 AnyRouter 验证的唯一必需项
// ============================================================

const CLAUDE_CODE_SYSTEM = [
  {
    type: "text",
    text: "You are Claude Code, Anthropic's official CLI for Claude.",
    cache_control: { type: "ephemeral" },
  },
  {
    type: "text",
    text: "You are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.\n\n# Tone and style\n- Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.\n- Your output will be displayed on a command line interface. Your responses should be short and concise. You can use Github-flavored markdown for formatting, and will be rendered in a monospace font using the CommonMark specification.\n- Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like Bash or code comments as means to communicate with the user during the session.\n\n# Doing tasks\nThe user will primarily request you perform software engineering tasks. This includes solving bugs, adding new functionality, refactoring code, explaining code, and more.\n\nHere is useful information about the environment you are running in:\n<env>\nPlatform: win32\nShell: bash\n</env>",
    cache_control: { type: "ephemeral" },
  },
];

// ============================================================
// Thinking 注入 — 让 Cherry Studio "默认"模式也能启用思考
// ============================================================

/** Claude 4.6 系列模型（使用 adaptive thinking） */
const CLAUDE_46_PATTERNS = [
  "claude-opus-4",
  "claude-4-opus",
  "claude-opus-4-6",
];

/** 支持 thinking 的 Claude 模型前缀 */
const CLAUDE_THINKING_PATTERNS = [
  "claude-3-5-sonnet",
  "claude-3.5-sonnet",
  "claude-3-7-sonnet",
  "claude-3.7-sonnet",
  "claude-4",
  "claude-sonnet-4",
  "claude-opus-4",
];

/** 默认 thinking budget（token 数） */
const DEFAULT_THINKING_BUDGET = 10000;

function isClaude46Model(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return CLAUDE_46_PATTERNS.some((p) => lower.includes(p));
}

function isClaudeThinkingModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return CLAUDE_THINKING_PATTERNS.some((p) => lower.includes(p));
}

/**
 * 注入 thinking 参数
 *
 * Cherry Studio 的"默认"思考模式不发送 thinking 字段，
 * 导致 Claude 不会进行扩展思考。
 * 此函数在客户端未发送 thinking 时自动注入：
 * - Claude 4.6 系列 → { type: "adaptive" }
 * - 其他支持思考的 Claude → { type: "enabled", budget_tokens: 10000 }
 */
function injectThinking(body: RequestBody): RequestBody {
  // 客户端已发送 thinking 参数，不覆盖
  if (body.thinking !== undefined) return body;

  const model = body.model as string | undefined;
  if (!model) return body;

  if (isClaude46Model(model)) {
    body.thinking = { type: "adaptive" };
    console.log(`[proxy] 注入 thinking: adaptive (model=${model})`);
  } else if (isClaudeThinkingModel(model)) {
    body.thinking = { type: "enabled", budget_tokens: DEFAULT_THINKING_BUDGET };
    // 启用 thinking 时 max_tokens 必须足够大
    if (!body.max_tokens || (body.max_tokens as number) < DEFAULT_THINKING_BUDGET + 4096) {
      body.max_tokens = DEFAULT_THINKING_BUDGET + 4096;
    }
    console.log(`[proxy] 注入 thinking: enabled, budget=${DEFAULT_THINKING_BUDGET} (model=${model})`);
  }

  return body;
}

// ============================================================
// 工具函数
// ============================================================

/** 从 Node.js IncomingMessage 读取完整 body */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** 返回错误响应 */
function sendError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { type: "proxy_error", message } }));
}

/**
 * 注入 Claude Code system prompt
 *
 * AnyRouter 要求 system 字段必须精确为 2 段 Claude Code 内容，
 * 不允许追加第 3 段。如果客户端发送了自定义 system prompt，
 * 将其移到第一条 user message 的开头作为上下文。
 */
function injectSystemPrompt(body: RequestBody): RequestBody {
  // 保存客户端原始 system prompt
  let clientSystem: string | null = null;

  if (body.system) {
    if (typeof body.system === "string") {
      clientSystem = body.system;
    } else if (Array.isArray(body.system)) {
      // 提取所有 text 内容
      const texts = body.system
        .filter((s: any) => s.type === "text" && s.text)
        .map((s: any) => s.text);
      if (texts.length > 0) {
        clientSystem = texts.join("\n\n");
      }
    }
  }

  // 替换为 Claude Code system prompt
  body.system = CLAUDE_CODE_SYSTEM;

  // 如果客户端有自定义 system prompt，移到第一条 user message
  if (clientSystem && body.messages && Array.isArray(body.messages)) {
    const firstUserIdx = body.messages.findIndex(
      (m: any) => m.role === "user",
    );

    if (firstUserIdx >= 0) {
      const msg = body.messages[firstUserIdx];
      const prefix = `[System Instructions]\n${clientSystem}\n[End System Instructions]\n\n`;

      if (typeof msg.content === "string") {
        msg.content = prefix + msg.content;
      } else if (Array.isArray(msg.content)) {
        // 在 content 数组开头插入 text block
        msg.content.unshift({
          type: "text",
          text: prefix,
        });
      }
    }
  }

  return body;
}

/**
 * 通过原生 HTTPS 转发请求到上游
 * 返回上游的完整响应（流式时直接 pipe）
 */
function forwardRequest(
  method: string,
  upstreamURL: string,
  headers: Record<string, string>,
  body: string | undefined,
  clientRes: http.ServerResponse,
  isStreaming: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(upstreamURL);

    const reqHeaders: Record<string, string> = {
      ...headers,
      Host: url.hostname,
    };
    if (body) {
      reqHeaders["Content-Length"] = String(Buffer.byteLength(body));
    }

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: method,
        headers: reqHeaders,
      },
      (upstreamRes) => {
        const contentType = upstreamRes.headers["content-type"] || "";
        const status = upstreamRes.statusCode || 502;

        if (isStreaming && contentType.includes("text/event-stream")) {
          // === SSE 流式响应 ===
          const resHeaders: Record<string, string> = {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          };
          clientRes.writeHead(status, resHeaders);

          let buffer = "";

          upstreamRes.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf-8");
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";

            for (const part of parts) {
              const transformed = part
                .split("\n")
                .map(transformSSELine)
                .join("\n");
              clientRes.write(transformed + "\n\n");
            }
          });

          upstreamRes.on("end", () => {
            // 处理剩余 buffer
            if (buffer.trim()) {
              const transformed = buffer
                .split("\n")
                .map(transformSSELine)
                .join("\n");
              clientRes.write(transformed + "\n\n");
            }
            clientRes.end();
            resolve();
          });

          upstreamRes.on("error", (err) => {
            console.error(`[proxy] SSE stream error: ${err.message}`);
            clientRes.end();
            resolve();
          });
        } else {
          // === 非流式 JSON 响应 ===
          const chunks: Buffer[] = [];
          upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
          upstreamRes.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            let output = raw;

            if (contentType.includes("application/json") && raw) {
              try {
                output = JSON.stringify(
                  transformResponseBody(JSON.parse(raw)),
                );
              } catch {
                // 解析失败，返回原始内容
              }
            }

            clientRes.writeHead(status, {
              "Content-Type":
                contentType || "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            clientRes.end(output);
            resolve();
          });
          upstreamRes.on("error", (err) => {
            console.error(`[proxy] Response error: ${err.message}`);
            sendError(clientRes, 502, `Upstream error: ${err.message}`);
            resolve();
          });
        }
      },
    );

    req.on("error", (err) => {
      console.error(`[proxy] Request error: ${err.message}`);
      reject(err);
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// ============================================================
// 请求处理
// ============================================================

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // CORS 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  // 健康检查
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ status: "ok", target: TARGET_URL, proxy: "anyrouter-proxy/2.0" }),
    );
    return;
  }

  // 只代理 /v1/ 路径
  if (!req.url?.startsWith("/v1/")) {
    sendError(res, 404, `Not found: ${req.url}`);
    return;
  }

  const upstreamURL = `${TARGET_URL}${req.url}`;
  const isMessages = req.url.includes("/v1/messages");

  try {
    let body: string | undefined;
    let isStreaming = false;

    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const raw = await readBody(req);

      if (raw && isMessages) {
        const parsed = JSON.parse(raw) as RequestBody;
        const cleaned = cleanUndefined(parsed) as RequestBody;
        const transformed = transformRequestBody(cleaned);
        const injected = injectSystemPrompt(transformed);
        const withThinking = injectThinking(injected);

        isStreaming = !!withThinking.stream;
        body = JSON.stringify(withThinking);

        console.log(
          `[proxy] ${req.method} ${req.url} → transformed (stream=${isStreaming})`,
        );
      } else {
        body = raw;
      }
    }

    // 构建转发头 — 只转发认证相关
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };

    // 使用容器内置密钥，忽略客户端发来的密钥
    if (API_KEY) {
      headers["x-api-key"] = API_KEY;
      headers["authorization"] = `Bearer ${API_KEY}`;
    } else {
      // 没配置内置密钥时回退到转发客户端的密钥
      if (req.headers["x-api-key"]) {
        headers["x-api-key"] = String(req.headers["x-api-key"]);
      }
      if (req.headers["authorization"]) {
        headers["authorization"] = String(req.headers["authorization"]);
      }
    }

    await forwardRequest(
      req.method || "GET",
      upstreamURL,
      headers,
      body,
      res,
      isStreaming,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[proxy] Error: ${message}`);
    if (!res.headersSent) {
      sendError(res, 502, `Upstream error: ${message}`);
    }
  }
}

// ============================================================
// 启动服务
// ============================================================

const server = http.createServer(handleRequest);

process.on("SIGINT", () => {
  console.log("[proxy] 正在关闭...");
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("[proxy] 正在关闭...");
  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`[proxy] AnyRouter proxy v2.0 listening on :${PORT}`);
  console.log(`[proxy] Upstream: ${TARGET_URL}`);
  console.log(`[proxy] 伪装: Claude Code system prompt injection`);
  console.log(`[proxy] 零额外依赖，原生 HTTPS 转发`);
});
