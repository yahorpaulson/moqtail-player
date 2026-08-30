// Public facade. Existing imports can continue to use this file.
export {
  resetExperimentStats,
  setExperimentQuality,
  setUploadLimitMbps,
  startExperiment,
  stopExperiment,
} from "./experiment-stats/experiment.js";

export { addLatencySample } from "./experiment-stats/latency.js";
export { addBufferSample } from "./experiment-stats/buffer.js";
export { startStall, endStall } from "./experiment-stats/stalls.js";

export {
  getBufferSamples,
  getExperimentData,
  getLatencyMeanBlocks,
  getLatencySamples,
  getLatestMetrics,
  getRollingAverageLatency,
  getStallEvents,
} from "./experiment-stats/data.js";

export { exportExperimentCsv } from "./experiment-stats/csv.js";
