import { log } from "./logger.js";
let mediaSource = null;
let sourceBuffer = null; // browser buffer
let mseReady = false;

let removingOldBuffer = false;

let firstGroupId = null; //temp

let pendingGroups = new Map(); // used for store received groups in the right order
let nextAppendGroup = null;
let firstSegmentResolvers = new Map();

let activeAlias = null;
let waitingAlias = null; //to compare segments of track for switching

let timelineOffset = 0;
const MP4_TIME_SHIFT = 0.067;

let missingGroupSince = null;
const GAP_WAIT_MS = 1000;

let MAX_BUFFER_SECONDS = 15;

//Video player initialization
export function initVideoPlayer() {
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

      if (removingOldBuffer) {
        removingOldBuffer = false;
        appendNextSegment();
        return;
      }

      trimOldBuffer();

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

function trimOldBuffer() {
  if (!sourceBuffer || sourceBuffer.updating) return;

  const video = document.getElementById("videoPlayer");
  if (video.buffered.length === 0) return;

  const bufferStart = video.buffered.start(0);
  const removeEnd = video.currentTime - 1;

  if (removeEnd <= bufferStart) return;

  removingOldBuffer = true;

  log(
    "debug",
    `Trim old buffer: remove ${bufferStart.toFixed(3)}-${removeEnd.toFixed(3)}`,
  );

  sourceBuffer.remove(bufferStart, removeEnd);
}

export function handlePayload(trackAlias, groupId, objectId, payload) {
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
  });

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

  const video = document.getElementById("videoPlayer");

  const key = `${activeAlias}:${nextAppendGroup}`;
  const next = pendingGroups.get(key);

  if (!next) {
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
    return;
  }

  let bufferedAhead = 0;
  if (video.buffered.length > 0) {
    bufferedAhead =
      video.buffered.end(video.buffered.length - 1) - video.currentTime;
  }

  if (bufferedAhead > MAX_BUFFER_SECONDS) {
    log("debug", `Buffer full: ${bufferedAhead.toFixed(2)}s`);
    return;
  }

  //TODO:
  missingGroupSince = null;
  pendingGroups.delete(key);

  try {
    log(
      "debug",
      `Appending alias=${next.trackAlias} g=${next.groupId} pending=${pendingGroups.size}`,
    );

    const video = document.getElementById("videoPlayer");

    const segmentIndex = next.groupId - firstGroupId;
    const offset = timelineOffset + segmentIndex;

    sourceBuffer.timestampOffset = offset;

    log(
      "debug",
      `timestampOffset=${offset}, currentTime=${video.currentTime}, bufferedEnd=${
        video.buffered.length > 0
          ? video.buffered.end(video.buffered.length - 1)
          : 0
      }, group=${next.groupId}, firstGroup=${firstGroupId}`,
    );

    sourceBuffer.appendBuffer(next.payload);

    log(
      "debug",
      `Appended segment: alias=${next.trackAlias} g=${next.groupId} o=${next.objectId} size=${next.payload.length}`,
    );

    nextAppendGroup++;
  } catch (e) {
    log("error", `Failed to append segment: ${e.message}`);
  }
}

export function setActiveAlias(alias) {
  log("warn", `SET ACTIVE ALIAS ${alias}`);

  const video = document.getElementById("videoPlayer");
  const switchingToNewAlias = activeAlias !== alias;

  activeAlias = alias;
  waitingAlias = null;

  timelineOffset =
    video.buffered.length > 0 ? video.currentTime - MP4_TIME_SHIFT : 0;

  for (const [key, obj] of pendingGroups) {
    if (obj.trackAlias !== alias) pendingGroups.delete(key);
  }

  const groups = [...pendingGroups.values()]
    .filter((o) => o.trackAlias === alias)
    .map((o) => o.groupId);

  if (switchingToNewAlias) {
    if (groups.length > 0) {
      nextAppendGroup = Math.min(...groups);
      firstGroupId = nextAppendGroup;
    } else {
      nextAppendGroup = null;
      firstGroupId = null;
    }
  }

  log(
    "debug",
    `Switched to alias=${alias}, timelineOffset=${timelineOffset}, firstGroupId=${firstGroupId}, nextAppendGroup=${nextAppendGroup}`,
  );

  appendNextSegment();
}
