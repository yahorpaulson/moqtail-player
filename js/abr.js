const REPRESENTATIONS = [
  { name: "360p", bitrateMbps: 1.2 },
  { name: "480p", bitrateMbps: 2.5 },
  { name: "720p", bitrateMbps: 6 },
  { name: "1080p", bitrateMbps: 8 },
  { name: "1440p", bitrateMbps: 12 },
];

const throughputHistory = [];

const THROUGHPUT_WINDOW = 5;
const SAFETY_FACTOR = 0.8;

const CRITICAL_BUFFER_SECONDS = 0.2;
const BUFFER_REQUIRED_FOR_UP = 0.6;

const REQUIRED_UP_DECISIONS = 5;
const REQUIRED_DOWN_DECISIONS = 2;

let pendingQuality = null;
let pendingCount = 0;

function getMedian(values) {
  const sorted = [...values].sort(
    (a, b) => a - b,
  );

  return sorted[
    Math.floor(sorted.length / 2)
  ];
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

export function chooseQuality({
  throughputMbps,
  bufferSeconds,
  currentQuality,
}) {
  if (
    !Number.isFinite(throughputMbps) ||
    throughputMbps <= 0
  ) {
    return null;
  }

  const currentIndex =
    REPRESENTATIONS.findIndex(
      (item) => item.name === currentQuality,
    );

  if (currentIndex === -1) {
    return null;
  }

  throughputHistory.push(throughputMbps);

  if (
    throughputHistory.length >
    THROUGHPUT_WINDOW
  ) {
    throughputHistory.shift();
  }

  if (
    throughputHistory.length <
    THROUGHPUT_WINDOW
  ) {
    return null;
  }

  const stableThroughputMbps =
    getMedian(throughputHistory);

  const safeBandwidth =
    stableThroughputMbps *
    SAFETY_FACTOR;

  let selectedIndex = 0;

  for (
    let index = 0;
    index < REPRESENTATIONS.length;
    index++
  ) {
    if (
      REPRESENTATIONS[index].bitrateMbps <=
      safeBandwidth
    ) {
      selectedIndex = index;
    }
  }

  
  if (
    Number.isFinite(bufferSeconds) &&
    bufferSeconds <
      CRITICAL_BUFFER_SECONDS
  ) {
    resetPendingDecision();

    if (currentIndex === 0) {
      return null;
    }

    return REPRESENTATIONS[0].name;
  }

  if (selectedIndex === currentIndex) {
    resetPendingDecision();
    return null;
  }

  if (selectedIndex < currentIndex) {
  if (
    bufferSeconds <
    CRITICAL_BUFFER_SECONDS
  ) {
    resetPendingDecision();
    return REPRESENTATIONS[0].name;
  }


  selectedIndex = Math.max(
    selectedIndex,
    currentIndex - 1,
  );

  const count = rememberDecision(
    REPRESENTATIONS[selectedIndex].name,
  );

  if (count < REQUIRED_DOWN_DECISIONS) {
    return null;
  }

  resetPendingDecision();

  return REPRESENTATIONS[
    selectedIndex
  ].name;
}

 
  if (selectedIndex > currentIndex) {
  
    selectedIndex = Math.min(selectedIndex, currentIndex + 1);

    if (bufferSeconds < BUFFER_REQUIRED_FOR_UP) {
      resetPendingDecision();
      return null;
    }

    const count = rememberDecision(REPRESENTATIONS[selectedIndex].name);

    if(count < REQUIRED_UP_DECISIONS) {
      return null;
    }

    resetPendingDecision();

    return REPRESENTATIONS[selectedIndex].name;
  }

  
  const count = rememberDecision(REPRESENTATIONS[selectedIndex].name);

  if (count < REQUIRED_DOWN_DECISIONS) {
    return null;
  }

  resetPendingDecision();

  return REPRESENTATIONS[selectedIndex].name;
}