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
const ICON_SETTINGS = `<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.48.48 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z" /></svg>`;
const ICON_DELETE =`<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" /></svg>`;

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
    .map((t) => ({
      name: t.name,
      path: t.path,
      src: toFileUrl(t.path),
      duration: typeof t.duration === "number" ? t.duration : null, // seconds, filled in by probeDurations()
    }))
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
// 75 -> "1:15", 4383 -> "1:13:03"
const fmt = (s) => {
  if (!isFinite(s)) return "0:00";
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(t % 60)}` : `${m}:${pad(t % 60)}`;
};
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const startMin = (slot) => slot.h * 60 + slot.m;
// Same start and stop time: shown as an error and never played
const zeroLength = (slot) => slot.eh !== null && slot.eh * 60 + slot.em === startMin(slot);
// Has songs and a usable time window
const playable = (slot) => slot.tracks.some((t) => !t.missing) && !zeroLength(slot);

function save() {
  try {
    const data = schedule.map((d) => ({
      on: d.on,
      slots: d.slots.map((s) => ({
        h: s.h,
        m: s.m,
        eh: s.eh,
        em: s.em,
        tracks: s.tracks
          .filter((t) => t.path)
          .map((t) => ({ name: t.name, path: t.path, duration: t.duration ?? null })),
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

// --- 곡 길이 ---
// Read each song's length once from its file metadata and keep it with the schedule.
// A file that can't be opened (moved or deleted) is marked missing.
const probing = new Set();
let probeRenderTimer = null;

function probeDuration(src) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = "metadata";
    a.onloadedmetadata = () => resolve(isFinite(a.duration) ? a.duration : null);
    a.onerror = () => resolve(undefined); // undefined = file not found / unreadable
    a.src = src;
  });
}

function probeDurations() {
  schedule.forEach((d) =>
    d.slots.forEach((s) =>
      s.tracks.forEach((t) => {
        if (t.duration != null || t.missing || probing.has(t)) return;
        probing.add(t);
        probeDuration(t.src).then((sec) => {
          probing.delete(t);
          if (sec === undefined) t.missing = true;
          else t.duration = sec;
          // Re-render once after a batch of files has been read
          clearTimeout(probeRenderTimer);
          probeRenderTimer = setTimeout(() => {
            save();
            renderDays();
            renderCalendar();
            if (currentTracks.length) renderPlaylist();
          }, 50);
        });
      }),
    ),
  );
}

// Total seconds of a slot's songs; null while some lengths are still unknown
function slotMusicSeconds(slot) {
  let total = 0;
  for (const t of slot.tracks) {
    if (t.missing) continue;
    if (t.duration == null) return null;
    total += t.duration;
  }
  return total;
}

// 754 -> "12분 34초", 3720 -> "1시간 2분", 45 -> "45초"
function lengthText(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return m ? `${h}시간 ${m}분` : `${h}시간`;
  if (m > 0) return r ? `${m}분 ${r}초` : `${m}분`;
  return `${r}초`;
}

// Stop time that fits the songs exactly (rounded up to the minute)
function fittedEnd(slot) {
  const total = slotMusicSeconds(slot);
  if (!total) return null;
  const end = (startMin(slot) + Math.max(1, Math.ceil(total / 60))) % 1440;
  return { eh: Math.floor(end / 60), em: end % 60 };
}

function renderSlot(d, slot, j, issue) {
  const empty = slot.tracks.length === 0;
  const label = `${d.name}요일 시간대 ${j + 1}`;
  // Song lengths, total always first: "총 2분 30초 · a.mp3 2:30", "총 3분 · a.mp3 0:30, b.mp3 2:30"
  const total = slotMusicSeconds(slot);
  const names = slot.tracks
    .map((t) => (t.missing ? `${t.name} (파일 없음)` : t.duration != null ? `${t.name} ${fmt(t.duration)}` : t.name))
    .join(", ");
  const summary = empty
    ? "곡 없음"
    : escapeHtml(total ? `총 ${lengthText(total)} · ${names}` : names);
  const note = issue
    ? `<p class="slot-issue" role="alert">${escapeHtml(issue.msgs.join(" · "))}</p>`
    : "";
  // Button that sets the stop time to start + total song length
  const target = empty ? null : fittedEnd(slot);
  const fitBtn =
    target && (slot.eh !== target.eh || slot.em !== target.em)
      ? `<button class="btn-mini" data-act="fit-end" title="종료를 ${pad(target.eh)}:${pad(target.em)}으로 맞춤">곡 길이에 맞춤</button>`
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
        <button class="btn-mini" data-act="pick">${empty ? "곡 선택" : "곡 변경"}</button>
        <span class="day-tracks${empty ? " empty" : ""}" title="${summary}">${summary}</span>
        ${fitBtn}
        ${empty ? "" : `
        <button class="icon-mini" data-act="preview" aria-label="${label} 미리듣기">${ICON_PLAY}</button>
        <button class="icon-mini" data-act="clear" aria-label="${label} 곡 비우기">${ICON_CLEAR}</button>`}
      </div>
      ${note}
    </div>`;
}

