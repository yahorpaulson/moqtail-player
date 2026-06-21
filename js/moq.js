// ── MOQ draft-16 wire format ───────────────────────────────────────────────
// Version: 0xff000010 (draft-16 = 0xff000000 + 16 = 0xff000010)
// Message frame: Type(varint) + Length(16-bit big-endian) + Payload

//values are defined in relay libs control constant.rs

export const MSG_CLIENT_SETUP = 0x20;
export const MSG_SERVER_SETUP = 0x21;
export const MSG_SUBSCRIBE = 0x03;
export const MSG_SUBSCRIBE_OK = 0x04;
export const MSG_SUBSCRIBE_ERR = 0x05;
export const MSG_ANNOUNCE = 0x07;
export const MSG_ANNOUNCE_OK = 0x08;
export const MSG_MAX_REQUEST_ID = 0x15;
export const MSG_GOAWAY = 0x10;
export const MSG_UNSUBSCRIBE = 0x0a;

export const MOQ_VERSION = 0xff000010;

export function vi(val) {
  if (val < 0x40) return new Uint8Array([val]);
  if (val < 0x4000) return new Uint8Array([0x40 | (val >> 8), val & 0xff]);

  if (val < 0x40000000) {
    return new Uint8Array([
      0x80 | (val >> 24),
      (val >> 16) & 0xff,
      (val >> 8) & 0xff,
      val & 0xff,
    ]);
  }

  throw new Error("Large varint not needed yet");
}

export function cat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);

  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }

  return out;
}

function len16(n) {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function lpStr(s) {
  const b = new TextEncoder().encode(s);
  return cat(vi(b.length), b);
}

function frame(type, payload) {
  return cat(vi(type), len16(payload.length), payload);
}

function nsTuple(namespace) {
  const parts = namespace.split("/");
  let out = vi(parts.length);

  for (const p of parts) {
    out = cat(out, lpStr(p));
  }

  return out;
}

export function buildClientSetup() {
  return frame(MSG_CLIENT_SETUP, cat(vi(1), vi(2), vi(1000000)));
}

export function buildSubscribe(reqId, namespace, trackName) {
  return frame(
    MSG_SUBSCRIBE,
    cat(vi(reqId), nsTuple(namespace), lpStr(trackName), vi(0)),
  );
}

export function buildAnnounceOk() {
  return frame(MSG_ANNOUNCE_OK, vi(0));
}

export function buildUnsubscribe(reqId) {
  return frame(MSG_UNSUBSCRIBE, vi(reqId));
}
