import { experimentState } from "./state.js";
import { getElapsedSeconds, isExperimentRunning } from "./time.js";

export function addBufferSample(bufferSeconds) {
  if (!isExperimentRunning()) {
    return;
  }

  if (!Number.isFinite(bufferSeconds) || bufferSeconds < 0) {
    return;
  }

  experimentState.latestBufferSeconds = bufferSeconds;
  experimentState.bufferSamples.push({
    elapsedSeconds: getElapsedSeconds(),
    timestamp: Date.now(),
    quality: experimentState.quality,
    bufferSeconds,
  });
}