// 요일 접기: 켜진 요일도 접어서 한 줄로 볼 수 있음 (접은 상태는 저장)
const FOLD_KEY = "schedule-player-folded";
let folded = new Set();
try {
  folded = new Set(JSON.parse(localStorage.getItem(FOLD_KEY)) || []);
} catch (e) {}
function saveFolded() {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify([...folded]));
  } catch (e) {}
}
function unfold(i) {
  if (folded.delete(i)) saveFolded();
}

const ICON_CHEVRON = `<svg viewBox="0 0 24 24"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z" /></svg>`;

// --- 다른 요일에 복사 ---
let copyFrom = null; // weekday whose copy panel is open
let copyTargets = new Set();

function renderCopyPanel(i) {
  const chips = DAYS.map((d, k) =>
    k === i
      ? ""
      : `<button class="chip${copyTargets.has(k) ? " on" : ""}" data-act="copy-pick" data-to="${k}" aria-pressed="${copyTargets.has(k)}">${d.name}</button>`,
  ).join("");
  return `
    <div class="copy-panel">
      <div class="copy-row">
        <span class="copy-label">복사할 요일</span>
        <div class="chips">${chips}</div>
      </div>
      <p class="copy-hint">선택한 요일의 기존 시간대는 ${DAYS[i].name}요일 시간대로 바뀝니다.</p>
      <div class="copy-row end">
        <button class="btn-mini" data-act="copy-cancel">취소</button>
        <button class="btn-mini primary" data-act="copy-do"${copyTargets.size ? "" : " disabled"}>복사</button>
      </div>
    </div>`;
}

// Copy weekday `from`'s slots (and songs) onto each target, turning it on.
// A target whose copy would overlap another day's slots is left as it was.
function copyDay(from, targets) {
  const copied = [];
  const skipped = [];
  for (const k of targets) {
    const target = schedule[k];
    const old = { on: target.on, slots: target.slots };
    const before = new Map();
    schedule.forEach((d) => d.slots.forEach((s) => before.set(s, errorMsgs(s))));
    target.slots = schedule[from].slots.map((s) => ({ ...s, tracks: s.tracks.map((t) => ({ ...t })) }));
    target.on = true;
    let reason = null;
    for (const [owner, d] of schedule.entries()) {
      for (const s of d.slots) {
        const fresh = errorMsgs(s).filter((msg) => !(before.get(s) || []).includes(msg));
        if (fresh.length && !reason) reason = `${slotName(owner, s)} 시간대가 ${fresh[0]}`;
      }
    }
    if (reason) {
      Object.assign(target, old);
      skipped.push(`${DAYS[k].name}요일(${reason})`);
    } else {
      copied.push(k);
    }
  }
  return { copied, skipped };
}

// One line for a day that is off or folded: its time slots
function daySummary(day, isFolded) {
  const ranges = day.slots.map(rangeText).join(", ");
  if (!day.on) return day.slots.length ? `꺼짐 · ${ranges}` : "꺼짐";
  if (isFolded) return day.slots.length ? ranges : "시간대 없음";
  return "";
}

