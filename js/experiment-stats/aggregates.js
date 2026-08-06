import { FIXED_MEAN_WINDOW_SECONDS } from "./config.js";
import { experimentState } from "./state.js";
import { getMeasurementEndSeconds } from "./time.js";

export function calculateLatencyMeanBlocks() {
  const blocks = new Map();
  const measurementEndSeconds = getMeasurementEndSeconds();

  for (const sample of experimentState.latencySamples) {
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
