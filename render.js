const $ = (id) => document.getElementById(id);
const fileInput = $("fileInput");
const audioPlayer = $("audioPlayer");
const nowPlaying = $("nowPlaying");
const playlistEl = $("playlistEl");
const daysEl = $("days");
const scheduleStatus = $("scheduleStatus");
const toggleScheduleBtn = $("toggleScheduleBtn");
const playBtn = $("playBtn");
const playIcon = $("playIcon");
const stopBtn = $("stopBtn");
const seek = $("seek");
const curTime = $("curTime");
const durTime = $("durTime");

const PLAY_PATH = "M8 5v14l11-7z";
const PAUSE_PATH = "M6 5h4v14H6zm8 0h4v14h-4z";
const STORAGE_KEY = "schedule-player-days";

const ICON_PLAY = `<svg viewBox="0 0 24 24"><path d="${PLAY_PATH}" /></svg>`;
const ICON_CLEAR = `<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>`;
const ICON_DELETE = `<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" /></svg>`;

const DAYS = [
  { name: "월", dow: 1 },
  { name: "화", dow: 2 },
  { name: "수", dow: 3 },
  { name: "목", dow: 4 },
  { name: "금", dow: 5 },
  { name: "토", dow: 6 },
  { name: "일", dow: 0 },
];

// Talks to main.js (tray tooltip, start with Windows). null when opened in a plain browser.
let ipc = null;
try {
  ipc = require("electron").ipcRenderer;
} catch (e) {}

// Electron (28) exposes the local path on File, so songs survive a restart as file:// URLs.
function toFileUrl(path) {
  try {
    return require("url").pathToFileURL(path).href;
  } catch (e) {
    return null;
  }
}

/*
 * schedule[i] = { on, slots: [slot] }
 * slot = { h, m, eh, em, tracks: [{ name, path, src }] }; eh = null means no stop time.
 */
const newSlot = (h, m) => ({ h, m, eh: (h + 1) % 24, em: m, tracks: [] });

function loadTracks(list) {
  return (list || [])
    .map((t) => ({ name: t.name, path: t.path, src: toFileUrl(t.path) }))
    .filter((t) => t.src);
}

function loadSlot(s) {
  return {
    h: Number(s.h) || 0,
    m: Number(s.m) || 0,
    eh: s.eh === null || s.eh === undefined ? null : Number(s.eh),
    em: Number(s.em) || 0,
    tracks: loadTracks(s.tracks),
  };
}

let schedule = DAYS.map(() => ({ on: false, slots: [] }));
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  if (Array.isArray(saved) && saved.length === 7) {
    schedule = saved.map((d) => {
      let slots;
      if (Array.isArray(d.slots)) slots = d.slots.map(loadSlot);
      // Older saves kept one time and one song list per day: turn it into that day's only slot.
      else if (d.h !== undefined) slots = [loadSlot(d)];
      else slots = [];
      return { on: !!d.on, slots };
    });
  }
} catch (e) {}

let currentTracks = []; // 플레이어에 불러온 시간대의 곡 목록
let currentIndex = 0;
let currentLabel = null; // 예: "월요일 07:00~08:00"
let playingLabel = null; // 스케줄로 재생 중일 때 상태 배지에 표시할 문구
let stopAt = null; // 스케줄 재생을 멈출 시각 (ms), 종료 시간이 없으면 null
let pickTarget = null; // 곡 선택 창을 연 { i: 요일, j: 시간대 }
let isScheduled = false;
let lastFired = null;

// OS 알림 권한 요청
if ("Notification" in window && Notification.permission !== "granted") {
  Notification.requestPermission();
}

const pad = (n) => String(n).padStart(2, "0");
const fmt = (s) =>
  isFinite(s) ? `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}` : "0:00";
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const startMin = (slot) => slot.h * 60 + slot.m;
// Same start and stop time: shown as an error and never played
const zeroLength = (slot) => slot.eh !== null && slot.eh * 60 + slot.em === startMin(slot);
// Has songs and a usable time window
const playable = (slot) => slot.tracks.length > 0 && !zeroLength(slot);

