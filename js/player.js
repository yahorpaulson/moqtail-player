import { log, setFilter, clearLog, togglePause, exportLog } from "./logger.js";
import { BufReader } from "./BufReader.js";
import {
  MOQ_VERSION,
  MSG_SUBSCRIBE,
  MSG_MAX_REQUEST_ID,
  MSG_SERVER_SETUP,
  MSG_SUBSCRIBE_OK,
  MSG_SUBSCRIBE_ERR,
  MSG_ANNOUNCE,
  MSG_GOAWAY,
  buildClientSetup,
  buildSubscribe,
  buildAnnounceOk,
  vi,
} from "./moq.js";

// ── State ──────────────────────────────────────────────────────────────────
let transport = null;
let ctrlWriter = null;
let ctrlReader = null;
let mode = "datagram";

let rateCounter = 0;
let reqIdCounter = 0;
let lastGroup = null,
  lastObject = null;
let stats = { received: 0, gaps: 0, errors: 0 };
let activeSubscriptions = [];
const MAX_LOG = 3000;

let mediaSource = null;
let sourceBuffer = null; // browser buffer
let mseReady = false;

let firstGroupId = null; //temp

let pendingGroups = new Map(); // used for store received groups in the right order
let nextAppendGroup = null;

// Pre-fill from ?url= query param
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
document.getElementById("subscribeBtn").onclick = () => doSubscribe();
document.getElementById("clearLogBtn").onclick = () => clearLog();
document.getElementById("pauseBtn").onclick = () => togglePause();
document.getElementById("exportLogBtn").onclick = () => exportLog();

// Pump a QUIC ReadableStream into a BufReader
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

//Video player initialization
function initVideoPlayer() {
  const video = document.getElementById("videoPlayer");
  setInterval(() => {
    let bufferedSecs = 0;

    if (video.buffered.length > 0) {
      bufferedSecs =
        video.buffered.end(video.buffered.length - 1) - video.currentTime;
    }

    const queueBytes = [...pendingGroups.values()].reduce(
      (sum, obj) => sum + obj.payload.length,
      0,
    );

    document.getElementById("bufferSeconds").textContent =
      `${Math.max(0, bufferedSecs).toFixed(2)}s`;

    document.getElementById("queueObjects").textContent = pendingGroups.size;

    document.getElementById("queueSize").textContent =
      `${(queueBytes / 1024 / 1024).toFixed(2)} MB`;

    const tn = document.getElementById("trackName").value.trim();
    document.getElementById("currentTrack").textContent = tn || "—";
  }, 500);

  mediaSource = new MediaSource();
  video.src = URL.createObjectURL(mediaSource);

  mediaSource.addEventListener("sourceopen", () => {
    log("info", "MediaSource opened");

    sourceBuffer = mediaSource.addSourceBuffer(
      'video/mp4; codecs="avc1.64001f"',
    );

    sourceBuffer.mode = "segments";

    sourceBuffer.addEventListener("updateend", () => {
      const video = document.getElementById("videoPlayer");

      if (video.buffered.length === 0) {
        log("debug", "buffered: empty");
      } else {
        for (let i = 0; i < video.buffered.length; i++) {
          log(
            "debug",
            `buffered[${i}]=${video.buffered.start(i).toFixed(3)}-${video.buffered.end(i).toFixed(3)}`,
          );
        }
      }

      appendNextSegment();
    });
    mseReady = true;
    appendNextSegment();
  });
}

