import { log } from "./logger.js";

let video = null;
let mediaSource = null;
let sourceBuffer = null;
let mseReady = false;

let removingOldBuffer = false;

let firstGroupId = null;
let pendingGroups = new Map();
let nextAppendGroup = null;
let firstSegmentResolvers = new Map();

let activeAlias = null;
let waitingAlias = null;

let timelineOffset = 0;

let missingGroupSince = null;
const GAP_WAIT_MS = 1000;

const playbackMarkers = new Map();

let playbackStarted = false;

const MP4_TIME_SHIFT = 0.067;

let MAX_BUFFER_SECONDS = 5;

const START_BUFFER_SECONDS = 1;
let LIVE_DELAY_SECONDS = 3;

const MAX_PENDING_GROUPS = 3;

let latencyTimer = null;

export function initVideoBuffer(ctx) {
  video = ctx.video;
  mediaSource = ctx.mediaSource;
  sourceBuffer = ctx.sourceBuffer;

  if (!video || !mediaSource || !sourceBuffer) {
    throw new Error(
      "initVideoBuffer requires video, mediaSource and sourceBuffer",
    );
  }

  sourceBuffer.addEventListener("updateend", () => {
    if (removingOldBuffer) {
      removingOldBuffer = false;
      appendNextSegment();
      return;
    }

    // keep disabled while debugging 1080p stalls
    // trimOldBuffer();

    logBufferedRangesDetailed();

    maybeStartPlayback();
    appendNextSegment();
  });

  video.addEventListener("waiting", () => {
    log("warn", `VIDEO waiting currentTime=${video.currentTime.toFixed(3)}`);

    for (let i = 0; i < video.buffered.length; i++) {
      log(
        "warn",
        `WAIT RANGE ${i}: ${video.buffered.start(i).toFixed(3)}-${video.buffered
          .end(i)
          .toFixed(3)}`,
      );
    }
  });

  video.addEventListener("stalled", () => {
    log("warn", `VIDEO stalled currentTime=${video.currentTime.toFixed(3)}`);
  });

  video.addEventListener("playing", () => {
    log("info", `VIDEO playing currentTime=${video.currentTime.toFixed(3)}`);
  });

  if (latencyTimer === null) {
    latencyTimer = setInterval(() => {
      checkPlaybackLatency();
    }, 1000);
  }

  mseReady = true;
  appendNextSegment();
}

export function setLiveDelaySeconds(seconds) {
  LIVE_DELAY_SECONDS = seconds;
  log("info", `LIVE_DELAY_SECONDS=${LIVE_DELAY_SECONDS}`);
}

export function applyLiveDelayNow() {
  if (!video || video.buffered.length === 0) return;

  const start = video.buffered.start(0);
  const end = video.buffered.end(video.buffered.length - 1);

  video.currentTime = Math.max(start, end - LIVE_DELAY_SECONDS);
}
function maybeStartPlayback() {
  if (playbackStarted) return;
  if (!video) return;
  if (video.buffered.length === 0) return;

  const start = video.buffered.start(0);
  const end = video.buffered.end(video.buffered.length - 1);
  const buffered = end - start;

  if (buffered < START_BUFFER_SECONDS) {
    log(
      "debug",
      `Waiting start buffer: ${buffered.toFixed(2)}s / ${START_BUFFER_SECONDS}s`,
    );
    return;
  }

  video.currentTime = Math.max(start, end - LIVE_DELAY_SECONDS);

  video.play().catch((e) => {
    log("warn", `video.play failed: ${e.message}`);
  });

  playbackStarted = true;

  log(
    "info",
    `START playback currentTime=${video.currentTime.toFixed(
      3,
    )} end=${end.toFixed(3)} ahead=${(end - video.currentTime).toFixed(2)}s`,
  );
}

function logBufferedRangesDetailed() {
  if (!video) return;

  if (video.buffered.length === 0) {
    log("debug", "buffered: empty");
    return;
  }

  for (let i = 0; i < video.buffered.length; i++) {
    const start = video.buffered.start(i);
    const end = video.buffered.end(i);
    const ahead = end - video.currentTime;

    log(
      "debug",
      `RANGE ${i}: ${start.toFixed(3)}-${end.toFixed(3)} ` +
        `currentTime=${video.currentTime.toFixed(3)} ` +
        `ahead=${ahead.toFixed(3)}s`,
    );
  }
}