function save() {
  try {
    const data = schedule.map((d) => ({
      on: d.on,
      slots: d.slots.map((s) => ({
        h: s.h,
        m: s.m,
        eh: s.eh,
        em: s.em,
        tracks: s.tracks.filter((t) => t.path).map((t) => ({ name: t.name, path: t.path })),
      })),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {}
}

// withNone adds a "--" option (value "") that means "no stop time".
function options(count, selected, withNone) {
  let html = withNone ? `<option value=""${selected === null ? " selected" : ""}>--</option>` : "";
  for (let i = 0; i < count; i++) {
    html += `<option value="${i}"${i === selected ? " selected" : ""}>${pad(i)}</option>`;
  }
  return html;
}

// "07:00~08:30", or just "07:00" without a stop time
function rangeText(s) {
  const start = `${pad(s.h)}:${pad(s.m)}`;
  return s.eh === null ? start : `${start}~${pad(s.eh)}:${pad(s.em)}`;
}

/*
 * Time checks for slots on days that are on. Returns Map<slot, { level, msgs }>.
 *   error: start and stop are the same, or two slots overlap
 *   warn:  stop is earlier than start, so it ends the next day
 * Times are minutes in a Mon-first week; a slot without a stop time counts as its start minute.
 */
const WEEK_MIN = 7 * 1440;
const slotName = (i, s) => `${DAYS[i].name}요일 ${rangeText(s)}`;

function slotIssues() {
  const issues = new Map();
  const add = (slot, level, msg) => {
    const cur = issues.get(slot) || { level, msgs: [] };
    if (level === "error") cur.level = "error";
    if (!cur.msgs.includes(msg)) cur.msgs.push(msg);
    issues.set(slot, cur);
  };

  const spans = [];
  schedule.forEach((day, i) => {
    if (!day.on) return;
    day.slots.forEach((s) => {
      const base = i * 1440;
      const start = base + startMin(s);
      let end = start + 1;
      if (s.eh !== null) {
        const e = s.eh * 60 + s.em;
        if (e === startMin(s)) {
          add(s, "error", "시작과 종료 시간이 같아 재생되지 않습니다");
          return;
        }
        if (e < startMin(s)) {
          add(s, "warn", `종료가 시작보다 빨라 다음 날 ${pad(s.eh)}:${pad(s.em)}에 끝납니다`);
          end = base + 1440 + e;
        } else {
          end = base + e;
        }
      }
      spans.push({ i, s, start, end });
    });
  });

  for (let a = 0; a < spans.length; a++) {
    for (let b = a + 1; b < spans.length; b++) {
      const A = spans[a];
      const B = spans[b];
      // Sunday night can run into Monday morning, so also compare one week apart
      const hit = [-WEEK_MIN, 0, WEEK_MIN].some((shift) => A.start < B.end + shift && B.start + shift < A.end);
      if (hit) {
        add(A.s, "error", `${slotName(B.i, B.s)} 시간대와 겹칩니다`);
        add(B.s, "error", `${slotName(A.i, A.s)} 시간대와 겹칩니다`);
      }
    }
  }
  return issues;
}

// After an edit, point out a problem with the slot that was just changed
function toastSlotIssue(i, slot) {
  const issue = slotIssues().get(slot);
  if (issue) showToast(`${slotName(i, slot)}: ${issue.msgs.join(", ")}`);
}

function renderSlot(d, slot, j, issue) {
  const empty = slot.tracks.length === 0;
  const label = `${d.name}요일 시간대 ${j + 1}`;
  const summary = empty
    ? "곡 없음"
    : escapeHtml(`${slot.tracks.length}곡 · ${slot.tracks.map((t) => t.name).join(", ")}`);
  const note = issue
    ? `<p class="slot-issue" role="alert">${escapeHtml(issue.msgs.join(" · "))}</p>`
    : "";
  return `
    <div class="slot${issue ? ` ${issue.level}` : ""}" data-j="${j}">
      <div class="day-time">
        <select data-k="h" aria-label="${label} 시작 시">${options(24, slot.h)}</select>
        <span>:</span>
        <select data-k="m" aria-label="${label} 시작 분">${options(60, slot.m)}</select>
        <span class="range-sep">~</span>
        <select data-k="eh" aria-label="${label} 종료 시">${options(24, slot.eh, true)}</select>
        <span>:</span>
        <select data-k="em" aria-label="${label} 종료 분"${slot.eh === null ? " disabled" : ""}>${options(60, slot.em)}</select>
        <button class="icon-mini danger" data-act="del-slot" aria-label="${label} 삭제">${ICON_DELETE}</button>
      </div>
      <div class="day-music">
        <button class="btn-mini${empty ? " accent" : ""}" data-act="pick">${empty ? "곡 선택" : "곡 변경"}</button>
        <span class="day-tracks${empty ? " empty" : ""}" title="${summary}">${summary}</span>
        ${empty ? "" : `
        <button class="icon-mini" data-act="preview" aria-label="${label} 미리듣기">${ICON_PLAY}</button>
        <button class="icon-mini" data-act="clear" aria-label="${label} 곡 비우기">${ICON_CLEAR}</button>`}
      </div>
      ${note}
    </div>`;
}

// Off days collapse to one line that lists their time slots.
function daySummary(day) {
  if (day.on) return "";
  if (day.slots.length === 0) return "꺼짐";
  return `꺼짐 · ${day.slots.map(rangeText).join(", ")}`;
}

// 요일 목록 그리기 (켜진 요일만 시간대를 펼쳐서 보여줌)
function renderDays() {
  const issues = slotIssues();
  daysEl.innerHTML = DAYS.map((d, i) => {
    const day = schedule[i];
    const body = day.on
      ? `<div class="slots">
          ${day.slots.map((slot, j) => renderSlot(d, slot, j, issues.get(slot))).join("")}
          <button class="add-slot" data-act="add-slot">+ 시간대 추가</button>
        </div>`
      : "";
    return `
      <div class="day${day.on ? " on" : ""}" data-i="${i}">
        <div class="day-main">
          <div class="day-name">${d.name}</div>
          <span class="day-summary">${escapeHtml(daySummary(day))}</span>
          <label class="switch">
            <input type="checkbox" data-k="on"${day.on ? " checked" : ""} aria-label="${d.name}요일 사용" />
            <span></span>
          </label>
        </div>
        ${body}
      </div>`;
  }).join("");
}

function refresh() {
  save();
  renderDays();
  updateStatus();
  renderCalendar();
}

daysEl.addEventListener("change", (e) => {
  const row = e.target.closest(".day");
  if (!row) return;
  const i = Number(row.dataset.i);
  const day = schedule[i];
  const k = e.target.dataset.k;
  if (k === "on") {
    if (!e.target.checked) {
      day.on = false;
      refresh();
      return;
    }
    // 켜면 다른 요일 시간대와 겹치는 경우 막음 (자정을 넘는 시간대 등)
    const clash = tryTurnOn(i);
    refresh();
    if (clash) {
      showToast(`${DAYS[i].name}요일을 켤 수 없습니다. ${clash}`);
    } else {
      // Turned on: still point out problems inside the day (e.g. from an older save)
      const issues = slotIssues();
      const bad = day.slots.find((s) => issues.has(s));
      if (bad) toastSlotIssue(i, bad);
    }
    return;
  }
  const slot = day.slots[Number(e.target.closest(".slot").dataset.j)];
  const before = { h: slot.h, m: slot.m, eh: slot.eh, em: slot.em };
  const errorsBefore = errorMsgs(slot);

  if (k === "eh") {
    slot.eh = e.target.value === "" ? null : Number(e.target.value);
  } else {
    slot[k] = Number(e.target.value);
  }
  // Moving the start moves the stop with it, so the length stays the same
  if ((k === "h" || k === "m") && slot.eh !== null) {
    const delta = startMin(slot) - (before.h * 60 + before.m);
    const end = (((before.eh * 60 + before.em + delta) % 1440) + 1440) % 1440;
    slot.eh = Math.floor(end / 60);
    slot.em = end % 60;
  }

  // 겹치거나 시작·종료가 같아지는 변경은 막고 원래 시간으로 되돌림
  const newErrors = errorMsgs(slot).filter((msg) => !errorsBefore.includes(msg));
  if (newErrors.length > 0) {
    Object.assign(slot, before);
    day.slots.sort((a, b) => startMin(a) - startMin(b));
    refresh();
    const reasons = newErrors.map((msg) => msg.replace("같아 재생되지 않습니다", "같습니다"));
    showToast(`바꿀 수 없습니다. ${reasons.join(", ")}`);
    return;
  }

  // Keep slots in start-time order
  day.slots.sort((a, b) => startMin(a) - startMin(b));
  refresh();
  toastSlotIssue(i, slot); // remaining notices, e.g. a stop on the next day
});

// Turn weekday i on unless its slots would overlap another day's slots.
// Returns null when it is on, or the reason it was left off.
// Problems inside the day itself (old saves) don't block: the day has to be on to fix them.
function tryTurnOn(i) {
  const before = new Map();
  schedule.forEach((d) => d.slots.forEach((s) => before.set(s, errorMsgs(s))));
  schedule[i].on = true;
  const ownDay = `${DAYS[i].name}요일 `;
  for (const [owner, d] of schedule.entries()) {
    for (const s of d.slots) {
      const fresh = errorMsgs(s).filter((msg) => {
        if ((before.get(s) || []).includes(msg)) return false;
        if (owner !== i) return true; // another day's slot now clashes with day i
        return msg.endsWith("시간대와 겹칩니다") && !msg.startsWith(ownDay); // day i's slot vs another day
      });
      if (fresh.length > 0) {
        schedule[i].on = false;
        return `${slotName(owner, s)} 시간대가 ${fresh[0]}`;
      }
    }
  }
  return null;
}

// Error-level messages for one slot (overlap, same start and stop)
function errorMsgs(slot) {
  const issue = slotIssues().get(slot);
  return issue && issue.level === "error" ? issue.msgs.filter((m) => !m.startsWith("종료가 시작보다")) : [];
}

daysEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const i = Number(btn.closest(".day").dataset.i);
  const day = schedule[i];
  const act = btn.dataset.act;

  if (act === "add-slot") {
    // New slot starts where the last one ends (or an hour after it starts)
    const last = day.slots[day.slots.length - 1];
    const preferred = !last ? 7 * 60 : last.eh !== null ? last.eh * 60 + last.em : startMin(last) + 60;
    const wasOn = day.on;
    day.on = true;
    // 겹치지 않는 1시간짜리 빈 시간을 1시간 단위로 찾음
    let slot = null;
    for (let step = 0; step < 24 && !slot; step++) {
      const start = (preferred + step * 60) % 1440;
      const candidate = newSlot(Math.floor(start / 60), start % 60);
      day.slots.push(candidate);
      if (errorMsgs(candidate).length === 0) slot = candidate;
      else day.slots.pop();
    }
    if (!slot) {
      day.on = wasOn;
      showToast(`${DAYS[i].name}요일에는 1시간짜리 시간대를 넣을 빈 시간이 없습니다.`);
      return;
    }
    day.slots.sort((a, b) => startMin(a) - startMin(b));
    refresh();
    toastSlotIssue(i, slot);
    return;
  }

  const j = Number(btn.closest(".slot").dataset.j);
  if (act === "pick") {
    pickTarget = { i, j };
    fileInput.value = "";
    fileInput.click();
  } else if (act === "preview") {
    // Previewing replaces whatever the schedule was playing
    playingLabel = null;
    stopAt = null;
    loadSlotToPlayer(i, j);
    updateStatus();
    audioPlayer.play();
  } else if (act === "clear") {
    day.slots[j].tracks = [];
    refresh();
  } else if (act === "del-slot") {
    day.slots.splice(j, 1);
    refresh();
  }
});

document.querySelectorAll("[data-preset]").forEach((chip) => {
  chip.addEventListener("click", () => {
    const p = chip.dataset.preset;
    const wanted = DAYS.map((d) => {
      const weekend = d.dow === 0 || d.dow === 6;
      return p === "all" || (p === "weekday" && !weekend) || (p === "weekend" && weekend);
    });
    // Turn days off first (never causes a clash), then turn days on one at a time
    // and leave off any day whose slots would overlap another day's
    wanted.forEach((on, i) => {
      if (!on) schedule[i].on = false;
    });
    const skipped = [];
    wanted.forEach((on, i) => {
      if (!on || schedule[i].on) return;
      const clash = tryTurnOn(i);
      if (clash) skipped.push(`${DAYS[i].name}요일(${clash})`);
    });
    refresh();
    if (skipped.length > 0) showToast(`시간대가 겹쳐서 켜지 않았습니다: ${skipped.join(", ")}`);
  });
});

// 1. 시간대별 곡 선택 (선택한 시간대의 목록을 새로 채움)
fileInput.addEventListener("change", (event) => {
  const files = event.target.files;
  if (!pickTarget || !files || files.length === 0) return;
  const slot = schedule[pickTarget.i].slots[pickTarget.j];
  pickTarget = null;
  if (!slot) return;
  slot.tracks = Array.from(files).map((file) => {
    const src = file.path ? toFileUrl(file.path) : null;
    return src
      ? { name: file.name, path: file.path, src }
      : { name: file.name, path: null, src: URL.createObjectURL(file) };
  });
  refresh();
});

// Earliest playable slot from now, within the coming week.
function nextSlot() {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (let offset = 0; offset < 8; offset++) {
    const dow = (now.getDay() + offset) % 7;
    const i = DAYS.findIndex((d) => d.dow === dow);
    const day = schedule[i];
    if (!day.on) continue;
    const slot = day.slots
      .filter((s) => playable(s) && (offset > 0 || startMin(s) > nowMin))
      .sort((a, b) => startMin(a) - startMin(b))[0];
    if (!slot) continue;
    const label =
      offset === 0 ? "오늘" : offset === 1 ? "내일" : offset === 7 ? `다음 주 ${DAYS[i].name}요일` : `${DAYS[i].name}요일`;
    return `${label} ${rangeText(slot)}`;
  }
  return null;
}

// Header status: dot colour + text (gray = off, green = waiting, blue = playing, amber = nothing to play)
function updateStatus() {
  toggleScheduleBtn.textContent = isScheduled ? "스케줄 중지" : "스케줄 시작";
  toggleScheduleBtn.className = isScheduled ? "btn btn-danger" : "btn btn-primary";
  let text;
  let state;
  if (playingLabel) {
    text = `재생 중 · ${playingLabel}`;
    state = "playing";
  } else if (!isScheduled) {
    text = "스케줄 꺼짐";
    state = "off";
  } else {
    const next = nextSlot();
    text = next ? `대기 중 · 다음 재생 ${next}` : "재생할 시간대 없음";
    state = next ? "active" : "warn";
  }
  scheduleStatus.className = `status-pill ${state}`;
  scheduleStatus.title = text;
  $("scheduleText").textContent = text;
  if (ipc) ipc.send("status", text); // tray icon tooltip
}

// 2. 플레이어에 시간대의 곡 목록 불러오기
function loadSlotToPlayer(i, j) {
  const slot = schedule[i].slots[j];
  currentTracks = slot.tracks.slice();
  currentLabel = `${DAYS[i].name}요일 ${rangeText(slot)}`;
  renderPlaylist();
  loadTrack(0);
  playBtn.disabled = stopBtn.disabled = seek.disabled = currentTracks.length === 0;
}

function loadTrack(index) {
  if (currentTracks.length === 0) return;
  currentIndex = index;
  audioPlayer.src = currentTracks[currentIndex].src;
  audioPlayer.load();
  renderNowPlaying();
}

function renderPlaylist() {
  // textContent keeps file names from being parsed as HTML
  playlistEl.replaceChildren(
    ...currentTracks.map((t, idx) => {
      const li = document.createElement("li");
      li.textContent = t.name;
      if (idx === currentIndex) li.className = "current";
      return li;
    }),
  );
}

function renderNowPlaying() {
  const t = currentTracks[currentIndex];
  nowPlaying.textContent = t
    ? `${currentLabel} · ${currentIndex + 1}/${currentTracks.length} · ${t.name}`
    : "재생할 시간대의 미리듣기를 눌러주세요";
  Array.from(playlistEl.children).forEach((li, idx) => {
    li.classList.toggle("current", idx === currentIndex);
  });
}

// 3. 스케줄 시작 / 중지
toggleScheduleBtn.addEventListener("click", () => {
  if (!isScheduled) {
    const onDays = DAYS.map((d, i) => i).filter((i) => schedule[i].on);
    if (onDays.length === 0) {
      alert("재생할 요일을 하나 이상 켜주세요!");
      return;
    }
    const hasPlayable = onDays.some((i) => schedule[i].slots.some(playable));
    if (!hasPlayable) {
      alert("켜진 요일에 시간대를 추가하고 곡을 선택해주세요!");
      return;
    }
    const missing = [];
    onDays.forEach((i) => {
      if (schedule[i].slots.length === 0) missing.push(`${DAYS[i].name}요일(시간대 없음)`);
      schedule[i].slots.forEach((s) => {
        if (s.tracks.length === 0) missing.push(`${DAYS[i].name}요일 ${rangeText(s)}`);
      });
    });
    // 시간이 겹치거나 시작·종료가 맞지 않는 시간대
    const timeProblems = [];
    slotIssues().forEach((issue, slot) => {
      const i = schedule.findIndex((d) => d.slots.includes(slot));
      timeProblems.push({ order: i * 1440 + startMin(slot), text: `${slotName(i, slot)}: ${issue.msgs.join(", ")}` });
    });
    timeProblems.sort((a, b) => a.order - b.order);
    const sections = [];
    if (timeProblems.length > 0) sections.push(`시간을 확인해주세요.\n${timeProblems.map((p) => p.text).join("\n")}`);
    if (missing.length > 0) sections.push(`곡이 없어 재생되지 않는 시간대가 있습니다.\n${missing.join("\n")}`);
    if (sections.length > 0 && !confirm(`${sections.join("\n\n")}\n\n그래도 시작할까요?`)) {
      return;
    }
    if ("Notification" in window && Notification.permission !== "granted") {
      Notification.requestPermission();
    }
    enableSchedule(true);
  } else {
    disableSchedule();
  }
});

// 스케줄 켜기: 켜진 상태를 저장하고, 지금이 곡이 있는 시간대 안이면 바로 재생
// announce = true shows a notice when there is nothing to play right now.
function enableSchedule(announce) {
  isScheduled = true;
  saveScheduleOn(true);
  const now = new Date();
  lastFired = minuteKey(now); // the per-second check must not restart it within this minute
  const cur = currentSlot(now);
  if (cur) {
    startSlotPlayback(cur.i, cur.j, cur.stopAt);
  } else if (announce) {
    // 지금은 재생할 시간대가 아니면 알려주고 다음 재생을 기다림
    const next = nextSlot();
    showToast(
      next
        ? `지금은 재생할 시간대가 아닙니다. ${next}에 재생을 시작합니다.`
        : "지금은 재생할 시간대가 아니고, 예정된 재생도 없습니다.",
    );
  }
  updateStatus();
}

function disableSchedule() {
  isScheduled = false;
  saveScheduleOn(false);
  // 스케줄 중지는 스케줄로 재생 중인 음악도 멈춤 (미리듣기는 그대로)
  if (playingLabel) finishScheduledPlay();
  updateStatus();
}

// 스케줄 켜짐 여부 저장 (앱을 다시 켜면 그대로 이어서 켜짐)
const SCHEDULE_ON_KEY = "schedule-player-on";
function saveScheduleOn(on) {
  try {
    if (on) localStorage.setItem(SCHEDULE_ON_KEY, "1");
    else localStorage.removeItem(SCHEDULE_ON_KEY);
  } catch (e) {}
}
function savedScheduleOn() {
  try {
    return localStorage.getItem(SCHEDULE_ON_KEY) === "1";
  } catch (e) {
    return false;
  }
}

// Short message at the bottom of the window that fades out on its own
let toastTimer = null;
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 4000);
}

