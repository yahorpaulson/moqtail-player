import { log, clearLog, togglePause, exportLog } from "./logger.js";
import { BufReader } from "./BufReader.js";
import {
  MOQ_VERSION,
  MSG_MAX_REQUEST_ID,
  MSG_SERVER_SETUP,
  MSG_SUBSCRIBE_OK,
  MSG_SUBSCRIBE_ERR,
  MSG_ANNOUNCE,
  MSG_GOAWAY,
  buildClientSetup,
  buildSubscribe,
  buildUnsubscribe,
  buildAnnounceOk,
} from "./moq.js";

import {
  initVideoPlayer,
  handlePayload,
  setActiveAlias,
  waitForFirstSegment,
} from "./videoBuffer.js";

let transport = null;
let ctrlWriter = null;
let ctrlReader = null;
let mode = "subgroup";

let rateCounter = 0;
let reqIdCounter = 0;
let lastGroup = null;
let lastObject = null;

let stats = { received: 0, gaps: 0, errors: 0 };
let activeSubscription = null;

let subscribeOkResolvers = new Map();

let subscribed = false;
let streamsListenerStarted = false;
let datagramListenerStarted = false;

let lastSeenByAlias = new Map();

(function () {
  const p = new URLSearchParams(location.search);
  if (p.get("url")) document.getElementById("serverUrl").value = p.get("url");

  document.getElementById("urlNote").textContent =
    location.origin + location.pathname;
})();

setInterval(() => {
  document.getElementById("statRate").textContent = rateCounter + "/s";
  rateCounter = 0;
}, 1000);

document.getElementById("modeDatagramBtn").onclick = () => setMode("datagram");
document.getElementById("modeStreamBtn").onclick = () => setMode("subgroup");
document.getElementById("connectBtn").onclick = () => doConnect();
document.getElementById("disconnectBtn").onclick = () => doDisconnect();

document.getElementById("subscribeBtn").onclick = async () => {
  log("warn", "SUBSCRIBE BUTTON CLICK");

  const ns = document.getElementById("namespace").value.trim();
  const tn = document.getElementById("trackName").value.trim();

  log("DBG", "subscrubed:" + subscribed);

  if (!subscribed) {
    subscribed = true;
    document.getElementById("subscribeBtn").textContent = "Switch track";

    console.log("FIRST SUBSCRIBE", ns, tn);

    try {
      const result = await doSubscribe(ns, tn, true);

      if (!result) {
        subscribed = false;
        return;
      }

      activeSubscription = { ...result, ns, tn, live: true, mode };
      renderTrackList();
    } catch (e) {
      console.error("doSubscribe failed", e);
      subscribed = false;
    }

    return;
  }

  console.log("CALL switchTrack", ns, tn);
  await switchTrack(ns, tn);
};

document.getElementById("clearLogBtn").onclick = () => clearLog();
document.getElementById("pauseBtn").onclick = () => togglePause();
document.getElementById("exportLogBtn").onclick = () => exportLog();

function pumpStream(readable, bufReader, label) {
  const reader = readable.getReader();

  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const bytes = new Uint8Array(value);

        if (label === "control") {
          log("debug", `CONTROL RX: ${hexDump(bytes)}`);
        }

        bufReader.feed(bytes);
      }
    } catch (e) {
      log("debug", `Stream pump ended (${label}): ${e.message}`);
    }
  })();
}

async function doConnect() {
  const host = document.getElementById("serverUrl").value.trim();
  const port = document.getElementById("serverPort").value.trim() || "4433";
  const path = document.getElementById("serverPath").value.trim() || "/";

  if (!host) {
    log("error", "Enter server IP/hostname");
    return;
  }

  const url = `https://${host}:${port}${path}`;

  document.getElementById("serverLabel").textContent = url;
  setStatus("connecting", "Connecting…");

  log("info", `Connecting to ${url}`);
  log("debug", `Using MOQ version 0x${MOQ_VERSION.toString(16)} (draft-16)`);

  try {
    transport = new WebTransport(url, {
      protocols: ["moqt-16"],
    });

    await transport.ready;

    setStatus("connected", "Connected");
    log("info", "WebTransport ready, opening control stream");

    document.getElementById("connectBtn").style.display = "none";
    document.getElementById("disconnectBtn").style.display = "";
    document.getElementById("subscribeBtn").disabled = false;

    initVideoPlayer();

    const bidi = await transport.createBidirectionalStream();

    ctrlWriter = bidi.writable.getWriter();
    ctrlReader = new BufReader();

    pumpStream(bidi.readable, ctrlReader, "control");

    const setup = buildClientSetup();
    log("debug", `Sending CLIENT_SETUP: ${hexDump(setup)}`);
    await ctrlWriter.write(setup);

    log("debug", "Waiting for SERVER_SETUP...");
    await readServerSetup();

    controlLoop();

    transport.closed
      .then(() => {
        log("info", "Connection closed by server");
        resetUi();
      })
      .catch((e) => {
        log("warn", `Connection closed: ${e.message}`);
        resetUi();
      });
  } catch (e) {
    setStatus("error", "Failed");
    log("error", `Connect failed: ${e.message}`);
    log(
      "warn",
      "Chrome tip: launch with --ignore-certificate-errors-spki-list=<fingerprint> or --ignore-certificate-errors",
    );
    transport = null;
  }
}

