export let logEntries = [];
export let paused = false;
export let logFilter = "all";

const MAX_LOG = 3000;

export function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);

  logEntries.push({ level, ts, msg });

  if (logEntries.length > MAX_LOG) {
    logEntries.shift();
  }

  if (!paused && (logFilter === "all" || level === logFilter)) {
    appendLog({ level, ts, msg });
  }
}

function appendLog(entry) {
  const area = document.getElementById("logArea");

  const el = document.createElement("div");
  el.className = `log-entry ${entry.level}`;

  const lv = {
    info: "INFO",
    recv: "RECV",
    warn: "WARN",
    error: "ERR ",
    debug: "DBG ",
    system: "SYS ",
  };

  el.innerHTML =
    `<span class="log-ts">${entry.ts}</span>` +
    `<span class="log-level">${lv[entry.level] || entry.level}</span>` +
    `<span class="log-msg">${entry.msg}</span>`;

  area.appendChild(el);

  while (area.children.length > MAX_LOG) {
    area.removeChild(area.firstChild);
  }

  if (document.getElementById("autoScroll").checked) {
    area.scrollTop = area.scrollHeight;
  }
}

export function clearLog() {
  logEntries = [];
  document.getElementById("logArea").innerHTML = "";
}

export function togglePause() {
  paused = !paused;

  const btn = document.getElementById("pauseBtn");
  btn.textContent = paused ? "Resume" : "Pause";
  btn.style.color = paused ? "var(--amber)" : "";
}

export function exportLog() {
  const text = logEntries
    .map(
      (e) =>
        `${e.ts} [${e.level.toUpperCase()}] ${e.msg.replace(/<[^>]+>/g, "")}`,
    )
    .join("\n");

  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], { type: "text/plain" })),
    download: `moqtail-log-${Date.now()}.txt`,
  });

  a.click();
}

export function setFilter(f, btn) {
  logFilter = f;

  document
    .querySelectorAll(".toggle-group .toggle-btn")
    .forEach((b) => b.classList.remove("active"));

  btn.classList.add("active");

  const area = document.getElementById("logArea");
  area.innerHTML = "";

  (f === "all" ? logEntries : logEntries.filter((e) => e.level === f)).forEach(
    appendLog,
  );

  area.scrollTop = area.scrollHeight;
}