const minuteKey = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// The slot whose start ~ stop window contains `now`, with its stop time in ms.
// Slots without a stop time play once from their start, so they are never resumed midway.
// A slot that runs past midnight (23:00~01:00) also counts on the next day before its stop time.
function currentSlot(now) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const at = (dayOffset, min) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(Math.floor(min / 60), min % 60, 0, 0);
    return d.getTime();
  };
  const check = (dayOffset) => {
    const date = new Date(now);
    date.setDate(date.getDate() + dayOffset);
    const i = dayIndexOf(date);
    const day = schedule[i];
    if (!day.on) return null;
    for (let j = 0; j < day.slots.length; j++) {
      const s = day.slots[j];
      if (!playable(s) || s.eh === null) continue;
      const start = startMin(s);
      const end = s.eh * 60 + s.em;
      const overnight = end <= start;
      if (dayOffset === 0) {
        if (!overnight && nowMin >= start && nowMin < end) return { i, j, stopAt: at(0, end) };
        if (overnight && nowMin >= start) return { i, j, stopAt: at(1, end) };
      } else if (overnight && nowMin < end) {
        return { i, j, stopAt: at(0, end) }; // yesterday's slot still running
      }
    }
    return null;
  };
  return check(0) || check(-1);
}

// Load slot j of weekday i, play it from the first song, and stop at stopAtMs (null = play the list once)
function startSlotPlayback(i, j, stopAtMs) {
  const slot = schedule[i].slots[j];
  loadSlotToPlayer(i, j);
  playingLabel = currentLabel;
  stopAt = stopAtMs;
  const label = playingLabel;
  updateStatus();
  audioPlayer
    .play()
    .then(() => {
      updateStatus();
      sendSystemNotification(label, slot.tracks.length);
    })
    .catch((err) => {
      playingLabel = null;
      stopAt = null;
      updateStatus();
      console.error("재생 실패:", err);
    });
}