async function readKeyValuePair(r) {
  const key = await r.readVarint();

  if (key % 2 === 0) {
    const value = await r.readVarint();
    log("debug", `Param VarInt key=${key} value=${value}`);
    return { key, value };
  }

  const len = await r.readVarint();
  const value = await r.readBytes(len);
  log("debug", `Param Bytes key=${key} len=${len}`);
  return { key, value };
}

async function readServerSetup() {
  const msgType = await ctrlReader.readVarint();
  const msgLen = await ctrlReader.readU16();

  if (msgType !== MSG_SERVER_SETUP) {
    await ctrlReader.readBytes(msgLen);
    throw new Error(`Expected SERVER_SETUP, got 0x${msgType.toString(16)}`);
  }

  const payload = await ctrlReader.readBytes(msgLen);
  const r = new BufReader();

  r.feed(payload);

  const version = await r.readVarint();
  const numParams = await r.readVarint();

  for (let i = 0; i < numParams; i++) {
    await readKeyValuePair(r);
  }

  log("info", `SERVER_SETUP: selected version=0x${version.toString(16)}`);
}

async function controlLoop() {
  try {
    while (true) {
      const msgType = await ctrlReader.readVarint();
      const msgLen = await ctrlReader.readU16();

      log("debug", `Control msg 0x${msgType.toString(16)} len=${msgLen}`);

      switch (msgType) {
        case MSG_SUBSCRIBE_OK: {
          const payload = await ctrlReader.readBytes(msgLen);
          log("debug", `SUBSCRIBE_OK RAW payload: ${hexDump(payload)}`);

          const r = new BufReader();
          r.feed(payload);

          const reqId = await r.readVarint();
          const trackAlias = await r.readVarint();

          log("info", `SUBSCRIBE_OK reqId=${reqId} alias=${trackAlias}`);

          const resolver = subscribeOkResolvers.get(reqId);
          log(
            "info",
            `resolver for reqId=${reqId}: ${resolver ? "FOUND" : "MISSING"}`,
          );

          if (resolver) {
            resolver(trackAlias);
            subscribeOkResolvers.delete(reqId);
          }

          if (activeSubscription && activeSubscription.reqId === reqId) {
            activeSubscription.alias = trackAlias;
            activeSubscription.live = true;
            renderTrackList();
          }

          break;
        }

        case MSG_SUBSCRIBE_ERR: {
          const payload = await ctrlReader.readBytes(msgLen);
          handleSubscribeError(payload);
          break;
        }

        case MSG_ANNOUNCE: {
          const numParts = await ctrlReader.readVarint();

          for (let i = 0; i < numParts; i++) {
            await ctrlReader.readString();
          }

          const numParams = await ctrlReader.readVarint();

          for (let i = 0; i < numParams; i++) {
            const k = await ctrlReader.readVarint();
            const vl = await ctrlReader.readVarint();
            await ctrlReader.readBytes(vl);
          }

          await ctrlWriter.write(buildAnnounceOk());
          log("debug", "Handled ANNOUNCE → sent ANNOUNCE_OK");
          break;
        }

        case MSG_MAX_REQUEST_ID: {
          const maxId = await ctrlReader.readVarint();
          log("debug", `MAX_REQUEST_ID=${maxId}`);
          break;
        }

        case MSG_GOAWAY: {
          const newSessionUri = await ctrlReader.readString();
          log("warn", `GOAWAY new_session_uri="${newSessionUri}"`);
          break;
        }

        default: {
          await ctrlReader.readBytes(msgLen);
          log("debug", `Unknown control msg 0x${msgType.toString(16)} skipped`);
        }
      }
    }
  } catch (e) {
    log("debug", `Control loop ended: ${e.message}`);
  }
}

function doDisconnect() {
  if (transport) {
    transport.close({ closeCode: 0, reason: "User disconnected" });
  }

  resetUi();
}

function resetUi() {
  document.getElementById("connectBtn").style.display = "";
  document.getElementById("disconnectBtn").style.display = "none";
  document.getElementById("subscribeBtn").disabled = true;

  setStatus("idle", "Disconnected");

  transport = null;
  ctrlWriter = null;
  ctrlReader = null;

  subscribed = false;
  streamsListenerStarted = false;
  datagramListenerStarted = false;
  activeSubscription = null;
  subscribeOkResolvers.clear();

  renderTrackList();
}

