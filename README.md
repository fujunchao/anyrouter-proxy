# AnyRouter Proxy

AnyRouter HTTP 反向代理 — 让 Cherry Studio 等 Anthropic API 客户端通过 [AnyRouter](https://anyrouter.top) 使用 Claude 模型。

## 工作原理

```
Cherry Studio / 任意客户端 → AnyRouter Proxy → AnyRouter → Claude API
```

AnyRouter 验证请求中的 `system` 字段是否为 Claude Code 的系统提示词（2 段固定内容）。本代理自动注入该提示词，使任意 Anthropic API 客户端都能通过 AnyRouter 访问 Claude。

## 核心功能

| 功能 | 说明 |
|------|------|
| **System Prompt 注入** | 自动注入 Claude Code 系统提示词，通过 AnyRouter 验证 |
| **客户端 System Prompt 保留** | 客户端自定义的 system prompt 会被移至第一条 user message，不会丢失 |
| **Thinking 自动注入** | Cherry Studio "默认"思考模式不发送 thinking 参数，代理自动为 Claude 模型注入思考能力 |
| **工具名 PascalCase 转换** | 兼容 OpenCode 的工具命名规范（如 `todowrite` → `TodoWrite`） |
| **内置工具保护** | Anthropic 服务端工具（web_search、computer 等）不做名称转换 |
| **`[undefined]` 深度清理** | Cherry Studio 会将 JS undefined 序列化为 `"[undefined]"`，代理递归清除 |
| **SSE 流式传输** | 完整支持 SSE 流式响应，流中工具名同步转换 |
| **API 密钥内置** | 可将密钥写入容器内，客户端使用任意密钥即可访问 |
| **CORS 支持** | 自动添加 CORS 头，支持浏览器端调用 |
| **健康检查** | `GET /health` 端点，Docker 自动健康检查 |

### Thinking 注入策略

当客户端未发送 `thinking` 字段时（Cherry Studio "默认"模式），代理会根据模型自动注入：

| 模型 | 注入内容 |
|------|----------|
| claude-opus-4-6 系列 | `thinking: { type: "adaptive" }` |
| claude-3.5-sonnet / claude-3.7-sonnet / claude-sonnet-4 等 | `thinking: { type: "enabled", budget_tokens: 10000 }` |
| 非 Claude 模型 | 不处理 |
| 客户端已发送 thinking 字段 | 不覆盖，尊重客户端设置 |

## 技术特点

- **零生产依赖** — 仅使用 Node.js 内置模块（`http`、`https`、`url`）
- **极小体积** — 构建产物约 13KB（单文件 `server.js`）
- **TypeScript** — 完整类型检查，零 `any` 逃逸
- **多阶段 Docker 构建** — 运行镜像仅包含 `node:20-alpine` + 单个 JS 文件

## 快速开始

### Docker Compose（推荐）

1. 创建 `.env` 文件：

```bash
cp .env.example .env
```

2. 编辑 `.env`，填入你的 AnyRouter API 密钥：

```env
TARGET_URL=https://anyrouter.top
PORT=5489
API_KEY=你的AnyRouter密钥
```

3. 启动：

```bash
docker compose up -d
```

代理将在 `http://localhost:5489` 启动。

### 手动运行

```bash
# 安装依赖
npm install

# 构建
npm run build

# 启动
API_KEY=你的密钥 npm start
```

## Cherry Studio 配置

1. 打开 Cherry Studio → 设置 → 模型服务
2. 添加一个 **Anthropic** 类型的服务商
3. 配置：
   - **API 地址**：`http://你的服务器IP:5489`（或反向代理域名）
   - **API 密钥**：任意值（代理会使用内置密钥）
4. 添加模型，如 `claude-sonnet-4-20250514`、`claude-opus-4-20250514` 等
5. 开始对话

> **提示**：思考模式选择"默认"即可，代理会自动注入 adaptive thinking。如需手动调节，在 Cherry Studio 中选择具体的思考等级。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TARGET_URL` | `https://anyrouter.top` | 上游 AnyRouter 地址 |
| `PORT` | `5489` | 代理监听端口 |
| `API_KEY` | （空） | AnyRouter API 密钥，设置后覆盖客户端密钥 |

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `POST` | `/v1/messages` | Anthropic Messages API 代理 |
| `*` | `/v1/*` | 其他 v1 路径透传 |

## 项目结构

```
anyrouter-proxy/
├── src/
│   ├── server.ts      # 主服务：请求处理、system prompt 注入、thinking 注入、HTTPS 转发
│   ├── transform.ts   # 转换逻辑：工具名映射、[undefined] 清理、SSE 转换
│   └── types.ts       # TypeScript 类型定义
├── Dockerfile          # 多阶段构建
├── docker-compose.yml  # Docker Compose 配置（端口 5489，1panel-network）
├── .env.example        # 环境变量模板
├── package.json        # 零生产依赖
└── tsconfig.json       # TypeScript 配置
```

## 请求处理流程

```
客户端请求
  ↓
1. 读取请求体
  ↓
2. 深度清理 "[undefined]"（Cherry Studio 兼容）
  ↓
3. 工具名转 PascalCase（跳过 Anthropic 内置工具）
  ↓
4. 注入 Claude Code system prompt（客户端 system → user message）
  ↓
5. 注入 thinking 参数（如果客户端未发送）
  ↓
6. 原生 HTTPS 转发至 AnyRouter
  ↓
7. 响应透传（SSE 流式 / JSON 非流式）+ 工具名反向转换
```

## 网络部署示例

使用 Caddy 反向代理：

```
example.com {
    reverse_proxy localhost:5489
}
```

## License

MIT