function sendSystemNotification(label, count) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(`${label} 스케줄 재생`, {
      body: `재생 목록 시작 (총 ${count}곡)`,
    });
  }
}

// 4. 매초 현재 요일·시각 확인
setInterval(() => {
  const now = new Date();
  // 종료 시각이 되면 스케줄 재생 멈춤 (스케줄을 꺼도 이미 시작한 재생은 종료 시각에 멈춤)
  if (stopAt !== null && now.getTime() >= stopAt) {
    finishScheduledPlay();
    return;
  }
  if (!isScheduled) return;

  const i = DAYS.findIndex((d) => d.dow === now.getDay());
  const day = schedule[i];
  const key = minuteKey(now);
  const j = day.on
    ? day.slots.findIndex((s) => playable(s) && s.h === now.getHours() && s.m === now.getMinutes())
    : -1;

  if (j !== -1 && lastFired !== key) {
    lastFired = key; // 같은 분 안에서 중복 실행 방지
    const slot = day.slots[j];
    let stopAtMs = null;
    if (slot.eh !== null) {
      const end = new Date(now);
      end.setHours(slot.eh, slot.em, 0, 0);
      // A stop time at or before the start time means the next day (e.g. 23:00~01:00).
      if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
      stopAtMs = end.getTime();
    }
    // 이전 시간대가 재생 중이어도 새 시간대 곡으로 바꿔서 첫 곡부터 재생
    startSlotPlayback(i, j, stopAtMs);
  } else if (audioPlayer.paused && now.getSeconds() === 0) {
    updateStatus(); // keep "다음 재생" fresh
  }
}, 1000);

