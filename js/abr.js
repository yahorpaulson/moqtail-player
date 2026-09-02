const REPRESENTATIONS = [
  { name: "360p", bitrateMbps: 1.2 },
  { name: "480p", bitrateMbps: 2.5 },
  { name: "720p", bitrateMbps: 6 },
  { name: "1080p", bitrateMbps: 8 },
  { name: "1440p", bitrateMbps: 12 },
];

const THROUGHPUT_WINDOW = 7;
const SAFETY_FACTOR = 0.85;

const CRITICAL_BUFFER_SECONDS = 0.3;
const EMERGENCY_STEP_BUFFER_SECONDS = 0.5;

//not relevant, keep low
const BUFFER_REQUIRED_FOR_UP = 0.5;

const REQUIRED_UP_DECISIONS = 6;
const REQUIRED_DOWN_DECISIONS = 5;

const ABR_SWITCH_INTERVAL_MS = 10000;
const EMERGENCY_SWITCH_INTERVAL_MS = 5000;

//not relevant, keep low
const BUFFER_PROTECT_DOWN_SECONDS = 1;

const throughputHistory = [];

let pendingQuality = null;
let pendingCount = 0;
let lastAbrSwitchTime = 0;
let lastEmergencySwitchTime = 0;

function getMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function getQualityIndex(quality) {
  return REPRESENTATIONS.findIndex(
    (representation) => representation.name === quality,
  );
}

function rememberDecision(quality) {
  if (pendingQuality === quality) {
    pendingCount++;
  } else {
    pendingQuality = quality;
    pendingCount = 1;
  }

  return pendingCount;
}

function resetPendingDecision() {
  pendingQuality = null;
  pendingCount = 0;
}

export function canApplyAbrSwitch(now = Date.now()) {
  return now - lastAbrSwitchTime >= ABR_SWITCH_INTERVAL_MS;
}

export function markAbrSwitchCompleted(now = Date.now()) {
  lastAbrSwitchTime = now;
}

export function chooseEmergencyQuality({
  bufferSeconds,
  currentQuality,
  now = Date.now(),
}) {
  if (!Number.isFinite(bufferSeconds)) {
    return null;
  }

  if (now - lastEmergencySwitchTime < EMERGENCY_SWITCH_INTERVAL_MS) {
    return null;
  }

  const currentIndex = getQualityIndex(currentQuality);

  if (currentIndex <= 0) {
    return null;
  }

  let selectedQuality = null;

  if (bufferSeconds < CRITICAL_BUFFER_SECONDS) {
    selectedQuality = "360p";
  } else if (bufferSeconds < EMERGENCY_STEP_BUFFER_SECONDS) {
    selectedQuality = REPRESENTATIONS[currentIndex - 1].name;
  }

  if (!selectedQuality) {
    return null;
  }

  lastEmergencySwitchTime = now;
  resetPendingDecision();

  return selectedQuality;
}

export function chooseQuality({
  throughputMbps,
  bufferSeconds,
  currentQuality,
  onDebug = () => {},
}) {

  const report = (reason, extra = {}) => {
    onDebug({
      reason,
      currentQuality,
      throughputMbps,
      bufferSeconds,
      pendingQuality,
      pendingCount,
      ...extra
    });
  };


  if (!Number.isFinite(throughputMbps) || throughputMbps <= 0) {
    return null;
  }

  const currentIndex = getQualityIndex(currentQuality);

  if (currentIndex < 0) {
    return null;
  }

  throughputHistory.push(throughputMbps);

  if (throughputHistory.length > THROUGHPUT_WINDOW) {
    throughputHistory.shift();
  }

  if (throughputHistory.length < THROUGHPUT_WINDOW) {
    return null;
  }
  if (!canApplyAbrSwitch()) {
    resetPendingDecision();
    return null;
  }

  if (
    Number.isFinite(bufferSeconds) &&
    bufferSeconds < CRITICAL_BUFFER_SECONDS
  ) {
    resetPendingDecision();

    return currentIndex > 0 ? REPRESENTATIONS[0].name : null;
  }

  const stableThroughputMbps = getMedian(throughputHistory);

  const safeBandwidth = stableThroughputMbps * SAFETY_FACTOR;

  let selectedIndex = 0;

  for (let index = 0; index < REPRESENTATIONS.length; index++) {
    if (REPRESENTATIONS[index].bitrateMbps <= safeBandwidth) {
      selectedIndex = index;
    }
  }

  if (selectedIndex === currentIndex) {
    resetPendingDecision();
    return null;
  }

  if (selectedIndex < currentIndex) {

    if (
      Number.isFinite(bufferSeconds) &&
      bufferSeconds >= BUFFER_PROTECT_DOWN_SECONDS
    ) {
      resetPendingDecision();
      return null;
    }

    selectedIndex = Math.max(selectedIndex, currentIndex - 1);

    const selectedQuality = REPRESENTATIONS[selectedIndex].name;
    if (rememberDecision(selectedQuality) < REQUIRED_DOWN_DECISIONS) {
      return null;
    }

    resetPendingDecision();

    return selectedQuality;
  }

  selectedIndex = Math.min(selectedIndex, currentIndex + 1);

  if (bufferSeconds < BUFFER_REQUIRED_FOR_UP) {
    resetPendingDecision();
    return null;
  }

  const selectedQuality = REPRESENTATIONS[selectedIndex].name;

  if (rememberDecision(selectedQuality) < REQUIRED_UP_DECISIONS) {
    return null;
  }

  resetPendingDecision();
  return selectedQuality;
}

export function resetAbrState() {
  throughputHistory.length = 0;
  resetPendingDecision();

  lastAbrSwitchTime = 0;
  lastEmergencySwitchTime = 0;
}
