# Agentic AI Hub

An integrated TypeScript reference project that combines four powerful open-source technologies for building AI agents.

| Technology | What it provides | SDK |
|---|---|---|
| **[RocketRide](https://github.com/rocketride-org/rocketride-server)** | High-performance AI pipeline engine (C++ core, 50+ nodes, 13 LLM providers, 8 vector DBs) | `rocketride` |
| **[Spectrum](https://github.com/photon-hq/spectrum-ts)** | Unified messaging SDK — write agent logic once, deliver on iMessage, WhatsApp, terminal | `spectrum-ts` |
| **[XTrace Memory](https://github.com/XTraceAI/memory-sdk-ts)** | Long-term memory for AI agents — ingest conversations, search structured facts | `@xtraceai/memory` |
| **[Butterbase](https://github.com/butterbase-ai/butterbase)** | Open-source BaaS — Postgres, auth, storage, functions, AI gateway, MCP | `@butterbase/sdk` |

## Architecture

```
          ┌────────────────────────────────────────────┐
          │          Agent Orchestrator                │
          │  ┌──────────┐ ┌─────────┐ ┌────────────┐  │
User ─────┼─▶│ Spectrum │─│RocketRide│─│ XTrace     │──┼──▶ Reply
          │  │ Messaging│ │Pipeline │ │ Memory     │  │
          │  └──────────┘ └─────────┘ └────────────┘  │
          │               ┌────────────┐              │
          │               │ Butterbase │              │
          │               │ (State DB) │              │
          │               └────────────┘              │
          └────────────────────────────────────────────┘
```

### Flow

1. **Receive** — Spectrum listens on configured messaging platforms (iMessage, terminal, etc.)
2. **Recall** — XTrace retrieves relevant long-term memories for context enrichment
3. **Process** — RocketRide runs the AI pipeline with enriched context
4. **Store** — New memories are ingested into XTrace; state is persisted on Butterbase
5. **Reply** — Spectrum sends the pipeline output back through the original messaging channel

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) >= 1.3
- Docker (for self-hosting RocketRide and/or Butterbase)

### Setup

```bash
# 1. Install dependencies
bun install

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys and project IDs

# 3. Run
bun run src/index.ts
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ROCKETRIDE_API_URL` | No | `http://localhost:5565` | RocketRide server address |
| `ROCKETRIDE_API_KEY` | No | — | RocketRide auth key |
| `SPECTRUM_PROJECT_ID` | **Yes** | — | Spectrum Cloud project ID |
| `SPECTRUM_PROJECT_SECRET` | **Yes** | — | Spectrum Cloud project secret |
| `XTRACE_API_KEY` | **Yes** | — | XTrace API key (`xtk_...`) |
| `XTRACE_ORG_ID` | **Yes** | — | XTrace org ID (`org_...`) |
| `BUTTERBASE_API_URL` | No | `http://localhost:4000` | Butterbase server address |
| `BUTTERBASE_API_KEY` | No | — | Butterbase API key |

## Project Structure

```
src/
├── index.ts                    # Entry point
├── config/
│   └── env.ts                  # Validated environment config
├── types/
│   └── index.ts                # Shared types (Message, PipelineResult, etc.)
├── pipelines/
│   └── ai-pipeline.ts          # RocketRide client
├── messaging/
│   └── spectrum.ts             # Spectrum messaging service
├── memory/
│   └── xtrace-memory.ts        # XTrace memory client
├── backend/
│   └── butterbase.ts           # Butterbase client
└── agents/
    └── orchestrator.ts         # Agent loop combining all services
```

## Self-Hosting the Services

### RocketRide Server

```bash
docker pull ghcr.io/rocketride-org/rocketride-engine:latest
docker run -d --name rocketride -p 5565:5565 ghcr.io/rocketride-org/rocketride-engine:latest
```

Or install the VS Code extension and choose "Local" deployment.

### Butterbase

```bash
git clone --recurse-submodules https://github.com/butterbase-ai/butterbase.git
cd butterbase
docker compose -f docker-compose.local.yml up -d
# Apply migrations and create an app (see butterbase SETUP.md)
```

### XTrace

Create a free account at [app.xtrace.ai](https://app.xtrace.ai) — no self-hosting required.

### Spectrum

Sign up at [app.photon.codes](https://app.photon.codes) for hosted infrastructure, or self-host with a local iMessage database.

## License

MIT