// 5. 플레이어 컨트롤
playBtn.addEventListener("click", () => {
  if (currentTracks.length === 0) return;
  if (audioPlayer.paused) {
    audioPlayer.play();
  } else {
    // A manual pause ends the scheduled play. Track switches and slot changes don't come through here.
    playingLabel = null;
    stopAt = null;
    audioPlayer.pause();
    updateStatus();
  }
});

// 스케줄 재생 끝내기: 종료 시각 도달, 목록 끝, 정지 버튼
function finishScheduledPlay() {
  playingLabel = null;
  stopAt = null;
  audioPlayer.pause();
  loadTrack(0);
  updateStatus();
}

stopBtn.addEventListener("click", finishScheduledPlay);

seek.addEventListener("input", () => {
  audioPlayer.currentTime = Number(seek.value);
});

// 한 곡이 끝나면 그 시간대 목록의 다음 곡 재생
// 종료 시간이 있는 스케줄 재생은 종료 시각까지 목록을 처음부터 반복
audioPlayer.addEventListener("ended", () => {
  if (currentIndex < currentTracks.length - 1) {
    loadTrack(currentIndex + 1);
    audioPlayer.play();
  } else if (stopAt !== null && Date.now() < stopAt) {
    loadTrack(0);
    audioPlayer.play();
  } else {
    finishScheduledPlay();
  }
});

