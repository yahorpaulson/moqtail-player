
heute 11:31
2c842096-c148-427b-9d29-39d0cb058566.png
so we have stats where every second of a video is calculated
I need to have also mean value every 10 secs to have staired graphic

I skizzed the way how it should be


Pasted code(59).js
JavaScript

heute 13:39
I wanted it like stairs constant mean value in 10 sec

1080p(1)

Visualisierung konnte nicht angezeigt werden

3m 38s nachgedacht
Exactly. The finished analyser.py displays:

blue line: actual E2E latency measurements over time, as before;

orange stairs: mean E2E latency calculated independently for every fixed 10-second interval;

background shading: playback stalls.

It calculates everything directly from the ordinary latency_sample rows. No precomputed mean columns are required.

Run:

python analyser.py 1080p.csv --show
For a different block duration:

python analyser.py 1080p.csv --mean-window 20 --show

6f25ac3b-3830-48f6-ac29-515718dc9ee0.png
but where is for every second like here

The analyser already plots every available actual measurement in blue. The problem is the new 1080p(1).csv contains only 14 latency_sample rows, not one per second.

They occur approximately at:

4.7, 9.7, 14.7, 19.7, ... 64.7 seconds
So latency is currently recorded about once every 5 seconds. Your older graph had 97 latency samples, which is why the blue line showed behaviour almost every second.

The analyser cannot calculate real per-second behaviour when those measurements are absent. Interpolation would create artificial values and should not be presented as measured latency.

You need both:

Player/statistics collector: call addLatencySample(...) once per second.

analyser.py: plot every collected value in blue and independently calculate the orange 10-second block means.

So the missing per-second line must be fixed where addLatencySample() is called in your player, not inside analyser.py. Send me that part of videoBuffer.js or the file containing the addLatencySample(...) call, and I’ll change its measurement interval to exactly one second.



Pasted code(60).js
JavaScript

Pasted code (2).js
JavaScript

1m 15s nachgedacht
Updated Pasted code(60).js.

The resulting graph will contain:

blue line: one actual playback-latency measurement every second;

orange stairs: one mean calculated by analyser.py for every fixed 10-second block;

stall background: unchanged.

The previous code already ran every second, but saved a value only when playback reached a new segment. Now it keeps measuring the currently played segment—including while playback is stalled.

You’ll need to perform a new experiment and export a new CSV. The existing 1080p(1).csv cannot gain the missing measurements retroactively.



Pasted code(60).js


import { log } from "./logger.js";
import {
  addLatencySample,
  addBufferSample,
  startStall,
  endStall,
} from "./statsCollector.js";

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

let waitingTimer = null;

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
    //trimOldBuffer();

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

  let bufferSeconds = 0;

  if (video.buffered.length > 0) {
    const bufferedEnd = video.buffered.end(video.buffered.length - 1);

    bufferSeconds = Math.max(0, bufferedEnd - video.currentTime);
  }

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

    if (
      currentMarker === null ||
      marker.offset > currentMarker.offset
    ) {
      currentMarkerKey = markerKey;
      currentMarker = marker;
    }
  }

  if (currentMarker === null) {
    return;
  }

  const now = Date.now();

  const playerLatency = now - currentMarker.receiveTimestamp;
  const endToEndLatency = now - currentMarker.publishTimestamp;

  updateLatencyOverlay(playerLatency);
  updateEndToEndLatencyOverlay(endToEndLatency);

  /*
   * Exactly one latency_sample row is added on every 1-second timer tick.
   */
  addLatencySample({
    e2eLatencyMs: endToEndLatency,
    playerLatencyMs: playerLatency,
  });

  log(
    "info",
    `METRIC alias=${currentMarker.trackAlias} ` +
      `group=${currentMarker.groupId} ` +
      `player=${playerLatency}ms ` +
      `e2e=${endToEndLatency}ms ` +
      `buffer=${bufferSeconds.toFixed(3)}s`,
  );

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

    const markerKey = `${next.trackAlias}:${next.groupId}`;

    sourceBuffer.timestampOffset = offset;

    playbackMarkers.set(markerKey, {
      groupId: next.groupId,
      trackAlias: next.trackAlias,
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
Pasted code(60).js


import { log } from "./logger.js";
import {
  addLatencySample,
  addBufferSample,
  startStall,
  endStall,
} from "./statsCollector.js";

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

let waitingTimer = null;

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
    //trimOldBuffer();

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

  let bufferSeconds = 0;

  if (video.buffered.length > 0) {
    const bufferedEnd = video.buffered.end(video.buffered.length - 1);

    bufferSeconds = Math.max(0, bufferedEnd - video.currentTime);
  }

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

    if (
      currentMarker === null ||
      marker.offset > currentMarker.offset
    ) {
      currentMarkerKey = markerKey;
      currentMarker = marker;
    }
  }

  if (currentMarker === null) {
    return;
  }

  const now = Date.now();

  const playerLatency = now - currentMarker.receiveTimestamp;
  const endToEndLatency = now - currentMarker.publishTimestamp;

  updateLatencyOverlay(playerLatency);
  updateEndToEndLatencyOverlay(endToEndLatency);

  /*
   * Exactly one latency_sample row is added on every 1-second timer tick.
   */
  addLatencySample({
    e2eLatencyMs: endToEndLatency,
    playerLatencyMs: playerLatency,
  });

  log(
    "info",
    `METRIC alias=${currentMarker.trackAlias} ` +
      `group=${currentMarker.groupId} ` +
      `player=${playerLatency}ms ` +
      `e2e=${endToEndLatency}ms ` +
      `buffer=${bufferSeconds.toFixed(3)}s`,
  );

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

    const markerKey = `${next.trackAlias}:${next.groupId}`;

    sourceBuffer.timestampOffset = offset;

    playbackMarkers.set(markerKey, {
      groupId: next.groupId,
      trackAlias: next.trackAlias,
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
