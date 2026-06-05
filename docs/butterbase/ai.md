# Butterbase AI Model Gateway

Butterbase exposes an **OpenAI-compatible API** for chat completions, embeddings, and model listing through its AI gateway.

## Endpoints

### Gateway Mode (drop-in OpenAI SDK replacement)

No app context required. Authenticate with a platform API key.

| Detail | Value |
|---|---|
| **Base URL** | `https://api.butterbase.ai/v1` |
| **Auth** | `Authorization: Bearer <api_key>` (must have `ai:gateway` scope) |

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/chat/completions` | Chat completions |
| `POST` | `/v1/embeddings` | Embeddings |
| `GET` | `/v1/models` | List available models (auth required) |
| `GET` | `/v1/public/models` | Public model catalog with pricing (no auth) |

### App-Scoped Mode

Tied to a specific app — billed to app owner, inherits app AI config.

| Detail | Value |
|---|---|
| **Base URL** | `https://api.butterbase.ai/v1/{app_id}` |
| **Auth** | `Authorization: Bearer <api_key>` |

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/{app_id}/chat/completions` | Chat completions |
| `POST` | `/v1/{app_id}/embeddings` | Embeddings |
| `GET` | `/v1/{app_id}/ai/config` | Get AI config |
| `PUT` | `/v1/{app_id}/ai/config` | Update AI config |
| `GET` | `/v1/{app_id}/ai/usage` | Usage statistics |

## Streaming

Set `"stream": true` in the request body for server-sent events (OpenAI-compatible SSE format).

## Multimodal (VLM) Usage

Images are passed as `image_url` content parts in the OpenAI format:

```json
{
  "model": "google/gemini-3.5-flash",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe this image:"},
        {"type": "image_url", "image_url": {"url": "https://example.com/image.png"}}
      ]
    }
  ],
  "max_tokens": 500,
  "thinking": {"type": "disabled"}
}
```

**Requirements:**
- Image URLs must be publicly accessible (some CDNs like Wikipedia may block downloads — use alternative hosts if needed)
- `data:` URIs (base64-encoded images) are also supported
- Optional `detail` field: `"low"`, `"high"`, or `"auto"` for resolution control (when model supports it)

## Disabling Reasoning/Thinking

Some models (notably Gemini 3.5 Flash) return reasoning tokens by default. To suppress reasoning output, pass:

```json
"thinking": {"type": "disabled"}
```

## Verified Models

### Chat / Text

| Model ID | Status |
|---|---|
| `deepseek/deepseek-v4-flash` | ✅ Working |
| `google/gemini-3.5-flash` | ✅ Working |
| `openai/gpt-4o-mini` | ✅ Working |

### Vision / Multimodal (VLM)

| Model ID | Status | Notes |
|---|---|---|
| `google/gemini-3.5-flash` | ✅ Working | Use `thinking: {"type": "disabled"}` to suppress reasoning |
| `openai/gpt-4o-mini` | ✅ Working | May fail on certain CDN-blocked URLs |

### Embeddings

| Model ID | Dimensions |
|---|---|
| `openai/text-embedding-3-small` | 1536 |
| `openai/text-embedding-3-large` | 3072 |
| `openai/text-embedding-ada-002` | 1536 |

### Full model catalog

```bash
# Authenticated — list all models available to your account
curl https://api.butterbase.ai/v1/models \
  -H "Authorization: Bearer $API_KEY"

# Public — pricing and context window, no auth required
curl https://api.butterbase.ai/v1/public/models
```

## Authentication

- **Platform API key** (`bb_sk_...`) — create via dashboard or `generate_service_key` MCP tool
- API keys need the `ai:gateway` scope for gateway-mode endpoints
- App-scoped endpoints can use either a platform key or app-specific keys

## Usage Tracking

`GET /v1/{app_id}/ai/usage` returns token counts and credit spend aggregated over a date window.

## App Configuration

`PUT /v1/{app_id}/ai/config` accepts:

| Setting | Description |
|---|---|
| `defaultModel` | Model used when none is specified |
| `maxTokensPerRequest` | Max tokens per request (1–100,000) |
| `allowedModels` | Restrict which models can be used |

## Error Codes

| Status | Code | When |
|---|---|---|
| 401 | `missing_credentials` | No Authorization header |
| 401 | `invalid_api_key` | Token unknown, revoked, or expired |
| 403 | `insufficient_scope` | API key missing `ai:gateway` scope |
| 402 | `insufficient_credits` | Account balance too low |
| 404 | `model_not_found` | Requested model ID unavailable |
| 400 | `invalid_request` | Request body validation failed |
| 5xx | `api_error` | Temporary upstream issue (retry with backoff) |

Errors follow the OpenAI error shape: `{ error: { type, code, message } }`.

## Pricing

Pricing is per-model, per-million-tokens. Example costs (rounded):

| Model | Input / 1M tokens | Output / 1M tokens |
|---|---|---|
| `google/gemini-3.5-flash` | $1.80 | $10.80 |
| `deepseek/deepseek-v4-flash` | ~$0.15 | ~$1.40 |
| `openai/gpt-4o-mini` | varies | varies |

Check `GET /v1/public/models` for current pricing on all models.

## App-Scoped Example

```bash
curl -X POST https://api.butterbase.ai/v1/{app_id}/chat/completions \
  -H "Authorization: Bearer bb_sk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-3.5-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100,
    "thinking": {"type": "disabled"}
  }'
```

## OpenAI SDK Example

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://api.butterbase.ai/v1",
  apiKey: "bb_sk_...",
});

const response = await client.chat.completions.create({
  model: "google/gemini-3.5-flash",
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 100,
});
```