function syncProgress() {
  const d = audioPlayer.duration || 0;
  seek.max = d;
  seek.value = audioPlayer.currentTime;
  seek.style.setProperty("--p", d ? `${(audioPlayer.currentTime / d) * 100}%` : "0%");
  curTime.textContent = fmt(audioPlayer.currentTime);
  durTime.textContent = fmt(d);
}

audioPlayer.addEventListener("timeupdate", syncProgress);
audioPlayer.addEventListener("loadedmetadata", syncProgress);

audioPlayer.addEventListener("play", () => {
  playIcon.setAttribute("d", PAUSE_PATH);
  playBtn.setAttribute("aria-label", "일시정지");
});

audioPlayer.addEventListener("pause", () => {
  playIcon.setAttribute("d", PLAY_PATH);
  playBtn.setAttribute("aria-label", "재생");
});

// 6. 달력: 스케줄이 잡힌 날짜를 점으로 표시 (요일 반복 확인용)
const calTitle = $("calTitle");
const calDays = $("calDays");
const calDetail = $("calDetail");

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const dayIndexOf = (date) => DAYS.findIndex((d) => d.dow === date.getDay());
const sameDay = (a, b) => a.getTime() === b.getTime(); // both at local midnight

let calSelected = startOfToday();
let calView = { y: calSelected.getFullYear(), m: calSelected.getMonth() };
let calRenderedFor = calSelected.getTime();

