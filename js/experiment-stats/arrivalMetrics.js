import { experimentState } from "./state.js";
import { getElapsedSeconds, isExperimentRunning } from "./time.js";

const ALPHA = 0.7;

let previousReceiveTime = null;
let smoothedInterArrivalMs = null;

export function calculateInterArrival(receiveTime) {
  if (previousReceiveTime === null) {
    previousReceiveTime = receiveTime;
    return null;
  }


  const interArrivalMs = receiveTime - previousReceiveTime;
  previousReceiveTime = receiveTime;

  if (smoothedInterArrivalMs === null) {
  smoothedInterArrivalMs = (1 - ALPHA) * interArrivalMs;
  } else {
    smoothedInterArrivalMs =
      ALPHA * smoothedInterArrivalMs +
      (1 - ALPHA) * interArrivalMs;
  }

  return {
    interArrivalMs,
    smoothedInterArrivalMs,
  };
}

export function addInterArrivalSample({
  groupId,
  objectId,
  trackAlias,
  interArrivalMs,
  smoothedInterArrivalMs,
}) {
  if (!isExperimentRunning()) {
    return;
  }

  if (!Number.isFinite(interArrivalMs)) {
    return;
  }

  experimentState.interArrivalSamples.push({
    elapsedSeconds: getElapsedSeconds(),
    timestamp: Date.now(),
    quality: experimentState.quality,
    groupId,
    objectId,
    trackAlias,
    interArrivalMs,
    smoothedInterArrivalMs,
  });
}

export function resetArrivalMetrics() {
  previousReceiveTime = null;
  smoothedInterArrivalMs = null;
}