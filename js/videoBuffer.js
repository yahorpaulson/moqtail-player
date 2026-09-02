import { log } from "./logger.js";
import { relayClockOffsetMs } from "./timeSynchronizer.js";
import {
  addLatencySample,
  addBufferSample,
  startStall,
  endStall,
} from "./experiment-stats.js";

import {
  calculateInterArrival,
  addInterArrivalSample,
  resetArrivalMetrics,
} from "./experiment-stats/arrivalMetrics.js";

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
const SEGMENT_DURATION_SECONDS = 1;
let missingGroupTimer = null;

const playbackMarkers = new Map();

let playbackStarted = false;

const MP4_TIME_SHIFT = 0.067;

let MAX_BUFFER_SECONDS = 5;

const START_BUFFER_SECONDS = 1;
let LIVE_DELAY_SECONDS = 3;

const MAX_PENDING_GROUPS = 5;

let latencyTimer = null;
let latestObjectE2ELatency = null;

let waitingTimer = null;

let latestPlayerLatency = null;

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

    // keep disabled
    trimOldBuffer();

    logBufferedRangesDetailed();

    maybeStartPlayback();
    appendNextSegment();
  });

  video.addEventListener("waiting", () => {
    if (!playbackStarted) return;
    if (video.paused || video.ended || video.seeking) return;
    if (waitingTimer !== null) return;

    waitingTimer = setTimeout(() => {
      startStall();
      waitingTimer = null;

      log("warn", `REAL STALL currentTime=${video.currentTime.toFixed(3)}`);
    }, 250); // wait 250ms before considering it a stall
  });

  video.addEventListener("playing", () => {
    if (waitingTimer !== null) {
      clearTimeout(waitingTimer);
      waitingTimer = null;
    }

    endStall();

    log("info", `VIDEO playing currentTime=${video.currentTime.toFixed(3)}`);
  });

  video.addEventListener("error", () => {
    const error = video.error;

    log(
      "error",
      `VIDEO ERROR code=${error?.code ?? "unknown"} ` +
        `message=${error?.message ?? "unknown"}`,
    );

    mseReady = false;
  });

  video.addEventListener("stalled", () => {
    log("warn", `VIDEO stalled currentTime=${video.currentTime.toFixed(3)}`);
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
    return;
  }

  video.currentTime = Math.max(start, end - LIVE_DELAY_SECONDS);

  video.play().catch((e) => {
    log("warn", `video.play failed: ${e.message}`);
  });

  playbackStarted = true;
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

  if (video.ended || (video.paused && playbackStarted)) {
    return;
  }

  const bufferSeconds = getContiguousBufferAhead();

  addBufferSample(bufferSeconds);

  /*
   * Find the newest segment whose playback position has already been
   * reached. Keep that marker until playback reaches a newer segment.
   * This lets the 1-second timer record latency continuously, including
   * while currentTime is frozen during a playback stall.
   */
  let currentMarkerKey = null;
  let currentMarker = null;

  for (const [markerKey, marker] of playbackMarkers) {
    if (marker.offset > video.currentTime) {
      continue;
    }

    if (currentMarker === null || marker.offset > currentMarker.offset) {
      currentMarkerKey = markerKey;
      currentMarker = marker;
    }
  }

  if (currentMarker === null) {
    return;
  }

  const now = Date.now();

  const playerLatency = now - currentMarker.receiveTimestamp;

  updateLatencyOverlay(playerLatency);

  /*
   * Exactly one latency_sample row is added on every 1-second timer tick.
   */
  if (latestObjectE2ELatency !== null) {
    addLatencySample({
      e2eLatencyMs: latestObjectE2ELatency,
      playerLatencyMs: playerLatency,
    });
  }

  /*
   * Older markers can no longer describe the current playback position.
   * Keep the current marker and all future markers.
   */
  for (const [markerKey, marker] of playbackMarkers) {
    if (
      markerKey !== currentMarkerKey &&
      marker.offset <= currentMarker.offset
    ) {
      playbackMarkers.delete(markerKey);
    }
  }
}

