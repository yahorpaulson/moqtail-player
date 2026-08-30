import { log } from "../logger.js";
import {
  LATENCY_DROP_THRESHOLD_MS,
  MAX_ABR_SAMPLES,
} from "./config.js";
import { experimentState } from "./state.js";
import { getElapsedSeconds, isExperimentRunning } from "./time.js";
import { round } from "./utils.js";

export function addLatencySample({ e2eLatencyMs, playerLatencyMs }) {
  if (!isExperimentRunning()) {
    return;
  }

  const validE2E = Number.isFinite(e2eLatencyMs) && e2eLatencyMs >= 0;
  const validPlayer =
    Number.isFinite(playerLatencyMs) && playerLatencyMs >= 0;

  if (!validE2E && !validPlayer) {
    return;
  }

  updateLatestLatencies({
    e2eLatencyMs: validE2E ? e2eLatencyMs : null,
    playerLatencyMs: validPlayer ? playerLatencyMs : null,
  });

  const previousSample = experimentState.latencySamples.at(-1) ?? null;
  const drop = calculateLatencyDrop(e2eLatencyMs, validE2E, previousSample);

  const sample = {
    elapsedSeconds: getElapsedSeconds(),
    timestamp: Date.now(),
    quality: experimentState.quality,
    e2eLatencyMs: validE2E ? e2eLatencyMs : null,
    playerLatencyMs: validPlayer ? playerLatencyMs : null,
    e2eLatencyChangeMs: drop.changeMs,
    significantLatencyDrop: drop.significant,
    stallActive: experimentState.currentStallStartedAt !== null,
    stallCount: experimentState.stallCount,
  };

  experimentState.latencySamples.push(sample);

  if (drop.significant) {
    log(
      "warn",
      `SIGNIFICANT LATENCY DROP ` +
        `change=${round(drop.changeMs)}ms ` +
        `latency=${round(e2eLatencyMs)}ms ` +
        `time=${sample.elapsedSeconds.toFixed(3)}s`,
    );
  }
}

function updateLatestLatencies({ e2eLatencyMs, playerLatencyMs }) {
  if (e2eLatencyMs !== null) {
    experimentState.latestE2ELatency = e2eLatencyMs;
    experimentState.abrLatencyWindow.push(e2eLatencyMs);

    if (experimentState.abrLatencyWindow.length > MAX_ABR_SAMPLES) {
      experimentState.abrLatencyWindow.shift();
    }
  }

  if (playerLatencyMs !== null) {
    experimentState.latestPlayerLatency = playerLatencyMs;
  }
}

function calculateLatencyDrop(e2eLatencyMs, validE2E, previousSample) {
  if (
    !validE2E ||
    previousSample === null ||
    !Number.isFinite(previousSample.e2eLatencyMs)
  ) {
    return { changeMs: null, significant: false };
  }

  const changeMs = e2eLatencyMs - previousSample.e2eLatencyMs;

  return {
    changeMs,
    significant: changeMs <= -LATENCY_DROP_THRESHOLD_MS,
  };
}