// ── Connection ─────────────────────────────────────────────────────────────
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

    //start video player
    initVideoPlayer();

    // Open bidirectional control stream
    const bidi = await transport.createBidirectionalStream();
    ctrlWriter = bidi.writable.getWriter();
    ctrlReader = new BufReader();
    pumpStream(bidi.readable, ctrlReader, "control");

    // Send CLIENT_SETUP
    const setup = buildClientSetup();
    log("debug", `Sending CLIENT_SETUP: ${hexDump(setup)}`);
    await ctrlWriter.write(setup);

    log("debug", "Waiting for SERVER_SETUP...");

    // Read SERVER_SETUP
    await readServerSetup();

    // Start background control message loop
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
  } else {
    const len = await r.readVarint();
    const value = await r.readBytes(len);
    log("debug", `Param Bytes key=${key} len=${len}`);
    return { key, value };
  }
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
          const reqId = await ctrlReader.readVarint(); //subscribe request ID
          const trackAlias = await ctrlReader.readVarint();
          const expires = await ctrlReader.readVarint();
          const groupOrder = await ctrlReader.readVarint();
          const contentExists = await ctrlReader.readVarint();
          if (contentExists) {
            await ctrlReader.readVarint(); // largest group
            await ctrlReader.readVarint(); // largest object
          }
          const numParams = await ctrlReader.readVarint();
          for (let i = 0; i < numParams; i++) {
            const k = await ctrlReader.readVarint();
            const vl = await ctrlReader.readVarint();
            await ctrlReader.readBytes(vl);
          }
          log(
            "info",
            `SUBSCRIBE_OK reqId=${reqId} alias=${trackAlias} contentExists=${contentExists}`,
          );
          // Find pending sub and mark as live
          const sub = activeSubscriptions.find((s) => s.reqId === reqId);
          if (sub) {
            sub.alias = trackAlias;
            sub.live = true;
            renderTrackList();
          }
          break;
        }
        case MSG_SUBSCRIBE_ERR: {
          const reqId = await ctrlReader.readVarint();
          const code = await ctrlReader.readVarint();
          const reason = await ctrlReader.readString();
          const alias = await ctrlReader.readVarint();
          log(
            "error",
            `SUBSCRIBE_ERROR reqId=${reqId} code=${code} reason="${reason}"`,
          );
          break;
        }
        case MSG_ANNOUNCE: {
          // namespace tuple + params — skip
          const numParts = await ctrlReader.readVarint();
          for (let i = 0; i < numParts; i++) await ctrlReader.readString();
          const numParams = await ctrlReader.readVarint();
          for (let i = 0; i < numParams; i++) {
            const k = await ctrlReader.readVarint();
            const vl = await ctrlReader.readVarint();
            await ctrlReader.readBytes(vl);
          }
          // send ANNOUNCE_OK with empty namespace (just ack)
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
          // Skip unknown message
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
  if (transport) transport.close({ closeCode: 0, reason: "User disconnected" });
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
}

// ── Subscribe ──────────────────────────────────────────────────────────────
async function doSubscribe() {
  if (!transport || !ctrlWriter) {
    log("error", "Not connected");
    return;
  }
  const ns = document.getElementById("namespace").value.trim();
  const tn = document.getElementById("trackName").value.trim();
  if (!ns || !tn) {
    log("error", "Namespace and track name required");
    return;
  }

  const reqId = reqIdCounter;
  reqIdCounter += 2; // clients use even IDs per spec

  const sub = { reqId, ns, tn, alias: null, live: false, mode };
  activeSubscriptions.push(sub);
  renderTrackList();

  const msg = buildSubscribe(reqId, ns, tn);
  log("info", `SUBSCRIBE reqId=${reqId} ns="${ns}" track="${tn}" mode=${mode}`);
  log("debug", `SUBSCRIBE bytes: ${hexDump(msg)}`);

  try {
    await ctrlWriter.write(msg);
  } catch (e) {
    log("error", `Subscribe send failed: ${e.message}`);
    return;
  }

  // Start data reception based on mode
  if (mode === "datagram") {
    listenDatagrams(reqId);
  } else {
    listenStreams(reqId);
  }
}

