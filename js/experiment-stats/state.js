export const experimentState = {
  startedAt: null,
  finishedAt: null,

  quality: "unknown",
  uploadLimitMbps: null,

  latencySamples: [],
  bufferSamples: [],
  abrLatencyWindow: [],
  stallEvents: [],
  interArrivalSamples: [],

  stallCount: 0,
  totalStallDurationMs: 0,
  currentStallStartedAt: null,

  latestE2ELatency: null,
  latestPlayerLatency: null,
  latestBufferSeconds: null,
};

export function resetState() {
  experimentState.startedAt = null;
  experimentState.finishedAt = null;

  experimentState.quality = "unknown";
  experimentState.uploadLimitMbps = null;

  experimentState.latencySamples = [];
  experimentState.bufferSamples = [];
  experimentState.abrLatencyWindow = [];
  experimentState.stallEvents = [];

  experimentState.stallCount = 0;
  experimentState.totalStallDurationMs = 0;
  experimentState.currentStallStartedAt = null;

  experimentState.latestE2ELatency = null;
  experimentState.latestPlayerLatency = null;
  experimentState.latestBufferSeconds = null;

  experimentState.interArrivalSamples = [];
}
