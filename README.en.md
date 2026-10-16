# joycode-proxy

Turn your **JoyCode (JD Cloud JoyCoder) credits** into an OpenAI-compatible HTTP service,
then wire those credits into DSH as a model backend via a DSH provider plugin.

The design is identical to `qoder-proxy` / `dsh-llm-qoder`, but the backend is JoyCode's
"color gateway" protocol instead.

> **English version.** 中文文档见 [`README.md`](./README.md).

## Architecture

```
DSH agent
  └─ ctx.llm.registerAdapter(["joycode"], adapter)   ← dsh-llm-joycode plugin
       └─ PiAiAdapter → openAICompletionsApi(baseUrl=local shim)
            └─ POST http://127.0.0.1:8318/v1/chat/completions
                 └─ joycode-proxy (server.mjs)
                      └─ POST https://api-ai.jd.com/api?appid=joycode_ide&functionId=chat_completions&t=...&sign=...
                           (HMAC-SHA256 signature + ptKey header)
                           └─ JoyCode backend (billed against THE SAME account)
```

## How it works (and why no reverse-engineering)

JoyCode IDE's request signing and auth are implemented in plaintext inside its own
`extension.js`. There are only three pieces:

1. **Gateway URL**: `https://api-ai.jd.com/api` (the `colorBaseUrl` from your login state).
2. **Auth header**: `ptKey` (your JD Cloud account ticket, from login state) + optional
   `loginType` / `tenant`.
3. **Signature**: sort `{appid, functionId, t}`, concatenate non-empty values with `&`,
   HMAC-SHA256 with the IDE's built-in signing key, hex-encode as the `sign` query param.

So there is no encryption/WASM to reverse — `server.mjs` just reimplements
`signQuery()` / `gatewayUrl()`.

> **About that signing key**: it is an **open protocol constant** shipped inside the IDE
> to every user — not an account credential. Possessing it alone cannot issue any valid
> request. The real credential is `ptKey`, which is **only ever read from an env var and
> never committed**. If upstream rotates the key, re-extract it from `extension.js` or
> override with `JOYCODE_SIGN_KEY`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/v1/models` | List JoyCode backend models |
| POST | `/v1/chat/completions` | OpenAI-compatible, supports `stream: true/false` |
| GET  | `/health` | Liveness + self-check |

## Configuration (environment variables)

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `JOYCODE_PT_KEY` | yes | empty | Account ticket (`jdhLoginInfo.ptKey` from login state) |
| `JOYCODE_TENANT` | no | empty | Tenant ID (`tenant` from login state) |
| `JOYCODE_COLOR_BASE_URL` | no | `https://api-ai.jd.com` | Gateway origin (`colorBaseUrl`) |
| `JOYCODE_MASTER_BASE_URL` | no | empty | Direct origin (`masterBaseUrl`), fallback when gateway fails |
| `JOYCODE_LOGIN_TYPE` | no | `PIN_JD_CLOUD` | Login type |
| `JOYCODE_SIGN_KEY` | no | built-in constant | Override signing key (use on upstream rotation) |
| `JOYCODE_PROXY_PORT` | no | `8318` | Local listen port |
| `JOYCODE_PROXY_HOST` | no | `127.0.0.1` | Listen address |
| `JOYCODE_PROXY_MODEL` | no | `JoyAI-Code-1.6` | Default model |
| `JOYCODE_PROXY_API_KEY` | no | empty | When set, requires `Authorization: Bearer <key>` |

### Getting your own credentials

JoyCode IDE stores login state in a SQLite database:

- Windows: `%APPDATA%\JoyCode\User\globalStorage\state.vscdb`
- macOS: `~/Library/Application Support/JoyCode/User/globalStorage/state.vscdb`
- Linux: `~/.config/JoyCode/User/globalStorage/state.vscdb`

Read the row whose key is `JoyCoder.IDE` in the `ItemTable` table. Its JSON's
`joyCoderUser` contains `ptKey` / `colorBaseUrl` / `masterBaseUrl` / `tenant`.
Put them into `.env` (see `.env.example`). **`.env` is gitignored — never commit it.**

Don't want to dig manually? Run `npm run setup` — it reads your local IDE login state
and writes the credentials into `.env` automatically.

## Models (returned live by the backend)

- `JoyAI-Code-1.6`
- `GLM-5.3-agent` (GLM-5.3)
- `Kimi-K2.6-agent` (Kimi-K2.6, multimodal)
- `MiniMax-M3-agent` (MiniMax-M3, multimodal)
- `Doubao-Seed-2.0-pro-agent` (Doubao-Seed-2.0-pro, multimodal)

## Quick start

```bash
git clone <this-repo> && cd joycode-proxy
npm run setup             # auto-read ptKey/tenant from your local JoyCode IDE login state into .env
npm start
```

No JoyCode IDE installed? Manual works too:

```bash
cp .env.example .env      # then fill in your own ptKey / tenant
npm start
```

> **Zero runtime dependencies**: only Node's built-in `node:http` / `node:crypto`.
> `npm install` is not required.

Verify:

```bash
curl -s http://127.0.0.1:8318/v1/models
curl -s http://127.0.0.1:8318/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"JoyAI-Code-1.6","messages":[{"role":"user","content":"reply exactly PONG"}]}'
```

## Wiring into DSH

`dsh-plugin/` is a DSH model provider plugin that registers the endpoint above as a DSH provider.

One command (creates the junction + appends the patch entry, idempotent):

```bash
npm run install:dsh          # equivalent to node install-dsh-plugin.mjs
# optional: specify profile / DSH_HOME
DSH_PROFILE=web DSH_HOME=/path/to/.dsh node install-dsh-plugin.mjs
```

Manual:

1. Mount `dsh-plugin/` into your DSH profile (e.g. junction/symlink to
   `<DSH_HOME>/profiles/web/node_modules/dsh-llm-joycode`, or `dsh plugin add` the dir).
2. Append to the end of `<DSH_HOME>/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: llm-joycode
         name: dsh-llm-joycode
   ```

3. Restart DSH. The model picker should now show the `joycode` provider (5 models).

After that:

- provider id: `joycode`, display name `JoyCode`
- 5 models appear in the model picker
- change provider settings (baseUrl / display name / on-off) via the `Config` defaults in
  `dsh-plugin/index.js`, or override in the DSH settings UI

**Note**: the proxy must be running on port 8318 first; otherwise the model list shows up
but requests 502.

## Known limitations

- **Stateless**: OpenAI messages are flattened into a single prompt; no cross-request
  session (same as qoder-proxy).
- **No function calling / tools**: JoyCode gateway chat completions take a plain-text path.
- **Single-account, serial credits**: credentials come from one login state; concurrent
  requests share the same account's credits.
- **Signing key may rotate**: the key is an IDE built-in constant; re-extract on upstream
  change, or override with `JOYCODE_SIGN_KEY`.

## Disclaimer

This project is intended only for using your **own** JoyCode credits, on your own machine,
to connect to other clients for personal development. Confirm your usage complies with the
service provider's terms. The author is not responsible for account bans, quota loss, or any
indirect damages.

## License

MIT