function renderCalendar() {
  const { y, m } = calView;
  const today = startOfToday();
  calRenderedFor = today.getTime();
  calTitle.textContent = `${y}년 ${m + 1}월`;

  // Monday-first grid, same order as the weekday list
  const lead = (new Date(y, m, 1).getDay() + 6) % 7;
  const cells = [];
  for (let k = 0; k < 42; k++) {
    const date = new Date(y, m, 1 - lead + k);
    // Stop after the week that holds the month's last day
    if (k % 7 === 0 && k > 0 && (date.getMonth() !== m)) break;
    const day = schedule[dayIndexOf(date)];
    const dots = day.on
      ? day.slots
          .slice(0, 3)
          .map((s) => `<i class="dot${s.tracks.length ? "" : " empty"}"></i>`)
          .join("")
      : "";
    const cls = ["cal-day"];
    if (date.getMonth() !== m) cls.push("out");
    if (date < today) cls.push("past");
    if (sameDay(date, today)) cls.push("today");
    if (sameDay(date, calSelected)) cls.push("selected");
    if (date.getDay() === 0) cls.push("sun");
    if (date.getDay() === 6) cls.push("sat");
    const count = day.on ? day.slots.length : 0;
    cells.push(
      `<button class="${cls.join(" ")}" data-date="${date.getTime()}" aria-label="${date.getMonth() + 1}월 ${date.getDate()}일${count ? `, 시간대 ${count}개` : ""}">` +
        `<span class="num">${date.getDate()}</span><span class="dots">${dots}</span></button>`,
    );
  }
  calDays.innerHTML = cells.join("");
  renderCalDetail();
}

function renderCalDetail() {
  const i = dayIndexOf(calSelected);
  const day = schedule[i];
  const title = `${calSelected.getMonth() + 1}월 ${calSelected.getDate()}일 ${DAYS[i].name}요일`;
  let body;
  if (!day.on) body = `<p class="cal-empty">꺼진 요일이라 재생하지 않습니다</p>`;
  else if (day.slots.length === 0) body = `<p class="cal-empty">시간대가 없습니다</p>`;
  else
    body = `<ul>${day.slots
      .map(
        (s) =>
          `<li><i class="dot${s.tracks.length ? "" : " empty"}"></i><b>${rangeText(s)}</b><span>${s.tracks.length ? `${s.tracks.length}곡` : "곡 없음"}</span></li>`,
      )
      .join("")}</ul>`;
  calDetail.innerHTML = `
    <div class="cal-detail-head">
      <h4>${title}</h4>
      <button class="btn-mini" data-act="goto-day" data-i="${i}">설정 보기</button>
    </div>
    ${body}`;
}

