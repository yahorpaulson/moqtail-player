import { log } from "./logger.js";

const MAX_ABR_SAMPLES = 10;
const LATENCY_DROP_THRESHOLD_MS = 300;
const FIXED_MEAN_WINDOW_SECONDS = 10;

let experimentStartedAt = null;
let experimentFinishedAt = null;

let currentQuality = "unknown";
let configuredUploadLimitMbps = null;

let latencySamples = [];
let bufferSamples = [];
let abrLatencyWindow = [];
let stallEvents = [];

let stallCount = 0;
let totalStallDurationMs = 0;
let currentStallStartedAt = null;

let latestE2ELatency = null;
let latestPlayerLatency = null;
let latestBufferSeconds = null;

/*
 * General helper functions
 */

function round(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }

  const factor = 10 ** digits;

  return Math.round(value * factor) / factor;
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);

  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function getElapsedSeconds() {
  if (experimentStartedAt === null) {
    return 0;
  }

  return (Date.now() - experimentStartedAt) / 1000;
}

function isExperimentRunning() {
  return experimentStartedAt !== null && experimentFinishedAt === null;
}

/*
 * Calculate independent, fixed latency windows:
 * 0-10 seconds, 10-20 seconds, 20-30 seconds, etc.
 *
 * This is intentionally different from abrLatencyWindow, which is a moving
 * window containing the latest samples and is used by the ABR algorithm.
 */
function calculateLatencyMeanBlocks() {
  const blocks = new Map();
  const measurementEndSeconds =
    experimentStartedAt === null
      ? 0
      : ((experimentFinishedAt ?? Date.now()) - experimentStartedAt) / 1000;

  for (const sample of latencySamples) {
    const blockIndex = Math.floor(
      sample.elapsedSeconds / FIXED_MEAN_WINDOW_SECONDS,
    );

    if (!blocks.has(blockIndex)) {
      blocks.set(blockIndex, {
        blockIndex,
        startSeconds: blockIndex * FIXED_MEAN_WINDOW_SECONDS,
        endSeconds: (blockIndex + 1) * FIXED_MEAN_WINDOW_SECONDS,
        e2eSumMs: 0,
        e2eSampleCount: 0,
        playerSumMs: 0,
        playerSampleCount: 0,
      });
    }

    const block = blocks.get(blockIndex);

    if (Number.isFinite(sample.e2eLatencyMs)) {
      block.e2eSumMs += sample.e2eLatencyMs;
      block.e2eSampleCount++;
    }

    if (Number.isFinite(sample.playerLatencyMs)) {
      block.playerSumMs += sample.playerLatencyMs;
      block.playerSampleCount++;
    }
  }

  return [...blocks.values()]
    .sort((first, second) => first.blockIndex - second.blockIndex)
    .map((block) => ({
      startSeconds: block.startSeconds,
      endSeconds: block.endSeconds,
      plotEndSeconds: Math.min(block.endSeconds, measurementEndSeconds),

      meanE2ELatencyMs:
        block.e2eSampleCount > 0 ? block.e2eSumMs / block.e2eSampleCount : null,

      meanPlayerLatencyMs:
        block.playerSampleCount > 0
          ? block.playerSumMs / block.playerSampleCount
          : null,

      e2eSampleCount: block.e2eSampleCount,
      playerSampleCount: block.playerSampleCount,
    }));
}

/*
 * Experiment control
 */

export function resetExperimentStats() {
  experimentStartedAt = null;
  experimentFinishedAt = null;

  latencySamples = [];
  bufferSamples = [];
  abrLatencyWindow = [];
  stallEvents = [];

  stallCount = 0;
  totalStallDurationMs = 0;
  currentStallStartedAt = null;

  latestE2ELatency = null;
  latestPlayerLatency = null;
  latestBufferSeconds = null;

  log("info", "Experiment statistics reset");
}

