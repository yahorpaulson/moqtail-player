import { log } from "../logger.js";
import { getExperimentData } from "./data.js";
import { resetState, experimentState } from "./state.js";
import { endStall } from "./stalls.js";
import { isExperimentRunning } from "./time.js";
import { resetArrivalMetrics } from "./arrivalMetrics.js";

export function resetExperimentStats() {
  resetState();
  log("info", "Experiment statistics reset");
}

export function startExperiment({
  quality = "unknown",
  uploadLimitMbps = null,
} = {}) {
  resetExperimentStats();
  resetArrivalMetrics();


  experimentState.quality = quality || "unknown";
  experimentState.uploadLimitMbps = uploadLimitMbps;
  experimentState.startedAt = Date.now();

  log(
    "info",
    `Experiment started quality=${experimentState.quality} ` +
      `uploadLimit=${experimentState.uploadLimitMbps ?? "unlimited"} Mbps`,
  );
}

export function stopExperiment() {
  if (!isExperimentRunning()) {
    log("warn", "Cannot stop experiment: no experiment is running");
    return null;
  }

  if (experimentState.currentStallStartedAt !== null) {
    endStall();
  }

  experimentState.finishedAt = Date.now();
  const result = getExperimentData();

  log(
    "info",
    `Experiment finished duration=${result.durationSeconds}s ` +
      `quality=${result.quality} ` +
      `latencySamples=${experimentState.latencySamples.length} ` +
      `stallCount=${experimentState.stallCount}`,
  );

  console.log(result);
  return result;
}

export function setExperimentQuality(quality) {
  experimentState.quality = quality || "unknown";
}

export function setUploadLimitMbps(uploadLimitMbps) {
  experimentState.uploadLimitMbps = uploadLimitMbps;
}
