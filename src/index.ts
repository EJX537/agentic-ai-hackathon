/**
 * Agentic AI Hub — Main Entry Point
 *
 * This is a reference implementation showing how to integrate:
 *   - RocketRide  (AI pipeline engine)
 *   - Spectrum    (unified messaging)
 *   - XTrace      (long-term memory for agents)
 *   - Butterbase  (backend-as-a-service: Postgres, auth, storage, functions)
 *
 * Usage:
 *   export $(grep -v '^#' .env | xargs)
 *   bun run src/index.ts
 */
import { AgentOrchestrator } from "./agents/orchestrator.ts";

// ── Safety: refuse to start without a configured .env ──────────────────
function checkEnv() {
  const required = [
    "SPECTRUM_PROJECT_ID",
    "SPECTRUM_PROJECT_SECRET",
    "XTRACE_API_KEY",
    "XTRACE_ORG_ID",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(
      `❌ Missing required env vars: ${missing.join(", ")}\n` +
        `   Copy .env.example → .env and fill in your values.`,
    );
    process.exit(1);
  }
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  checkEnv();

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║          Agentic AI Hub — Online                     ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  🚀 RocketRide  — AI pipeline engine                ║");
  console.log("║  💬 Spectrum    — Unified messaging                  ║");
  console.log("║  🧠 XTrace      — Long-term memory for agents       ║");
  console.log("║  🗄️  Butterbase  — Backend-as-a-service              ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("");

  const orchestrator = new AgentOrchestrator({
    pipelineId: process.env["ROCKETRIDE_PIPELINE_ID"] ?? "default-agent",
    defaultUserId: "agentic-hub-user",
    memoryGroupIds: process.env["XTRACE_GROUP_IDS"]?.split(","),
    butterbaseAppId: process.env["BUTTERBASE_APP_ID"],
  });

  // Graceful shutdown on SIGINT/SIGTERM
  process.on("SIGINT", async () => {
    console.log("\n[Main] Shutting down...");
    await orchestrator.shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    console.log("\n[Main] Shutting down...");
    await orchestrator.shutdown();
    process.exit(0);
  });

  await orchestrator.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
