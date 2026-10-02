/**
 * A parsed Anytype link. `invite` joins a shared space; `onetoone` is the 1:1
 * ("hi") link that BOTH sides resolve into the same one-to-one space.
 */
export type AnytypeLink =
  | { kind: "invite"; cid: string; key: string }
  | { kind: "onetoone"; identity: string; key: string };

function q(url: string): URLSearchParams | null {
  const i = url.indexOf("?");
  return i === -1 ? null : new URLSearchParams(url.slice(i + 1).replace(/#.*$/, ""));
}

/** Parse a 1:1 / invite link (deeplink or web form); null if unrecognized. */
export function parseAnytypeLink(raw: string): AnytypeLink | null {
  const s = (raw ?? "").trim();
  if (s.length === 0) return null;

  // anytype://hi/?id=..&key=..  or  anytype://invite/?cid=..&key=..
  if (s.startsWith("anytype://")) {
    const params = q(s);
    if (!params) return null;
    const key = params.get("key") ?? "";
    if (/^anytype:\/\/hi\//i.test(s)) {
      const id = params.get("id") ?? "";
      return id && key ? { kind: "onetoone", identity: id, key } : null;
    }
    if (/^anytype:\/\/invite\//i.test(s)) {
      const cid = params.get("cid") ?? "";
      return cid && key ? { kind: "invite", cid, key } : null;
    }
    return null;
  }

  // https://hi.any.coop/<identity>#<key>   or   https://<host>/<cid>#<key>
  const m = s.match(/^https?:\/\/([^/]+)\/([^#?/]+)#([^#?]+)/);
  if (!m) return null;
  const [, host, a, key] = m;
  if (!a || !key) return null;
  return host.toLowerCase() === "hi.any.coop"
    ? { kind: "onetoone", identity: a, key }
    : { kind: "invite", cid: a, key };
}