function getContiguousBufferAhead() {
  if (!video || video.buffered.length === 0) {
    return 0;
  }

  const currentTime = video.currentTime;
  const tolerance = 0.05;

  for (let i = 0; i < video.buffered.length; i++) {
    const start = video.buffered.start(i);
    const end = video.buffered.end(i);

    if (currentTime >= start - tolerance && currentTime <= end + tolerance) {
      return Math.max(0, end - currentTime);
    }
  }

  return 0;
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

  if (!Number.isFinite(mbps)) {
    el.textContent = "—";
    return;
  }

  el.textContent = `${mbps.toFixed(2)} Mbps`;
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
  }

  if (trackAlias !== activeAlias && trackAlias !== waitingAlias) {
    return;
  }

  const receiveTimeMonotonic = performance.now();
  const receiveTimestamp = Date.now();

  const rawE2ELatency =
    receiveTimestamp - publishTimestamp + relayClockOffsetMs;

  latestObjectE2ELatency =
    receiveTimestamp + relayClockOffsetMs - publishTimestamp;

  log(
    "debug",
    `E2E group=${groupId} raw=${rawE2ELatency.toFixed(1)}ms ` +
      `offset=${relayClockOffsetMs.toFixed(1)}ms ` +
      `corrected=${latestObjectE2ELatency.toFixed(1)}ms`,
  );

  updateEndToEndLatencyOverlay(latestObjectE2ELatency);

  const arrivalMetrics = calculateInterArrival(receiveTimeMonotonic);

  if (arrivalMetrics !== null) {
    addInterArrivalSample({
      groupId,
      trackAlias,
      interArrivalMs: arrivalMetrics.interArrivalMs,
      smoothedInterArrivalMs: arrivalMetrics.smoothedInterArrivalMs,
    });
  }

  pendingGroups.set(`${trackAlias}:${groupId}`, {
    trackAlias,
    groupId,
    objectId,
    payload,
    publishTimestamp: publishTimestamp ?? receiveTimestamp,
    receiveTimestamp,
    interArrivalMs: arrivalMetrics?.interArrivalMs ?? null,
    smoothedInterArrivalMs: arrivalMetrics?.smoothedInterArrivalMs ?? null,
  });

  //trimPendingGroups();

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

  const segmentAlreadyAvailable = [...pendingGroups.values()].some(
    (segment) => segment.trackAlias === alias,
  );

  if (segmentAlreadyAvailable) {
    return Promise.resolve();
  }

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

  const bufferedAhead = getContiguousBufferAhead();

  log(
    "debug",
    `bufferAhead=${bufferedAhead.toFixed(3)} MAX=${MAX_BUFFER_SECONDS}`,
  );

  if (bufferedAhead >= MAX_BUFFER_SECONDS) {
    log("debug", `Buffer full: ${bufferedAhead.toFixed(2)}s`);
    return;
  }

  missingGroupSince = null;
  if (missingGroupTimer !== null) {
    clearTimeout(missingGroupTimer);
    missingGroupTimer = null;
  }

  try {
    const segmentIndex = next.groupId - firstGroupId;
    const offset = timelineOffset + segmentIndex;

    const markerKey = `${next.trackAlias}:${next.groupId}`;

    sourceBuffer.timestampOffset = offset;

    sourceBuffer.appendBuffer(next.payload);

    pendingGroups.delete(key);

    playbackMarkers.set(markerKey, {
      groupId: next.groupId,
      trackAlias: next.trackAlias,
      offset: Math.max(0, offset),
      publishTimestamp: next.publishTimestamp,
      receiveTimestamp: next.receiveTimestamp,
    });

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
    return;
  }

  const smallestAvailable = Math.min(...groupsForAlias);

  if (smallestAvailable > nextAppendGroup) {
    if (missingGroupSince === null) {
      missingGroupSince = performance.now();

      log(
        "warn",
        `Missing group ${nextAppendGroup}; ` +
          `next available=${smallestAvailable}. Waiting ${GAP_WAIT_MS}ms`,
      );

      missingGroupTimer = setTimeout(() => {
        missingGroupTimer = null;
        appendNextSegment();
      }, GAP_WAIT_MS);

      return;
    }

    const waited = performance.now() - missingGroupSince;

    if (waited >= GAP_WAIT_MS) {
      const missingGroups = smallestAvailable - nextAppendGroup;

      log(
        "warn",
        `Skipping ${missingGroups} missing group(s): ` +
          `expected=${nextAppendGroup}, available=${smallestAvailable}`,
      );

      // Close the MSE timeline gap so playback can continue immediately.
      timelineOffset -= missingGroups * SEGMENT_DURATION_SECONDS;

      nextAppendGroup = smallestAvailable;
      missingGroupSince = null;

      if (missingGroupTimer !== null) {
        clearTimeout(missingGroupTimer);
        missingGroupTimer = null;
      }

      appendNextSegment();
      return;
    }

    return;
  }
}

export function setActiveAlias(alias) {
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
      const newestGroup = Math.max(...groups);
      for (const [key, obj] of pendingGroups) {
        if (obj.trackAlias === alias && obj.groupId < newestGroup) {
          pendingGroups.delete(key);
        }
      }

      nextAppendGroup = newestGroup;

      firstGroupId = newestGroup;
    } else {
      nextAppendGroup = null;
      firstGroupId = null;
    }
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

export function getCurrentBufferSeconds() {
  return getContiguousBufferAhead();
}