async function handleSubscribeError(payload) {
  const r = new BufReader();
  r.feed(payload);

  const reqId = await r.readVarint();
  const code = await r.readVarint();

  const reasonLen = await r.readVarint();
  const reasonBytes = await r.readBytes(reasonLen);
  const reason = new TextDecoder().decode(reasonBytes);

  log(
    "error",
    `SUBSCRIBE_ERROR reqId=${reqId} code=${code} reason="${reason}"`,
  );

  const resolver = subscribeOkResolvers.get(reqId);
  if (resolver) {
    resolver(null);
    subscribeOkResolvers.delete(reqId);
  }
}

function waitForSubscribeOk(reqId) {
  return new Promise((resolve) => {
    subscribeOkResolvers.set(reqId, resolve);
  });
}

async function doSubscribe(ns, tn, makeActive = true) {
  if (!transport || !ctrlWriter) {
    log("error", "Not connected");
    return null;
  }

  if (!ns || !tn) {
    log("error", "Namespace and track name required");
    return null;
  }

  const reqId = reqIdCounter;

  reqIdCounter += 2;

  activeSubscription = { reqId, ns, tn, alias: null, live: false, mode };
  renderTrackList();

  const msg = buildSubscribe(reqId, ns, tn);

  log("info", `SUBSCRIBE reqId=${reqId} ns="${ns}" track="${tn}" mode=${mode}`);
  log("debug", `SUBSCRIBE bytes: ${hexDump(msg)}`);

  try {
    ctrlWriter.write(msg).catch((e) => {
      log("error", `Subscribe send failed: ${e.message}`);
    });
  } catch (e) {
    log("error", `Subscribe send failed sync: ${e.message}`);
    return null;
  }

  if (mode === "datagram") {
    if (!datagramListenerStarted) {
      datagramListenerStarted = true;
      listenDatagrams();
    }
  } else {
    if (!streamsListenerStarted) {
      streamsListenerStarted = true;
      listenStreams();
    }
  }

  const alias = await waitForSubscribeOk(reqId);

  log("info", `SUBSCRIBE_OK alias=${alias}`);

  if (makeActive) {
    await waitForFirstSegment(alias);
    setActiveAlias(alias);
  }

  return { reqId, alias };
}

export async function doUnsubscribe(reqId) {
  if (reqId === undefined || reqId === null) {
    log("warn", "UNSUBSCRIBE skipped: reqId is missing");
    return;
  }

  if (!ctrlWriter) {
    log("warn", "UNSUBSCRIBE skipped: controlWriter is missing");
    return;
  }

  const bytes = buildUnsubscribe(reqId);

  log("info", `UNSUBSCRIBE reqId=${reqId}`);
  log(
    "debug",
    "UNSUBSCRIBE bytes: " +
      [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" "),
  );

  await ctrlWriter.write(bytes);
}

async function switchTrack(ns, tn) {
  const oldSubscription = activeSubscription ? { ...activeSubscription } : null;

  log("info", `switchTrack started ns="${ns}" track="${tn}"`);

  const result = await doSubscribe(ns, tn, false);
  if (!result) return;

  const { reqId, alias } = result;

  log("info", `waiting first segment alias=${alias}`);

  await waitForFirstSegment(alias);

  log("info", `switch to alias=${alias}`);

  setActiveAlias(alias);

  activeSubscription = {
    reqId,
    alias,
    ns,
    tn,
    live: true,
    mode,
  };

  renderTrackList();

  if (oldSubscription && oldSubscription.reqId !== reqId) {
    await doUnsubscribe(oldSubscription.reqId);
  }
}

async function listenDatagrams() {
  log("info", "Listening for datagrams…");

  const dgReader = transport.datagrams.readable.getReader();

  try {
    while (true) {
      const { value, done } = await dgReader.read();
      if (done) break;

      try {
        const bytes = new Uint8Array(value);
        let off = 0;

        function rv() {
          const r = readVarintAt(bytes, off);
          off += r.len;
          return r.val;
        }

        const trackAlias = rv();
        const groupId = rv();
        const objectId = rv();
        const pubPriority = rv();
        const extLen = rv();

        off += extLen;

        const payload = bytes.slice(off);

        log("warn", `SUBSCRIBE_OK RAW: ${hexDump(payload)}`);

        handlePayload(trackAlias, groupId, objectId, payload);
        processObject(trackAlias, groupId, objectId, payload.length);
      } catch (e) {
        stats.errors++;
        document.getElementById("statErrors").textContent = stats.errors;
        log("error", `Datagram parse error: ${e.message}`);
      }
    }
  } catch (e) {
    log("warn", `Datagram reader ended: ${e.message}`);
  }
}