function trimOldBuffer() {
  if (!sourceBuffer || sourceBuffer.updating) return;
  if (!video) return;
  if (video.buffered.length === 0) return;

  const bufferStart = video.buffered.start(0);
  const removeEnd = video.currentTime - 10;

  if (removeEnd <= bufferStart) return;

  removingOldBuffer = true;

  log(
    "debug",
    `Trim old buffer: remove ${bufferStart.toFixed(3)}-${removeEnd.toFixed(3)}`,
  );

  sourceBuffer.remove(bufferStart, removeEnd);
}

function checkPlaybackLatency() {
  if (!video) return;

  for (const [groupId, marker] of playbackMarkers) {
    if (video.currentTime >= marker.offset) {
      const playerLatency = Date.now() - marker.receiveTimestamp;
      const endToEndLatency = Date.now() - marker.publishTimestamp;

      updateLatencyOverlay(playerLatency);
      updateEndToEndLatencyOverlay(endToEndLatency);

      const now = Date.now();

      playbackMarkers.delete(groupId);
    }
  }
}

function updateLatencyOverlay(latencyMs) {
  const el = document.getElementById("latencyOverlay");
  if (!el) return;

  el.textContent = `${latencyMs} ms`;
}

function updateEndToEndLatencyOverlay(latencyMs) {
  const el = document.getElementById("endToEndLatencyOverlay");
  if (!el) return;

  el.textContent = `${latencyMs} ms`;
}

export function updateVideoOverlay(trackName) {
  const overlay = document.getElementById("videoTrackNameOverlay");
  if (overlay) {
    overlay.textContent = trackName;
  }
}
function updateThroughputOverlay(mbps) {
  const el = document.getElementById("throughputOverlay");

  if (!el) {
    return;
  }
  el.textContent = trackName;
}

export function handlePayload(
  trackAlias,
  groupId,
  objectId,
  payload,
  publishTimestamp,
) {
  if (activeAlias === null) {
    activeAlias = trackAlias;
    log("debug", `Initial active alias=${activeAlias}`);
  }

  if (trackAlias !== activeAlias && trackAlias !== waitingAlias) {
    log(
      "debug",
      `Ignore alias=${trackAlias}, active=${activeAlias}, waiting=${waitingAlias}`,
    );
    return;
  }

  pendingGroups.set(`${trackAlias}:${groupId}`, {
    trackAlias,
    groupId,
    objectId,
    payload,
    publishTimestamp: publishTimestamp ?? Date.now(),
    receiveTimestamp: Date.now(),
  });

  trimPendingGroups();

  log(
    "debug",
    `Stored pending alias=${trackAlias} g=${groupId} pending=${pendingGroups.size}`,
  );

  if (firstSegmentResolvers.has(trackAlias)) {
    log("info", `First segment arrived for alias=${trackAlias}`);
    firstSegmentResolvers.get(trackAlias)();
    firstSegmentResolvers.delete(trackAlias);
  }

  if (trackAlias === activeAlias && nextAppendGroup === null) {
    const groups = [...pendingGroups.values()]
      .filter((o) => o.trackAlias === activeAlias)
      .map((o) => o.groupId);

    nextAppendGroup = Math.min(...groups);
    firstGroupId = nextAppendGroup;
    timelineOffset = 0;

    log(
      "debug",
      `Start append order from alias=${trackAlias} firstGroup=${firstGroupId}`,
    );
  }

  appendNextSegment();
}

export function waitForFirstSegment(alias) {
  waitingAlias = alias;

  log("info", `waitForFirstSegment alias=${alias}`);

  return new Promise((resolve) => {
    firstSegmentResolvers.set(alias, resolve);
  });
}

export function appendNextSegment() {
  if (!mseReady || !sourceBuffer || sourceBuffer.updating) return;
  if (!mediaSource || mediaSource.readyState !== "open") return;
  if (nextAppendGroup === null) return;
  if (activeAlias === null) return;
  if (!video) return;

  const key = `${activeAlias}:${nextAppendGroup}`;
  const next = pendingGroups.get(key);

  if (!next) {
    handleMissingGroup();
    return;
  }

  let bufferedAhead = 0;

  if (video.buffered.length > 0) {
    bufferedAhead =
      video.buffered.end(video.buffered.length - 1) - video.currentTime;
  }

  log(
    "debug",
    `bufferAhead=${bufferedAhead.toFixed(3)} MAX=${MAX_BUFFER_SECONDS}`,
  );

  if (bufferedAhead >= MAX_BUFFER_SECONDS) {
    log("debug", `Buffer full: ${bufferedAhead.toFixed(2)}s`);
    return;
  }

  missingGroupSince = null;
  pendingGroups.delete(key);

  try {
    const segmentIndex = next.groupId - firstGroupId;
    const offset = timelineOffset + segmentIndex;

    sourceBuffer.timestampOffset = offset;

    playbackMarkers.set(next.groupId, {
      offset: Math.max(0, offset),
      publishTimestamp: next.publishTimestamp,
      receiveTimestamp: next.receiveTimestamp,
    });

    log(
      "debug",
      `Appending alias=${next.trackAlias} g=${next.groupId} timestampOffset=${sourceBuffer.timestampOffset.toFixed(
        3,
      )} pending=${pendingGroups.size}`,
    );

    sourceBuffer.appendBuffer(next.payload);

    nextAppendGroup++;
  } catch (e) {
    log("error", `Failed to append segment: ${e.message}`);
  }
}