// ── Datagram reception ─────────────────────────────────────────────────────
// DatagramObject wire (draft-16):
// track_alias(vi) group_id(vi) object_id(vi) publisher_priority(vi) extension_headers_length(vi) [ext bytes] payload
async function listenDatagrams(forReqId) {
  log("info", `Listening for datagrams (will filter alias=${forReqId})…`);
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
        off += extLen; // skip extension headers
        const payload = bytes.slice(off);
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

// ── Subgroup stream reception ──────────────────────────────────────────────
// Subgroup stream header (draft-16):
// stream_type(vi=0x04) track_alias(vi) group_id(vi) subgroup_id(vi) publisher_priority(vi)
// Then objects: object_id(vi) extension_headers_length(vi) [ext bytes] payload_length(vi) payload
async function listenStreams(forReqId) {
  log("info", "Listening for unidirectional streams…");
  const streamReader = transport.incomingUnidirectionalStreams.getReader();
  try {
    while (true) {
      const { value: stream, done } = await streamReader.read();
      if (done) break;
      log("debug", "Accepted uni stream");
      handleSubgroupStream(stream).catch((e) =>
        log("debug", `Stream ended: ${e.message}`),
      );
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
  const publisherPriority = await sr.readByte(); // важно: u8, не varint

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

function handlePayload(trackAlias, groupId, objectId, payload) {
  pendingGroups.set(groupId, { groupId, objectId, payload });

  log("debug", `Stored pending g=${groupId} pending=${pendingGroups.size}`);

  if (nextAppendGroup === null) {
    nextAppendGroup = groupId;
    firstGroupId = groupId;
    log("debug", `Start append order from g=${groupId}`);
  }

  appendNextSegment();
}

function appendNextSegment() {
  if (!mseReady || !sourceBuffer || sourceBuffer.updating) return;
  if (!mediaSource || mediaSource.readyState !== "open") return;
  if (nextAppendGroup === null) return;

  const next = pendingGroups.get(nextAppendGroup);

  if (!next) {
    log("debug", `Waiting for g=${nextAppendGroup}`);
    return;
  }

  pendingGroups.delete(nextAppendGroup);

  try {
    log("debug", `Appending g=${next.groupId} pending=${pendingGroups.size}`);

    sourceBuffer.timestampOffset = next.groupId - firstGroupId;
    sourceBuffer.appendBuffer(next.payload);

    log(
      "debug",
      `Appended segment to SourceBuffer: g=${next.groupId} o=${next.objectId} size=${next.payload.length}`,
    );

    nextAppendGroup++;
  } catch (e) {
    log("error", `Failed to append segment: ${e.message}`);
  }
}

// ── Object processing ──────────────────────────────────────────────────────
function processObject(trackAlias, groupId, objectId, payloadLen) {
  rateCounter++;
  stats.received++;

  let gapFlag = false;
  if (lastGroup !== null) {
    if (
      groupId === lastGroup &&
      objectId !== lastObject + 1 &&
      !(objectId === 0 && groupId > lastGroup)
    ) {
      stats.gaps++;
      document.getElementById("statGaps").textContent = stats.gaps;
      gapFlag = true;
    } else if (groupId > lastGroup + 1) {
      stats.gaps++;
      document.getElementById("statGaps").textContent = stats.gaps;
      gapFlag = true;
    }
  }
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

// ── Varint read from byte array ────────────────────────────────────────────
function readVarintAt(buf, off) {
  const first = buf[off];
  const lc = (first >> 6) & 0x3;
  if (lc === 0) return { val: first & 0x3f, len: 1 };
  const extra = [0, 1, 3, 7][lc];
  let val = first & 0x3f;
  for (let i = 1; i <= extra; i++) val = val * 256 + buf[off + i];
  return { val, len: 1 + extra };
}

// ── UI helpers ─────────────────────────────────────────────────────────────
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
  if (activeSubscriptions.length === 0) {
    list.innerHTML =
      '<div style="font-size:12px;color:var(--text3);padding:2px">No active subscriptions</div>';
    return;
  }
  list.innerHTML = "";
  activeSubscriptions.forEach((s, i) => {
    const el = document.createElement("div");
    el.className =
      "track-item" + (i === activeSubscriptions.length - 1 ? " active" : "");
    el.innerHTML = `<div class="track-icon">${i + 1}</div>
      <div class="track-name">${s.tn}</div>
      <div class="track-badge badge-live">${s.live ? "LIVE" : "…"}</div>`;
    el.title = `${s.ns}/${s.tn} reqId=${s.reqId} alias=${s.alias}`;
    el.onclick = () => {
      document
        .querySelectorAll(".track-item")
        .forEach((x) => x.classList.remove("active"));
      el.classList.add("active");
      document.getElementById("namespace").value = s.ns;
      document.getElementById("trackName").value = s.tn;
    };
    list.appendChild(el);
  });
}

function hexDump(bytes) {
  return (
    Array.from(bytes.slice(0, 32))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ") + (bytes.length > 32 ? "…" : "")
  );
}

// ── Startup messages ───────────────────────────────────────────────────────
log("system", "MOQtail Player — MOQ draft-16 (version 0xff000010)");
log(
  "system",
  "Chrome: launch with --ignore-certificate-errors for self-signed QUIC certs",
);
log(
  "system",
  "Firefox: set network.webtransport.enabled=true and security.tls.enable_0rtt_data=false in about:config",
);
