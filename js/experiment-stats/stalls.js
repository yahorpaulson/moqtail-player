import { log } from "../logger.js";
import { experimentState } from "./state.js";
import { getElapsedSeconds, isExperimentRunning } from "./time.js";

export function startStall() {
  if (!isExperimentRunning() || experimentState.currentStallStartedAt !== null) {
    return;
  }

  experimentState.currentStallStartedAt = performance.now();
  experimentState.stallCount++;

  const event = {
    type: "stall_start",
    elapsedSeconds: getElapsedSeconds(),
    timestamp: Date.now(),
    quality: experimentState.quality,
    stallNumber: experimentState.stallCount,
    durationMs: null,
  };

  experimentState.stallEvents.push(event);

  log(
    "warn",
    `STALL START count=${experimentState.stallCount} ` +
      `time=${event.elapsedSeconds.toFixed(3)}s`,
  );
}

export function endStall() {
  if (experimentState.currentStallStartedAt === null) {
    return;
  }

  const durationMs =
    performance.now() - experimentState.currentStallStartedAt;

  experimentState.totalStallDurationMs += durationMs;
  experimentState.currentStallStartedAt = null;

  const event = {
    type: "stall_end",
    elapsedSeconds: getElapsedSeconds(),
    timestamp: Date.now(),
    quality: experimentState.quality,
    stallNumber: experimentState.stallCount,
    durationMs,
  };

  experimentState.stallEvents.push(event);

  log(
    "warn",
    `STALL END duration=${durationMs.toFixed(0)}ms ` +
      `time=${event.elapsedSeconds.toFixed(3)}s ` +
      `total=${experimentState.totalStallDurationMs.toFixed(0)}ms`,
  );
}
