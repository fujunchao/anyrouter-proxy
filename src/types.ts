/**
 * AnyRouter Proxy — 类型定义
 */

export type ToolNameMap = Record<string, string>;

export interface ToolDefinition {
  name?: string;
  [key: string]: unknown;
}

export interface ContentBlock {
  type?: string;
  name?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Message {
  content?: ContentBlock[] | string;
  [key: string]: unknown;
}

export interface RequestBody {
  tools?: ToolDefinition[];
  messages?: Message[];
  [key: string]: unknown;
}

export interface ResponseBody {
  content?: ContentBlock[];
  [key: string]: unknown;
}

export interface SSEData {
  type?: string;
  content_block?: {
    type?: string;
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