calDays.addEventListener("click", (e) => {
  const cell = e.target.closest(".cal-day");
  if (!cell) return;
  calSelected = new Date(Number(cell.dataset.date));
  calView = { y: calSelected.getFullYear(), m: calSelected.getMonth() };
  renderCalendar();
});

// Jump to that weekday's settings in the list and briefly highlight it
calDetail.addEventListener("click", (e) => {
  const btn = e.target.closest('[data-act="goto-day"]');
  if (!btn) return;
  const row = daysEl.querySelector(`.day[data-i="${btn.dataset.i}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.remove("flash");
  void row.offsetWidth; // restart the animation
  row.classList.add("flash");
});

$("calPrev").addEventListener("click", () => {
  calView = calView.m === 0 ? { y: calView.y - 1, m: 11 } : { y: calView.y, m: calView.m - 1 };
  renderCalendar();
});
$("calNext").addEventListener("click", () => {
  calView = calView.m === 11 ? { y: calView.y + 1, m: 0 } : { y: calView.y, m: calView.m + 1 };
  renderCalendar();
});
$("calToday").addEventListener("click", () => {
  calSelected = startOfToday();
  calView = { y: calSelected.getFullYear(), m: calSelected.getMonth() };
  renderCalendar();
});

// Past midnight, move the "today" mark
setInterval(() => {
  if (startOfToday().getTime() !== calRenderedFor) renderCalendar();
}, 60 * 1000);

// 7. 타이틀 수정 (저장해서 다음 실행에도 유지, 창 제목도 같이 변경)
const TITLE_KEY = "schedule-player-title";
const DEFAULT_TITLE = "스케줄 음악 플레이어";
const appTitle = $("appTitle");
let savedTitle = DEFAULT_TITLE;
try {
  savedTitle = localStorage.getItem(TITLE_KEY) || DEFAULT_TITLE;
} catch (e) {}

function applyTitle(text) {
  savedTitle = text;
  appTitle.textContent = text;
  document.title = text;
}

function commitTitle() {
  // One line, trimmed, at most 40 characters; empty falls back to the default
  const text = appTitle.textContent.replace(/\s+/g, " ").trim().slice(0, 40) || DEFAULT_TITLE;
  applyTitle(text);
  try {
    if (text === DEFAULT_TITLE) localStorage.removeItem(TITLE_KEY);
    else localStorage.setItem(TITLE_KEY, text);
  } catch (e) {}
}

appTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    appTitle.blur(); // blur commits
  } else if (e.key === "Escape") {
    appTitle.textContent = savedTitle;
    appTitle.blur();
  }
});
appTitle.addEventListener("blur", commitTitle);

$("editTitleBtn").addEventListener("click", () => {
  appTitle.focus();
  // Select the whole title so typing replaces it
  const range = document.createRange();
  range.selectNodeContents(appTitle);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});

applyTitle(savedTitle);

// 8. PC 시작 시 자동 실행 스위치 (설치한 exe에서만 동작)
const autostartRow = $("autostartRow");
const autostartInput = $("autostartInput");
if (!ipc) {
  autostartRow.hidden = true; // plain browser preview
} else {
  ipc.invoke("autostart:get").then(({ available, on }) => {
    autostartInput.checked = on;
    autostartInput.disabled = !available;
    if (!available) autostartRow.title = "설치한 exe에서만 쓸 수 있습니다 (개발 실행 중)";
  });
  ipc.on("autostart-changed", (_e, on) => {
    autostartInput.checked = on;
  });
  autostartInput.addEventListener("change", () => {
    ipc.invoke("autostart:set", autostartInput.checked).then((on) => {
      autostartInput.checked = on;
      showToast(
        on
          ? "PC를 켜고 Windows에 로그인하면 트레이에서 자동으로 실행됩니다."
          : "PC 시작 시 자동 실행을 껐습니다.",
      );
    });
  });
}

renderDays();
updateStatus();
renderCalendar();

// 지난번에 스케줄을 켜둔 채 종료했으면 다시 켬 (PC 자동 실행 시에도 바로 스케줄 동작)
if (savedScheduleOn()) {
  const canPlay = schedule.some((d) => d.on && d.slots.some(playable));
  if (canPlay) enableSchedule(false);
  else saveScheduleOn(false);
}