async function listenStreams() {
  log("info", "Listening for unidirectional streams…");

  const streamReader = transport.incomingUnidirectionalStreams.getReader();

  try {
    while (true) {
      const { value: stream, done } = await streamReader.read();

      if (done) break;

      log("debug", "Accepted uni stream");

      handleSubgroupStream(stream).catch((e) => {
        log("debug", `Stream ended: ${e.message}`);
      });
    }
  } catch (e) {
    log("warn", `Stream accept ended: ${e.message}`);
  }
}

async function handleSubgroupStream(stream) {
  const sr = new BufReader();

  pumpStream(stream, sr, "subgroup");

  const streamType = await sr.readVarint();
  const trackAlias = await sr.readVarint();
  const groupId = await sr.readVarint();
  const subgroupId = await sr.readVarint();
  const publisherPriority = await sr.readByte();

  log(
    "debug",
    `Subgroup stream: type=${streamType} alias=${trackAlias} g=${groupId} sub=${subgroupId} prio=${publisherPriority}`,
  );

  const objectIdDelta = await sr.readVarint();
  log("debug", `objectIdDelta=${objectIdDelta}`);

  const extLen = await sr.readVarint();
  log("debug", `extLen=${extLen}`);

  if (extLen > 0) {
    await sr.readBytes(extLen);
  }

  const payloadLen = await sr.readVarint();
  log("debug", `payloadLen=${payloadLen}`);

  const payload = await sr.readBytes(payloadLen);

  handlePayload(trackAlias, groupId, objectIdDelta, payload);
  processObject(trackAlias, groupId, objectIdDelta, payload.length);
}

function processObject(trackAlias, groupId, objectId, payloadLen) {
  rateCounter++;
  stats.received++;

  let gapFlag = false;

  const last = lastSeenByAlias.get(trackAlias);

  if (last) {
    if (
      groupId === last.groupId &&
      objectId !== last.objectId + 1 &&
      !(objectId === 0 && groupId > last.groupId)
    ) {
      gapFlag = true;
    } else if (groupId > last.groupId + 1) {
      gapFlag = true;
    }
  }

  if (gapFlag) {
    stats.gaps++;
    document.getElementById("statGaps").textContent = stats.gaps;
  }

  lastSeenByAlias.set(trackAlias, { groupId, objectId });

  lastGroup = groupId;
  lastObject = objectId;

  document.getElementById("statReceived").textContent = stats.received;
  document.getElementById("statGroup").textContent = groupId;
  document.getElementById("statObject").textContent = objectId;

  const shouldLog =
    stats.received <= 10 || stats.received % 100 === 0 || gapFlag;

  if (shouldLog) {
    const tag = gapFlag
      ? '<span class="gap-tag">GAP</span>'
      : '<span class="ok-tag">OK</span>';

    log(
      "recv",
      `#${stats.received} alias=${trackAlias} g=${groupId} o=${objectId} ${payloadLen}B ${tag}`,
    );
  }
}

function readVarintAt(buf, off) {
  const first = buf[off];
  const lc = (first >> 6) & 0x3;

  if (lc === 0) return { val: first & 0x3f, len: 1 };

  const extra = [0, 1, 3, 7][lc];

  let val = first & 0x3f;

  for (let i = 1; i <= extra; i++) {
    val = val * 256 + buf[off + i];
  }

  return { val, len: 1 + extra };
}

function setMode(m) {
  mode = m;

  document
    .getElementById("modeDatagramBtn")
    .classList.toggle("active", m === "datagram");

  document
    .getElementById("modeStreamBtn")
    .classList.toggle("active", m === "subgroup");
}

function setStatus(type, text) {
  document.getElementById("statusBadge").className = "status-badge " + type;
  document.getElementById("statusText").textContent = text;
}

function renderTrackList() {
  const list = document.getElementById("tracksList");

  if (!activeSubscription) {
    list.innerHTML =
      '<div style="font-size:12px;color:var(--text3);padding:2px">No active subscription</div>';
    return;
  }

  list.innerHTML = `
    <div class="track-item active">
      <div class="track-icon">1</div>
      <div class="track-name">${activeSubscription.tn}</div>
      <div class="track-badge badge-live">
        ${activeSubscription.live ? "LIVE" : "…"}
      </div>
    </div>
  `;
}

function hexDump(bytes) {
  return (
    Array.from(bytes.slice(0, 32))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ") + (bytes.length > 32 ? "…" : "")
  );
}

log("system", "MOQtail Player — MOQ draft-16 (version 0xff000010)");
log(
  "system",
  "Chrome: launch with --ignore-certificate-errors for self-signed QUIC certs",
);
log(
  "system",
  "Firefox: set network.webtransport.enabled=true and security.tls.enable_0rtt_data=false in about:config",
);
