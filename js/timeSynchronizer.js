export let relayClockOffsetMs = 0;

export async function synchronizeClock() {
  const samples = [];

  for (let i = 0; i < 10; i++) {
    const before = Date.now();

    const response = await fetch(
      "http://192.168.1.107:8888/time",
      {
        cache: "no-store",
      },
    );

    if (!response.ok) {
      throw new Error(
        `Time synchronization failed: ${response.status}`,
      );
    }

    const { timestampMs } =
      await response.json();

    const after = Date.now();
    const rttMs = after - before;

    const clientMiddle =
      (before + after) / 2;

    samples.push({
      rttMs,
      offsetMs:
        timestampMs - clientMiddle,
    });
  }

  samples.sort(
    (a, b) => a.rttMs - b.rttMs,
  );

  relayClockOffsetMs =
    samples[0].offsetMs;

  console.log("CLOCK_SYNC", {
    relayClockOffsetMs,
    rttMs: samples[0].rttMs,
  });

  return relayClockOffsetMs;
}