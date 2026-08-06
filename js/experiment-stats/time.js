import { experimentState } from "./state.js";

export function getElapsedSeconds(now = Date.now()) {
  if (experimentState.startedAt === null) {
    return 0;
  }

  return (now - experimentState.startedAt) / 1000;
}

export function isExperimentRunning() {
  return (
    experimentState.startedAt !== null && experimentState.finishedAt === null
  );
}

export function getMeasurementEndSeconds(now = Date.now()) {
  if (experimentState.startedAt === null) {
    return 0;
  }

  const endTime = experimentState.finishedAt ?? now;
  return (endTime - experimentState.startedAt) / 1000;
}
