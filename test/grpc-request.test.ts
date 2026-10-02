import { describe, it, expect } from "vitest";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { oneToOneWorkspaceCreateRequest } from "../src/anytype/grpc.js";

describe("oneToOneWorkspaceCreateRequest", () => {
  const def = protoLoader.loadSync(path.resolve("proto/anytype.proto"), {
    keepCase: false, longs: String, enums: Number, defaults: true, oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as any;
  // In this grpc-js/proto-loader version `loadPackageDefinition` returns a
  // MessageTypeDefinition exposing `serialize`/`deserialize` (it does NOT expose
  // the protobufjs `create`/`encode`/`decode` helpers). Verify with the available API.
  const Req = pkg.anytype.WorkspaceCreateRequest;

  it("populates the Struct details (not an empty default space)", () => {
    const req = oneToOneWorkspaceCreateRequest("ID1", "KEY1");
    const buf: Buffer = Req.serialize(req);
    const back: any = Req.deserialize(buf);
    expect(back.useCase).toBe(1);
    expect(back.details.fields.oneToOneIdentity.stringValue).toBe("ID1");
    expect(back.details.fields.oneToOneRequestMetadataKey.stringValue).toBe("KEY1");
    expect(back.details.fields.spaceType.numberValue).toBe(4);
    expect(back.details.fields.spaceAccessType.numberValue).toBe(2);
    expect(buf.length).toBeGreaterThan(100);
  });
});