export function startExperiment({
  quality = "unknown",
  uploadLimitMbps = null,
} = {}) {
  resetExperimentStats();

  currentQuality = quality || "unknown";
  configuredUploadLimitMbps = uploadLimitMbps;

  experimentStartedAt = Date.now();
  experimentFinishedAt = null;

  log(
    "info",
    `Experiment started quality=${currentQuality} ` +
      `uploadLimit=${configuredUploadLimitMbps ?? "unlimited"} Mbps`,
  );
}

export function stopExperiment() {
  if (!isExperimentRunning()) {
    log("warn", "Cannot stop experiment: no experiment is running");

    return null;
  }

  /*
   * If playback is currently stalled, finish the stall
   * before finishing the experiment.
   */
  if (currentStallStartedAt !== null) {
    endStall();
  }

  experimentFinishedAt = Date.now();

  const result = getExperimentData();

  log(
    "info",
    `Experiment finished ` +
      `duration=${result.durationSeconds}s ` +
      `quality=${result.quality} ` +
      `latencySamples=${latencySamples.length} ` +
      `stallCount=${stallCount}`,
  );

  console.log(result);

  return result;
}

export function setExperimentQuality(quality) {
  currentQuality = quality || "unknown";
}

export function setUploadLimitMbps(uploadLimitMbps) {
  configuredUploadLimitMbps = uploadLimitMbps;
}

/*
 * Latency measurements
 */

export function addLatencySample({ e2eLatencyMs, playerLatencyMs }) {
  /*
   * Do not collect measurements before Start measurement
   * or after Stop measurement.
   */
  if (!isExperimentRunning()) {
    return;
  }

  const validE2E = Number.isFinite(e2eLatencyMs) && e2eLatencyMs >= 0;

  const validPlayer = Number.isFinite(playerLatencyMs) && playerLatencyMs >= 0;

  if (!validE2E && !validPlayer) {
    return;
  }

  if (validE2E) {
    latestE2ELatency = e2eLatencyMs;

    /*
     * Keep only the latest values for the ABR algorithm.
     */
    abrLatencyWindow.push(e2eLatencyMs);

    if (abrLatencyWindow.length > MAX_ABR_SAMPLES) {
      abrLatencyWindow.shift();
    }
  }

  if (validPlayer) {
    latestPlayerLatency = playerLatencyMs;
  }

  /*
   * Compare the current E2E latency with the previous
   * recorded E2E latency.
   */
  const previousSample =
    latencySamples.length > 0
      ? latencySamples[latencySamples.length - 1]
      : null;

  let e2eLatencyChangeMs = null;
  let significantLatencyDrop = false;

  if (
    validE2E &&
    previousSample !== null &&
    Number.isFinite(previousSample.e2eLatencyMs)
  ) {
    e2eLatencyChangeMs = e2eLatencyMs - previousSample.e2eLatencyMs;

    significantLatencyDrop = e2eLatencyChangeMs <= -LATENCY_DROP_THRESHOLD_MS;
  }

  const sample = {
    elapsedSeconds: getElapsedSeconds(),
    timestamp: Date.now(),

    quality: currentQuality,

    e2eLatencyMs: validE2E ? e2eLatencyMs : null,

    playerLatencyMs: validPlayer ? playerLatencyMs : null,

    e2eLatencyChangeMs,
    significantLatencyDrop,

    stallActive: currentStallStartedAt !== null,

    stallCount,
  };

  latencySamples.push(sample);

  if (significantLatencyDrop) {
    log(
      "warn",
      `SIGNIFICANT LATENCY DROP ` +
        `change=${round(e2eLatencyChangeMs)}ms ` +
        `latency=${round(e2eLatencyMs)}ms ` +
        `time=${sample.elapsedSeconds.toFixed(3)}s`,
    );
  }
}

/*
 * Buffer measurements
 */

