import { log } from "./logger.js";
let mediaSource = null;
let sourceBuffer = null; // browser buffer
let mseReady = false;

let firstGroupId = null; //temp

let pendingGroups = new Map(); // used for store received groups in the right order
let nextAppendGroup = null;

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
export function handlePayload(trackAlias, groupId, objectId, payload) {
  pendingGroups.set(groupId, { groupId, objectId, payload });

  log("debug", `Stored pending g=${groupId} pending=${pendingGroups.size}`);

  if (nextAppendGroup === null) {
    nextAppendGroup = groupId;
    firstGroupId = groupId;
    log("debug", `Start append order from g=${groupId}`);
  }

  appendNextSegment();
}
export function appendNextSegment() {
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