// 요일 목록 그리기 (켜져 있고 접지 않은 요일만 시간대를 펼쳐서 보여줌)
function renderDays() {
  const issues = slotIssues();
  daysEl.innerHTML = DAYS.map((d, i) => {
    const day = schedule[i];
    const isFolded = day.on && folded.has(i);
    const open = day.on && !isFolded;
    const hasIssue = day.slots.some((s) => issues.has(s));
    const body = open
      ? `<div class="slots">
          ${day.slots.map((slot, j) => renderSlot(d, slot, j, issues.get(slot))).join("")}
          <div class="slot-actions">
            <button class="add-slot" data-act="add-slot">+ 시간대 추가</button>
            ${day.slots.length && copyFrom !== i ? `<button class="add-slot" data-act="copy-open">다른 요일에 복사</button>` : ""}
          </div>
          ${copyFrom === i ? renderCopyPanel(i) : ""}
        </div>`
      : "";
    const summary = daySummary(day, isFolded);
    // Fold button sits before the weekday name; off days keep an empty spot so names line up
    const foldBtn = day.on
      ? `<button class="icon-mini fold${open ? " open" : ""}" data-act="fold" aria-expanded="${open}" aria-label="${d.name}요일 ${open ? "접기" : "펼치기"}">${ICON_CHEVRON}</button>`
      : `<span class="fold-space"></span>`;
    return `
      <div class="day${day.on ? " on" : ""}${isFolded ? " folded" : ""}" data-i="${i}">
        <div class="day-main">
          ${foldBtn}
          <div class="day-name">${d.name}</div>
          <span class="day-summary${isFolded && hasIssue ? " warn" : ""}"${day.on ? ' data-act="fold"' : ""}>${escapeHtml(summary)}${isFolded && hasIssue ? " · 시간 확인 필요" : ""}</span>
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
    if (!clash) unfold(i); // a day just turned on opens so its slots can be set
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

  if (act === "fold") {
    if (folded.has(i)) folded.delete(i);
    else folded.add(i);
    saveFolded();
    renderDays();
    return;
  }

  if (act === "copy-open") {
    copyFrom = i;
    copyTargets = new Set();
    renderDays();
    return;
  }
  if (act === "copy-cancel") {
    copyFrom = null;
    renderDays();
    return;
  }
  if (act === "copy-pick") {
    const k = Number(btn.dataset.to);
    if (copyTargets.has(k)) copyTargets.delete(k);
    else copyTargets.add(k);
    renderDays();
    return;
  }
  if (act === "copy-do") {
    const { copied, skipped } = copyDay(i, [...copyTargets].sort((a, b) => a - b));
    copyFrom = null;
    // Fold the days that received the copy so the list stays short
    copied.forEach((k) => folded.add(k));
    saveFolded();
    refresh();
    probeDurations();
    const names = copied.map((k) => DAYS[k].name).join("·");
    const msgs = [];
    if (copied.length) msgs.push(`${DAYS[i].name}요일 시간대를 ${names}요일에 복사했습니다.`);
    if (skipped.length) msgs.push(`겹쳐서 복사하지 않음: ${skipped.join(", ")}`);
    showToast(msgs.join(" "));
    return;
  }

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
  } else if (act === "fit-end") {
    // 종료 시간을 곡 길이에 맞춤 (겹치면 막고 원래대로)
    const slot = day.slots[j];
    const target = fittedEnd(slot);
    if (!target) return;
    const before = { eh: slot.eh, em: slot.em };
    const errorsBefore = errorMsgs(slot);
    Object.assign(slot, target);
    const newErrors = errorMsgs(slot).filter((msg) => !errorsBefore.includes(msg));
    if (newErrors.length > 0) {
      Object.assign(slot, before);
      refresh();
      showToast(`곡 길이에 맞출 수 없습니다. ${newErrors.join(", ")}`);
      return;
    }
    refresh();
    showToast(`${slotName(i, slot)}: 종료를 곡 길이에 맞췄습니다.`);
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
      ? { name: file.name, path: file.path, src, duration: null }
      : { name: file.name, path: null, src: URL.createObjectURL(file), duration: null };
  });
  refresh();
  probeDurations(); // 곡 길이 읽기
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
  toggleScheduleBtn.className = isScheduled ? "btn btn-ghost" : "btn btn-primary";
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
  currentTracks = slot.tracks.filter((t) => !t.missing); // skip files that can't be found
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
      // One line: name (cut with …) and its length on the right
      const row = document.createElement("div");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = t.name;
      name.title = t.name;
      row.append(name);
      if (t.duration != null) {
        const len = document.createElement("span");
        len.className = "len";
        len.textContent = fmt(t.duration);
        row.append(len);
      }
      li.append(row);
      if (idx === currentIndex) li.className = "current";
      return li;
    }),
  );
}

function renderNowPlaying() {
  const t = currentTracks[currentIndex];
  nowPlaying.textContent = t
    ? currentLabel // which song is playing shows in the highlighted list below
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
          `<li><i class="dot${s.tracks.length ? "" : " empty"}"></i><b>${rangeText(s)}</b><span>${!s.tracks.length ? "곡 없음" : slotMusicSeconds(s) ? `총 ${lengthText(slotMusicSeconds(s))}` : ""}</span></li>`,
      )
      .join("")}</ul>`;
  calDetail.innerHTML = `
    <div class="cal-detail-head">
      <h4>${title}</h4>
      <button class="icon-mini" data-act="goto-day" data-i="${i}" aria-label="${DAYS[i].name}요일 설정" title="${DAYS[i].name}요일 설정">${ICON_SETTINGS}</button>
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
  unfold(Number(btn.dataset.i)); // open a folded day before jumping to it
  renderDays();
  const row = daysEl.querySelector(`.day[data-i="${btn.dataset.i}"]`);
  if (!row) return;
  // Scroll only the weekday list (scrollIntoView would also shift the page layout)
  const list = daysEl;
  if (list.scrollHeight > list.clientHeight) {
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTo({ top: Math.max(0, top - 8), behavior: "smooth" });
  } else {
    row.scrollIntoView({ behavior: "smooth", block: "center" }); // narrow window: the page scrolls
  }
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
probeDurations(); // 저장된 곡 중 길이를 아직 모르는 곡 읽기

// 지난번에 스케줄을 켜둔 채 종료했으면 다시 켬 (PC 자동 실행 시에도 바로 스케줄 동작)
if (savedScheduleOn()) {
  const canPlay = schedule.some((d) => d.on && d.slots.some(playable));
  if (canPlay) enableSchedule(false);
  else saveScheduleOn(false);
}

// Wide window: the page itself never scrolls (only the weekday list does). Focus or
// scroll-into-view can still nudge it, which cuts off the header, so put it back.
window.addEventListener("scroll", () => {
  if (window.innerWidth > 760 && window.scrollY !== 0) window.scrollTo(0, 0);
});