export function addBufferSample(bufferSeconds) {
  if (!isExperimentRunning()) {
    return;
  }

  if (!Number.isFinite(bufferSeconds) || bufferSeconds < 0) {
    return;
  }

  latestBufferSeconds = bufferSeconds;

  bufferSamples.push({
    elapsedSeconds: getElapsedSeconds(),
    timestamp: Date.now(),
    quality: currentQuality,
    bufferSeconds,
  });
}

/*
 * Stall measurements
 */

export function startStall() {
  if (!isExperimentRunning()) {
    return;
  }

  /*
   * Do not start the same stall more than once.
   */
  if (currentStallStartedAt !== null) {
    return;
  }

  currentStallStartedAt = performance.now();
  stallCount++;

  const event = {
    type: "stall_start",
    elapsedSeconds: getElapsedSeconds(),
    timestamp: Date.now(),
    quality: currentQuality,
    stallNumber: stallCount,
    durationMs: null,
  };

  stallEvents.push(event);

  log(
    "warn",
    `STALL START ` +
      `count=${stallCount} ` +
      `time=${event.elapsedSeconds.toFixed(3)}s`,
  );
}

export function endStall() {
  if (currentStallStartedAt === null) {
    return;
  }

  const durationMs = performance.now() - currentStallStartedAt;

  totalStallDurationMs += durationMs;
  currentStallStartedAt = null;

  const event = {
    type: "stall_end",
    elapsedSeconds: getElapsedSeconds(),
    timestamp: Date.now(),
    quality: currentQuality,
    stallNumber: stallCount,
    durationMs,
  };

  stallEvents.push(event);

  log(
    "warn",
    `STALL END ` +
      `duration=${durationMs.toFixed(0)}ms ` +
      `time=${event.elapsedSeconds.toFixed(3)}s ` +
      `total=${totalStallDurationMs.toFixed(0)}ms`,
  );
}

/*
 * Current values
 */

export function getRollingAverageLatency() {
  if (abrLatencyWindow.length === 0) {
    return null;
  }

  const sum = abrLatencyWindow.reduce((total, value) => total + value, 0);

  return sum / abrLatencyWindow.length;
}

export function getLatestMetrics() {
  return {
    quality: currentQuality,

    e2eLatencyMs: latestE2ELatency,
    playerLatencyMs: latestPlayerLatency,
    bufferSeconds: latestBufferSeconds,

    rollingAverageE2EMs: getRollingAverageLatency(),

    stallActive: currentStallStartedAt !== null,

    stallCount,
    totalStallDurationMs,
  };
}

/*
 * Collected data
 */

export function getLatencySamples() {
  return [...latencySamples];
}

export function getBufferSamples() {
  return [...bufferSamples];
}

export function getStallEvents() {
  return [...stallEvents];
}

export function getLatencyMeanBlocks() {
  return calculateLatencyMeanBlocks();
}

export function getExperimentData() {
  const endTime = experimentFinishedAt ?? Date.now();

  const durationSeconds =
    experimentStartedAt === null ? 0 : (endTime - experimentStartedAt) / 1000;

  return {
    quality: currentQuality,

    uploadLimitMbps: configuredUploadLimitMbps ?? "unlimited",

    durationSeconds: round(durationSeconds, 2),

    latencySamples: getLatencySamples(),
    latencyMeanBlocks: getLatencyMeanBlocks(),
    bufferSamples: getBufferSamples(),
    stallEvents: getStallEvents(),

    stallCount,

    totalStallDurationMs: round(totalStallDurationMs),
  };
}

/*
 * CSV export
 */

