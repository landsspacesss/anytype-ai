import fs from "node:fs";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

export interface HeartGrpcOptions {
  /** anytype-heart gRPC address. Default 127.0.0.1:31010. */
  addr?: string;
  /** anytype-cli config.json holding the session token. */
  configPath?: string;
  /** Path to proto/anytype.proto. */
  protoPath?: string;
}

/** Read `sessionToken` from an anytype-cli config.json; null when absent/unreadable. */
export function readSessionToken(configPath: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { sessionToken?: unknown };
    return typeof raw.sessionToken === "string" && raw.sessionToken.length > 0 ? raw.sessionToken : null;
  } catch {
    return null;
  }
}

const DEFAULT_ADDR = "127.0.0.1:31010";
const DEFAULT_CONFIG = "/root/.anytype/config.json";

/**
 * Minimal client for anytype-heart's local gRPC (ClientCommands). Plaintext
 * h2c + a `token` metadata header. The token is re-read on demand, so a
 * restarted anytype-cli (which mints a new session token) is picked up.
 *
 * Only call methods that are real handlers — some RPCs are removed stubs that
 * PANIC the CLI process (e.g. WorkspaceGetAll).
 */
export class HeartGrpc {
  private readonly addr: string;
  private readonly configPath: string;
  private readonly protoPath: string;
  private pkg?: Record<string, any>;
  private client?: grpc.Client;

  constructor(opts: HeartGrpcOptions = {}) {
    this.addr = opts.addr ?? process.env.GRPC_ADDR ?? DEFAULT_ADDR;
    this.configPath = opts.configPath ?? process.env.ANYTYPE_CLI_CONFIG ?? DEFAULT_CONFIG;
    this.protoPath = opts.protoPath ?? process.env.ANYTYPE_PROTO ?? path.resolve(process.cwd(), "proto/anytype.proto");
  }

  private load(): Record<string, any> {
    if (this.pkg) return this.pkg;
    const def = protoLoader.loadSync(this.protoPath, {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
      oneofs: true,
    });
    const desc = grpc.loadPackageDefinition(def) as any;
    const pkg = desc.anytype;
    this.pkg = pkg;
    return pkg;
  }

  private getClient(): grpc.Client {
    const cached = this.client;
    if (cached) return cached;
    const pkg = this.load();
    const client = new pkg.ClientCommands(this.addr, grpc.credentials.createInsecure()) as grpc.Client;
    this.client = client;
    return client;
  }

  private metadata(): grpc.Metadata {
    const token = readSessionToken(this.configPath);
    const md = new grpc.Metadata();
    if (token) md.set("token", token);
    return md;
  }

  private call(method: string, request: unknown): Promise<any> {
    const client = this.getClient() as any;
    return new Promise((resolve, reject) => {
      client[method](request, this.metadata(), { deadline: Date.now() + 15000 }, (err: any, res: any) => {
        if (err) reject(err);
        else resolve(res ?? {});
      });
    });
  }

  private errText(res: any): string | null {
    const e = res?.error;
    if (!e) return null;
    const code = e.code ?? "?";
    const desc = e.description ?? "";
    return code === 0 || code === "0" ? null : `code ${code}: ${desc}`;
  }

  async appGetVersion(): Promise<string> {
    const res = await this.call("AppGetVersion", {});
    const e = this.errText(res);
    if (e) throw new Error(e);
    return String(res.version ?? "");
  }

  /** Mirror a one-to-one space from (identity, key). Returns the new space id. */
  async workspaceCreateOneToOne(identity: string, key: string): Promise<string> {
    const res = await this.call("WorkspaceCreate", {
      details: { oneToOneIdentity: identity, oneToOneRequestMetadataKey: key, spaceType: 4, spaceAccessType: 2 },
      useCase: 1,
    });
    const e = this.errText(res);
    if (e) throw new Error(e);
    if (!res.spaceId) throw new Error("WorkspaceCreate returned no spaceId");
    return String(res.spaceId);
  }

  /** Join a shared space from an invite link's cid/key. */
  async spaceJoin(args: { cid: string; key: string; networkId?: string }): Promise<void> {
    const res = await this.call("SpaceJoin", {
      inviteCid: args.cid,
      inviteFileKey: args.key,
      ...(args.networkId ? { networkId: args.networkId } : {}),
    });
    const e = this.errText(res);
    if (e) throw new Error(e);
  }
}
