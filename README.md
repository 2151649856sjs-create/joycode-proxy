# joycode-proxy

把 **JoyCode（京东云 JoyCoder 积分）** 反代成一个 OpenAI 兼容的 HTTP 服务，再通过一个 DSH provider 插件把它的积分池接进 DSH，当作 agent 的模型后端。整体思路与 `qoder-proxy` / `dsh-llm-qoder` 完全一致，只是后端换成了 JoyCode 的「color gateway」协议。

## 架构

```
DSH agent
  └─ ctx.llm.registerAdapter(["joycode"], adapter)   ← dsh-llm-joycode 插件
       └─ PiAiAdapter → openAICompletionsApi(baseUrl=本地 shim)
            └─ POST http://127.0.0.1:8318/v1/chat/completions
                 └─ joycode-proxy (server.mjs)
                      └─ POST https://api-ai.jd.com/api?appid=joycode_ide&functionId=chat_completions&t=...&sign=...
                           (HMAC-SHA256 签名 + ptKey 头)
                           └─ JoyCode 后端（同一账号的积分计费）
```

## 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/v1/models` | 返回 JoyCode 后端模型列表 |
| POST | `/v1/chat/completions` | OpenAI 兼容，支持 `stream: true/false` |
| GET  | `/health` | 探活 + 配置自检 |

## 为什么用「color gateway」而不是逆向

JoyCode IDE 的请求签名与鉴权都在它自带的 `extension.js` 里明文实现，核心只有三样东西：

1. **网关地址**：`https://api-ai.jd.com/api`（登录态里的 `colorBaseUrl`）。
2. **鉴权头**：`ptKey`（登录态里的 `ptKey`，即京东云账号票据）+ 可选 `loginType`/`tenant`。
3. **签名**：对 `{appid, functionId, t}` 排序后取非空值 `&` 拼接，用 HMAC-SHA256 + IDE 内置签名密钥算 hex，作为 `sign` 查询参数。

因此不需要逆向任何加密/WASM，直接把这段签名逻辑复刻成 `server.mjs` 里的 `signQuery()` / `gatewayUrl()` 即可。

> **关于那个签名密钥**：它是 IDE 客户端内置的**公开协议常量**，随 IDE 分发给每个用户，不是账号凭据——单独拿到它无法发起任何有效请求。真正的凭据是 `ptKey`，**只从环境变量读、永不入库**。若上游轮换密钥，重新从 `extension.js` 提取，或用 `JOYCODE_SIGN_KEY` 覆盖。

## 配置（环境变量）

| 变量 | 必需 | 默认 | 说明 |
|------|------|------|------|
| `JOYCODE_PT_KEY` | ✅ | 空 | 账号票据（登录态 `jdhLoginInfo.ptKey`） |
| `JOYCODE_TENANT` | ⭕ | 空 | 租户 ID（登录态 `tenant`） |
| `JOYCODE_COLOR_BASE_URL` | ⭕ | `https://api-ai.jd.com` | 网关 origin（登录态 `colorBaseUrl`） |
| `JOYCODE_MASTER_BASE_URL` | ⭕ | 空 | 直连 origin（登录态 `masterBaseUrl`），网关不可用时兜底 |
| `JOYCODE_LOGIN_TYPE` | ⭕ | `PIN_JD_CLOUD` | 登录类型 |
| `JOYCODE_SIGN_KEY` | ⭕ | 内置常量 | 覆盖签名密钥（上游轮换时用） |
| `JOYCODE_PROXY_PORT` | ⭕ | `8318` | 本地监听端口 |
| `JOYCODE_PROXY_HOST` | ⭕ | `127.0.0.1` | 监听地址 |
| `JOYCODE_PROXY_MODEL` | ⭕ | `JoyAI-Code-1.6` | 缺省模型 |
| `JOYCODE_PROXY_API_KEY` | ⭕ | 空 | 设置后要求 `Authorization: Bearer <key>` |

> **怎么拿到自己的凭据**：JoyCode IDE 的登录态存在一个 SQLite 库里
> （Windows `%APPDATA%\JoyCode\User\globalStorage\state.vscdb`；
> macOS `~/Library/Application Support/JoyCode/User/globalStorage/state.vscdb`；
> Linux `~/.config/JoyCode/User/globalStorage/state.vscdb`）。
> 读 `ItemTable` 表里 key 为 `JoyCoder.IDE` 的那一行，其 JSON 的
> `jdhLoginInfo` 里就有 `ptKey` / `colorBaseUrl` / `masterBaseUrl` / `tenant`。
> 把这些填进 `.env`（见 `.env.example`）。**`.env` 已在 `.gitignore` 里，绝不要提交。**

## 模型列表（后端实时返回）

- `JoyAI-Code-1.6`
- `GLM-5.3-agent`（GLM-5.3）
- `Kimi-K2.6-agent`（Kimi-K2.6，多模态）
- `MiniMax-M3-agent`（MiniMax-M3，多模态）
- `Doubao-Seed-2.0-pro-agent`（Doubao-Seed-2.0-pro，多模态）

## 启动

```powershell
$env:JOYCODE_PT_KEY = "<ptKey>"
node server.mjs
```

验证：

```powershell
curl.exe -s http://127.0.0.1:8318/v1/models
curl.exe -s http://127.0.0.1:8318/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d '{\"model\":\"JoyAI-Code-1.6\",\"messages\":[{\"role\":\"user\",\"content\":\"reply exactly PONG\"}]}'
```

## 接 DSH

1. 把 `dsh-plugin` 用 junction 挂到 web profile：`profiles\web\node_modules\dsh-llm-joycode` → 本目录 `dsh-plugin`。
2. 在 `profiles\web\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: llm-joycode
      name: dsh-llm-joycode
```

3. 重启 DSH web，模型选择器里应出现 `joycode` provider（5 个模型）。

## 快速开始

```bash
git clone <this-repo> && cd joycode-proxy
cp .env.example .env      # 然后填入你自己的 ptKey / tenant
npm start
```

验证：

```bash
curl -s http://127.0.0.1:8318/v1/models
curl -s http://127.0.0.1:8318/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"JoyAI-Code-1.6","messages":[{"role":"user","content":"reply exactly PONG"}]}'
```

> 零运行时依赖：只用 Node 内置的 `node:http` / `node:crypto`，`npm install` 不是必需的。

## 接 DSH

1. 把 `dsh-plugin/` 挂进你的 DSH profile（例如用 junction / symlink 放到
   `<DSH_HOME>/profiles/web/node_modules/dsh-llm-joycode`，或直接 `dsh plugin add` 该目录）。
2. 在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: llm-joycode
      name: dsh-llm-joycode
```

3. 重启 DSH，模型选择器里应出现 `joycode` provider（5 个模型）。

## 已知限制

- **无状态**：把 OpenAI messages 拍平成单个 prompt，不保留跨请求会话（和 qoder-proxy 一致）。
- **不支持 function calling / tools**：JoyCode 网关的 chat completions 走纯文本路径。
- **单账号串行**：凭据来自一个登录态，多并发请求共享同一账号的积分。
- **签名密钥可能轮换**：密钥是 IDE 内置常量，上游更换后需重新提取，或用 `JOYCODE_SIGN_KEY` 覆盖。

## 免责声明

本项目仅用于在你自己的账号下、于本机把已有的 JoyCode 积分接到其它客户端，
便于个人开发使用。请自行确认你的用法符合服务商条款。作者不对账号封禁、
额度损失或任何间接损害负责。

## License

MIT