export function exportExperimentCsv() {
  if (experimentStartedAt === null) {
    log("warn", "Cannot export: no experiment data available");

    return;
  }

  const headers = [
    "elapsed_seconds",
    "timestamp",
    "event_type",
    "quality",
    "upload_limit_mbps",
    "e2e_latency_ms",
    "player_latency_ms",
    "mean_10s_e2e_latency_ms",
    "mean_10s_player_latency_ms",
    "mean_block_start_seconds",
    "mean_block_end_seconds",
    "mean_block_e2e_samples",
    "mean_block_player_samples",
    "e2e_latency_change_ms",
    "significant_latency_drop",
    "buffer_seconds",
    "stall_active",
    "stall_number",
    "stall_duration_ms",
  ];

  /*
   * Convert latency measurements into CSV rows.
   */
  const latencyRows = latencySamples.map((sample) => ({
    elapsedSeconds: sample.elapsedSeconds,

    values: [
      round(sample.elapsedSeconds, 3),
      new Date(sample.timestamp).toISOString(),
      "latency_sample",
      sample.quality,
      configuredUploadLimitMbps ?? "unlimited",

      round(sample.e2eLatencyMs),
      round(sample.playerLatencyMs),

      null,
      null,
      null,
      null,
      null,
      null,

      round(sample.e2eLatencyChangeMs),

      sample.significantLatencyDrop,

      null,

      sample.stallActive,
      sample.stallCount,
      null,
    ],
  }));

  /*
   * Convert buffer measurements into CSV rows.
   */
  const bufferRows = bufferSamples.map((sample) => ({
    elapsedSeconds: sample.elapsedSeconds,

    values: [
      round(sample.elapsedSeconds, 3),
      new Date(sample.timestamp).toISOString(),
      "buffer_sample",
      sample.quality,
      configuredUploadLimitMbps ?? "unlimited",

      null,
      null,

      null,
      null,
      null,
      null,
      null,
      null,

      null,
      false,

      round(sample.bufferSeconds, 3),

      currentStallStartedAt !== null,
      stallCount,
      null,
    ],
  }));

  /*
   * Convert stall start/end events into CSV rows.
   */
  const stallRows = stallEvents.map((event) => ({
    elapsedSeconds: event.elapsedSeconds,

    values: [
      round(event.elapsedSeconds, 3),
      new Date(event.timestamp).toISOString(),
      event.type,
      event.quality,
      configuredUploadLimitMbps ?? "unlimited",

      null,
      null,

      null,
      null,
      null,
      null,
      null,
      null,

      null,
      false,

      null,

      event.type === "stall_start",
      event.stallNumber,
      round(event.durationMs),
    ],
  }));

  /*
   * Add two points for every fixed 10-second mean block. Adjacent blocks
   * therefore have two different values at the same boundary (for example,
   * at 10 seconds), which creates the vertical part of the staircase.
   */
  const meanRows = calculateLatencyMeanBlocks().flatMap((block) => {
    const valuesAt = (elapsedSeconds) => ({
      elapsedSeconds,

      values: [
        round(elapsedSeconds, 3),
        "",
        "latency_10s_mean",
        currentQuality,
        configuredUploadLimitMbps ?? "unlimited",

        null,
        null,

        round(block.meanE2ELatencyMs),
        round(block.meanPlayerLatencyMs),
        block.startSeconds,
        block.endSeconds,
        block.e2eSampleCount,
        block.playerSampleCount,

        null,
        false,
        null,
        false,
        null,
        null,
        null,
      ],
    });

    return [valuesAt(block.startSeconds), valuesAt(block.plotEndSeconds)];
  });

  /*
   * Combine all data and sort it by experiment time.
   */
  const rows = [...latencyRows, ...bufferRows, ...stallRows, ...meanRows]
    .sort((first, second) => first.elapsedSeconds - second.elapsedSeconds)
    .map((row) => row.values);

  const csv = [
    headers.join(","),

    ...rows.map((row) => row.map(escapeCsvValue).join(",")),
  ].join("\n");

  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8",
  });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  const safeQuality = currentQuality.replaceAll(/[^a-zA-Z0-9_-]/g, "_");

  anchor.href = url;

  anchor.download = `experiment_${safeQuality}_${Date.now()}.csv`;

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(url);

  log(
    "info",
    `Exported ` +
      `${latencySamples.length} latency samples, ` +
      `${bufferSamples.length} buffer samples and ` +
      `${stallEvents.length} stall events`,
  );
}
