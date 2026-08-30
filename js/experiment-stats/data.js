import { calculateLatencyMeanBlocks } from "./aggregates.js";
import { experimentState } from "./state.js";
import { round } from "./utils.js";

export function getRollingAverageLatency() {
  const values = experimentState.abrLatencyWindow;

  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function getLatestMetrics() {
  return {
    quality: experimentState.quality,
    e2eLatencyMs: experimentState.latestE2ELatency,
    playerLatencyMs: experimentState.latestPlayerLatency,
    bufferSeconds: experimentState.latestBufferSeconds,
    rollingAverageE2EMs: getRollingAverageLatency(),
    stallActive: experimentState.currentStallStartedAt !== null,
    stallCount: experimentState.stallCount,
    totalStallDurationMs: experimentState.totalStallDurationMs,
  };
}

export function getLatencySamples() {
  return [...experimentState.latencySamples];
}

export function getBufferSamples() {
  return [...experimentState.bufferSamples];
}

export function getStallEvents() {
  return [...experimentState.stallEvents];
}

export function getLatencyMeanBlocks() {
  return calculateLatencyMeanBlocks();
}

export function getExperimentData() {
  const endTime = experimentState.finishedAt ?? Date.now();
  const durationSeconds =
    experimentState.startedAt === null
      ? 0
      : (endTime - experimentState.startedAt) / 1000;

  return {
    quality: experimentState.quality,
    uploadLimitMbps: experimentState.uploadLimitMbps ?? "unlimited",
    durationSeconds: round(durationSeconds, 2),
    latencySamples: getLatencySamples(),
    latencyMeanBlocks: getLatencyMeanBlocks(),
    bufferSamples: getBufferSamples(),
    stallEvents: getStallEvents(),
    stallCount: experimentState.stallCount,
    totalStallDurationMs: round(experimentState.totalStallDurationMs),
  };
}