function trimPendingGroups() {
  const groups = [
    ...new Set(
      [...pendingGroups.values()]
        .filter((o) => o.trackAlias === activeAlias)
        .map((o) => o.groupId),
    ),
  ].sort((a, b) => a - b);

  while (groups.length > MAX_PENDING_GROUPS) {
    const g = groups.shift();

    for (const [key, obj] of pendingGroups) {
      if (obj.trackAlias === activeAlias && obj.groupId === g) {
        pendingGroups.delete(key);
      }
    }

    if (nextAppendGroup !== null && g === nextAppendGroup) {
      nextAppendGroup = g + 1;
    }

    log("warn", `Dropped pending group=${g}`);
  }
}

function handleMissingGroup() {
  const groupsForAlias = [...pendingGroups.values()]
    .filter((obj) => obj.trackAlias === activeAlias)
    .map((obj) => obj.groupId);

  if (groupsForAlias.length === 0) {
    log("debug", `Waiting for alias=${activeAlias} g=${nextAppendGroup}`);
    return;
  }

  const smallestAvailable = Math.min(...groupsForAlias);

  if (smallestAvailable > nextAppendGroup) {
    if (missingGroupSince === null) {
      missingGroupSince = performance.now();

      log(
        "debug",
        `Missing alias=${activeAlias} g=${nextAppendGroup}, smallestAvailable=${smallestAvailable}`,
      );

      return;
    }

    const waited = performance.now() - missingGroupSince;

    if (waited >= GAP_WAIT_MS) {
      log(
        "warn",
        `Skip missing alias=${activeAlias} g=${nextAppendGroup}, next available=${smallestAvailable}`,
      );

      nextAppendGroup = smallestAvailable;
      missingGroupSince = null;

      appendNextSegment();
      return;
    }

    log(
      "debug",
      `Waiting gap alias=${activeAlias} g=${nextAppendGroup}, waited=${waited.toFixed(0)}ms`,
    );

    return;
  }

  log("debug", `Waiting for alias=${activeAlias} g=${nextAppendGroup}`);
}

export function setActiveAlias(alias) {
  log("warn", `SET ACTIVE ALIAS ${alias}`);

  if (!video) return;

  const switchingToNewAlias = activeAlias !== alias;

  activeAlias = alias;
  waitingAlias = null;

  const bufferedEnd =
    video.buffered.length > 0
      ? video.buffered.end(video.buffered.length - 1)
      : video.currentTime;

  for (const [key, obj] of pendingGroups) {
    if (obj.trackAlias !== alias) {
      pendingGroups.delete(key);
    }
  }

  const groups = [...pendingGroups.values()]
    .filter((o) => o.trackAlias === alias)
    .map((o) => o.groupId);

  if (switchingToNewAlias) {
    timelineOffset = Math.max(0, bufferedEnd - MP4_TIME_SHIFT);

    if (groups.length > 0) {
      nextAppendGroup = Math.min(...groups);
      firstGroupId = nextAppendGroup;
    } else {
      nextAppendGroup = null;
      firstGroupId = null;
    }

    playbackStarted = false;
  }

  missingGroupSince = null;

  log(
    "debug",
    `Switched to alias=${alias}, timelineOffset=${timelineOffset.toFixed(
      3,
    )}, firstGroupId=${firstGroupId}, nextAppendGroup=${nextAppendGroup}`,
  );

  appendNextSegment();
}

export function setMaxBufferSeconds(seconds) {
  MAX_BUFFER_SECONDS = seconds;
  log("info", `MAX_BUFFER_SECONDS=${MAX_BUFFER_SECONDS}`);
}
