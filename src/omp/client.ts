import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { OmpFrame } from "./protocol.js";

export interface SpawnOptions {
  bin: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class OmpClient {
  private child: ChildProcessWithoutNullStreams;
  private rl: Interface;
  private nextId = 1;
  private inFlight = false;
  private sawDelta = false;
  private text = "";
  private resolvePrompt?: (v: string) => void;
  private rejectPrompt?: (e: Error) => void;
  private onExit?: () => void;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.rl = createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.onLine(line));
    child.on("exit", () => {
      if (this.rejectPrompt) this.rejectPrompt(new Error("omp exited during prompt"));
      this.onExit?.();
    });
  }

  static spawn(opts: SpawnOptions): Promise<OmpClient> {
    const args = opts.args ?? ["--mode", "rpc"];
    const child = spawn(opts.bin, args, { cwd: opts.cwd, env: opts.env }) as ChildProcessWithoutNullStreams;
    const client = new OmpClient(child);
    return client.waitReady().then(() => client);
  }

  private waitReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onFrame = (line: string) => {
        try {
          const frame = JSON.parse(line) as OmpFrame;
          if (frame.type === "ready") {
            this.rl.off("line", onFrame);
            resolve();
          }
        } catch { /* ignore non-JSON */ }
      };
      this.rl.on("line", onFrame);
      setTimeout(() => reject(new Error("omp ready timeout")), 15000).unref?.();
    });
  }

  private onLine(line: string): void {
    let frame: OmpFrame;
    try { frame = JSON.parse(line) as OmpFrame; } catch { return; }
    if (frame.type === "message_update") {
      const ev = (frame as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
      if (ev?.type === "text_delta" && typeof ev.delta === "string") {
        this.sawDelta = true;
        this.text += ev.delta;
      }
    } else if (frame.type === "agent_end") {
      const terminal = (frame as { isTerminal?: boolean }).isTerminal !== false;
      if (terminal && this.resolvePrompt) {
        const resolve = this.resolvePrompt;
        this.resolvePrompt = undefined;
        this.rejectPrompt = undefined;
        this.inFlight = false;
        const out = this.sawDelta ? this.text : "";
        this.text = "";
        this.sawDelta = false;
        resolve(out);
      }
    }
  }

  get busy(): boolean { return this.inFlight; }

  prompt(message: string): Promise<string> {
    if (this.inFlight) return Promise.reject(new Error("session_busy"));
    this.inFlight = true;
    this.sawDelta = false;
    this.text = "";
    return new Promise<string>((resolve, reject) => {
      this.resolvePrompt = resolve;
      this.rejectPrompt = reject;
      // omp RPC: the command NAME goes in the `type` field (verified against real
      // omp 18.4.9 — `{id, command:"prompt"}` returns "Unknown command: undefined").
      this.write({ id: this.nextId++, type: "prompt", message });
    });
  }

  async abort(): Promise<void> {
    if (!this.inFlight) return;
    this.write({ id: this.nextId++, type: "abort" });
  }

  private write(obj: unknown): void {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      this.onExit = resolve;
      this.child.once("exit", () => resolve());
      setTimeout(() => { try { this.child.kill("SIGKILL"); } catch {} resolve(); }, 3000).unref?.();
    });
  }
}
