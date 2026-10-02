import fs from "node:fs";
import path from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ManagedClient } from "../session/manager.js";

export interface PiClientOptions {
  /** Working directory for the agent (its project-local context lives here). */
  cwd: string;
  /** Global pi config dir. Defaults to pi's own `~/.pi/agent`. */
  agentDir?: string;
}

/**
 * Build a ManagedClient backed by an in-process pi SDK AgentSession.
 *
 * Replaces the old omp subprocess: no RPC framing, no `ready` handshake, and
 * no child process to supervise. `session.prompt()` resolves when the turn
 * completes, at which point `collected` holds the assistant's reply text that
 * we accumulated from `text_delta` streaming events.
 */
export async function createPiClient(opts: PiClientOptions): Promise<ManagedClient> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });

  let collected = "";
  const unsubscribe = session.subscribe((e) => {
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      collected += e.assistantMessageEvent.delta;
    }
  });

  return {
    get busy(): boolean {
      return session.isStreaming;
    },
    async prompt(m: string): Promise<string> {
      collected = "";
      await session.prompt(m);
      return collected;
    },
    async close(): Promise<void> {
      unsubscribe();
      session.dispose();
    },
    async abort(): Promise<void> {
      await session.abort();
    },
  };
}

/**
 * Per-space manual memory: ensure the workspace has an AGENTS.md that tells the
 * agent to read/write a durable MEMORY.md. pi auto-loads AGENTS.md context
 * files found in (and above) `cwd`, so this is picked up on session creation.
 * Existing AGENTS.md is never clobbered.
 */
export function ensureAgentFiles(workspaceDir: string): void {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const agentsMd = path.join(workspaceDir, "AGENTS.md");
  if (fs.existsSync(agentsMd)) return;
  const body = [
    "# Memory",
    "This directory contains a MEMORY.md with durable notes about this workspace.",
    "Read it for context at the start of a conversation.",
    "When the user asks you to remember something, append a concise note to MEMORY.md",
    "(create the file if missing) and confirm what you stored.",
    "",
  ].join("\n");
  fs.writeFileSync(agentsMd, body, "utf-8");
}
