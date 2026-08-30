import { log } from "../logger.js";
import { calculateLatencyMeanBlocks } from "./aggregates.js";
import { experimentState } from "./state.js";
import { escapeCsvValue, round } from "./utils.js";

const CSV_HEADERS = [
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
  "group_id",
  "track_alias",
  "inter_arrival_ms",
  "smoothed_inter_arrival_ms",
];

export function exportExperimentCsv() {
  if (experimentState.startedAt === null) {
    log("warn", "Cannot export: no experiment data available");
    return;
  }

  const rows = [
    ...createLatencyRows(),
    ...createBufferRows(),
    ...createStallRows(),
    ...createMeanRows(),
    ...createInterArrivalRows(),
  ]
    .sort((first, second) => first.elapsedSeconds - second.elapsedSeconds)
    .map((row) => row.values);

  validateRows(rows);

  const csv = [
    CSV_HEADERS.join(","),
    ...rows.map((row) => row.map(escapeCsvValue).join(",")),
  ].join("\n");

  downloadCsv(csv);

  log(
    "info",
    `Exported ${experimentState.latencySamples.length} latency samples, ` +
      `${experimentState.bufferSamples.length} buffer samples, ` +
      `${experimentState.stallEvents.length} stall events and ` +
      `${experimentState.interArrivalSamples.length} inter-arrival samples`,
  );
}

function createLatencyRows() {
  return experimentState.latencySamples.map((sample) =>
    csvRow(sample.elapsedSeconds, [
      round(sample.elapsedSeconds, 3),
      new Date(sample.timestamp).toISOString(),
      "latency_sample",
      sample.quality,
      uploadLimit(),

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

      null, //group id
      null, //track alias
      null, //inter arrival
      null, //smoothed
    ]),
  );
}

function createBufferRows() {
  return experimentState.bufferSamples.map((sample) =>
    csvRow(sample.elapsedSeconds, [
      round(sample.elapsedSeconds, 3),
      new Date(sample.timestamp).toISOString(),
      "buffer_sample",
      sample.quality,
      uploadLimit(),

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

      false,
      null,
      null,

      null,
      null,
      null,
      null,
    ]),
  );
}

function createStallRows() {
  return experimentState.stallEvents.map((event) =>
    csvRow(event.elapsedSeconds, [
      round(event.elapsedSeconds, 3),
      new Date(event.timestamp).toISOString(),
      event.type,
      event.quality,
      uploadLimit(),

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

      null,
      null,
      null,
      null,
    ]),
  );
}

function createMeanRows() {
  return calculateLatencyMeanBlocks().flatMap((block) => {
    const valuesAt = (elapsedSeconds) =>
      csvRow(elapsedSeconds, [
        round(elapsedSeconds, 3),
        "",
        "latency_10s_mean",
        experimentState.quality,
        uploadLimit(),

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
        null,
        null,
        null,
      ]);

    return [valuesAt(block.startSeconds), valuesAt(block.plotEndSeconds)];
  });
}

function createInterArrivalRows() {
  return experimentState.interArrivalSamples.map((sample) =>
    csvRow(sample.elapsedSeconds, [
      round(sample.elapsedSeconds, 3),
      new Date(sample.timestamp).toISOString(),
      "inter_arrival_sample",
      sample.quality,
      uploadLimit(),

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

      false,
      null,
      null,

      sample.groupId,
      sample.trackAlias,
      round(sample.interArrivalMs, 3),
      round(sample.smoothedInterArrivalMs, 3),
    ]),
  );
}

function csvRow(elapsedSeconds, values) {
  return {
    elapsedSeconds,
    values,
  };
}

function uploadLimit() {
  return experimentState.uploadLimitMbps ?? "unlimited";
}

function validateRows(rows) {
  for (const row of rows) {
    if (row.length !== CSV_HEADERS.length) {
      console.error(
        "CSV column mismatch:",
        `row=${row.length}`,
        `headers=${CSV_HEADERS.length}`,
        row,
      );
    }
  }
}

function downloadCsv(csv) {
  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8",
  });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  const safeQuality = experimentState.quality.replaceAll(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );

  anchor.href = url;
  anchor.download = `experiment_${safeQuality}_${Date.now()}.csv`;

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(url);
}