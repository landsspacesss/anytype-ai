import readline from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2],
       maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "prompt") {
    send({ id: msg.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
    send({ type: "agent_start" });
    const text = `echo: ${msg.message}`;
    for (const ch of text) {
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ch } });
    }
    send({ type: "agent_end", isTerminal: true });
  } else if (msg.type === "abort") {
    send({ id: msg.id, type: "response", command: "abort", success: true });
    send({ type: "agent_end", isTerminal: true });
  }
});
rl.on("close", () => process.exit(0));
