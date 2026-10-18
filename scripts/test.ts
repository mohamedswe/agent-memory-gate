// Canonical test launcher: defaults GBRAIN_PACKAGE_DIR to the user's global bun
// install (no hardcoded home), so `bun run test` works bare on this machine.
// An exported GBRAIN_PACKAGE_DIR always wins.
import { join } from "node:path";

const profileDir = process.env.USERPROFILE || process.env.HOME;
const defaultDir = join(profileDir, ".bun", "install", "global", "node_modules", "gbrain");
process.env.GBRAIN_PACKAGE_DIR ||= defaultDir;

const suites = ["test/records.test.ts", "test/schema.test.ts", "test/record-boundary.test.ts", "test/usage-ledger.test.ts", "test/ledger-min-content.test.ts", "test/ledger-args-serialization.test.ts", "test/rollout-reader.test.ts", "test/redaction-gate.test.ts", "test/reviewer-output.test.ts", "test/candidate-writer.test.ts", "test/budget-ledger.test.ts", "test/reviewer-client.test.ts", "test/project-registry.test.ts", "test/reviewer-prompt-v2.test.ts", "test/reviewer-reasoning-fallback.test.ts", "test/condense-cluster.test.ts", "test/capture-cursor.test.ts", "test/session-capture.test.ts", "test/session-trajectory.test.ts", "test/satisfaction-classifier.test.ts", "test/satisfaction-arcs.test.ts", "test/hermes-adapter.test.ts", "test/satisfaction-transitions.test.ts", "test/marker-records.test.ts", "test/history-renderer.test.ts", "test/hermes-attribution.test.ts", "test/cross-session-ledger.test.ts", "test/env-feedback.test.ts"];
const proc = Bun.spawn(["bun", "test", ...suites], {
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
await proc.exited;
process.exit(proc.exitCode);