import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { OmpClient } from "../src/omp/client.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));

describe("OmpClient", () => {
  it("spawns, prompts, and returns the full reply", async () => {
    const client = await OmpClient.spawn({ bin: "node", args: [FAKE], cwd: process.cwd() });
    const reply = await client.prompt("hello");
    expect(reply).toBe("echo: hello");
    await client.close();
  });

  it("reports busy while a prompt is in flight", async () => {
    const client = await OmpClient.spawn({ bin: "node", args: [FAKE], cwd: process.cwd() });
    const p = client.prompt("hi");
    expect(client.busy).toBe(true);
    await p;
    expect(client.busy).toBe(false);
    await client.close();
  });

  it("aborts an in-flight prompt", async () => {
    const client = await OmpClient.spawn({ bin: "node", args: [FAKE], cwd: process.cwd() });
    const p = client.prompt("hi");
    await client.abort();
    await expect(p).resolves.toBeTypeOf("string");
    await client.close();
  });
});
