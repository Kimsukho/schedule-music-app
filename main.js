const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require("electron");
const fs = require("fs");
const path = require("path");

// --- 핫렐로드 (개발 실행일 때만) ---
if (!app.isPackaged) {
  try {
    require("electron-reload")(__dirname, {
      // Don't watch build output or packages: watching dist keeps app.asar open and breaks `npm run build`
      ignored: /node_modules|[\\/](dist|releases|build|docs|\.git)[\\/]/,
      electron: path.join(
        __dirname,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "electron.cmd" : "electron",
      ),
    });
  } catch (err) {
    console.log("Hot reload error:", err);
  }
}
// -------------------------

// 클릭 없이도 스케줄 음악이 재생되도록 자동재생 허용
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// PC 시작 시 자동 실행으로 켜졌는지 (창 없이 트레이에서 시작)
const AUTOSTART_ARG = "--autostart";
const startedHidden = process.argv.includes(AUTOSTART_ARG);

let mainWindow = null;
let tray = null;
let quitting = false;
let trayHintShown = false;
let scheduleOn = false; // reported by the page with each status update

// --- 창 닫기(✕) 동작: "ask" 물어보기 / "hide" 트레이로 숨기기 / "quit" 종료 ---
const CLOSE_ACTIONS = { ask: "물어보기", hide: "트레이로 숨기기", quit: "종료" };
const settingsFile = () => path.join(app.getPath("userData"), "window-settings.json");
function loadCloseAction() {
  try {
    const v = JSON.parse(fs.readFileSync(settingsFile(), "utf8")).closeAction;
    return CLOSE_ACTIONS[v] ? v : "ask";
  } catch (e) {
    return "ask";
  }
}
let closeAction = "ask";
function setCloseAction(v) {
  closeAction = v;
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify({ closeAction: v }));
  } catch (e) {}
  updateTrayMenu();
}

// 앱은 하나만 실행: 두 번째로 실행하면 기존 창을 띄움
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(() => {
    app.setAppUserModelId("com.example.schedulemusic"); // Windows notifications
    closeAction = loadCloseAction();
    createWindow();
    createTray();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    show: false,
    icon: path.join(__dirname, "assets", "icon.png"),
    // Hide the File/Edit/View menu bar (Alt shows it; shortcuts like Ctrl+R still work)
    autoHideMenuBar: true,
    // 기본 제목 표시줄 대신 앱 헤더가 그 자리를 씀. ─ □ ✕ 버튼은 Windows가 앱 배경색으로 그림.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#f0f2f5", symbolColor: "#1b2330", height: 48 },
    backgroundColor: "#f0f2f5",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false, // 실무에선 보안상 true 권장
      // 창이 숨겨져 있어도 1초 타이머가 늦어지지 않게 (스케줄 시각 확인용)
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.once("ready-to-show", () => {
    if (!startedHidden) mainWindow.show();
  });

  // 창 닫기(✕): 트레이로 숨길지(스케줄 계속) 종료할지 물어봄. "다시 묻지 않기"로 고정할 수 있음.
  // Started with Windows (unattended PC): closing just hides, as before.
  mainWindow.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    if (startedHidden || closeAction === "hide") return hideToTray();
    if (closeAction === "quit") return requestQuit();
    askOnClose();
  });

  // Ctrl+Q: quit (with the same check as the tray menu)
  mainWindow.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.control && !input.alt && input.key.toLowerCase() === "q") {
      e.preventDefault();
      requestQuit();
    }
  });
}

function hideToTray() {
  mainWindow.hide();
  if (!trayHintShown && tray && process.platform === "win32") {
    trayHintShown = true;
    tray.displayBalloon({
      title: "스케줄 플레이어",
      content: "트레이에서 계속 실행됩니다. 종료하려면 트레이 아이콘을 우클릭해 '종료'를 누르세요.",
    });
  }
}

// While the window is open the page asks in its own style (render.js showConfirm);
// when it is hidden in the tray, the Windows message box is used instead.
let pendingAsk = null;
function askInWindow(kind) {
  if (pendingAsk) return Promise.resolve({ choice: "cancel" }); // one question at a time
  return new Promise((resolve) => {
    pendingAsk = resolve;
    mainWindow.webContents.send("ask", kind, { scheduleOn });
  });
}
// The page dims itself behind a confirm box; dim the ─ □ ✕ area to the same shade
const OVERLAY = { color: "#f0f2f5", symbolColor: "#1b2330", height: 48 };
ipcMain.on("overlay-dim", (_e, dim) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setTitleBarOverlay(dim ? { ...OVERLAY, color: "#b4b8be" } : OVERLAY); // #f0f2f5 under rgba(27,35,48,.28)
  } catch (e) {}
});
ipcMain.on("ask-answer", (_e, answer) => {
  const resolve = pendingAsk;
  pendingAsk = null;
  if (resolve) resolve(answer || { choice: "cancel" });
});
const windowOpen = () => mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();

async function askOnClose() {
  if (windowOpen()) {
    const { choice, remember } = await askInWindow("close");
    if (choice === "cancel") return;
    if (remember) setCloseAction(choice === "hide" ? "hide" : "quit");
    if (choice === "hide") hideToTray();
    else quitNow();
    return;
  }
  const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "스케줄 플레이어",
    message: "창을 닫을까요?",
    detail: scheduleOn
      ? "트레이로 숨기면 스케줄이 계속 동작합니다.\n종료하면 예정된 음악이 재생되지 않습니다."
      : "트레이로 숨기면 앱이 계속 실행됩니다.",
    buttons: ["트레이로 숨기기", "종료", "취소"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    checkboxLabel: "다시 묻지 않기",
  });
  if (response === 2) return;
  if (checkboxChecked) setCloseAction(response === 0 ? "hide" : "quit");
  if (response === 0) hideToTray();
  else quitNow(); // the dialog already said what quitting means
}

// 종료: 스케줄이 켜져 있으면 예정된 음악이 재생되지 않는다고 한 번 확인
async function requestQuit() {
  if (scheduleOn && windowOpen()) {
    const { choice } = await askInWindow("quit");
    if (choice === "quit") quitNow();
    return;
  }
  if (scheduleOn) {
    const { response } = await dialog.showMessageBox(mainWindow && mainWindow.isVisible() ? mainWindow : null, {
      type: "warning",
      title: "스케줄 플레이어",
      message: "종료할까요?",
      detail: "스케줄이 켜져 있습니다. 종료하면 예정된 음악이 재생되지 않습니다.",
      buttons: ["종료", "취소"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
  }
  quitNow();
}

function quitNow() {
  quitting = true;
  app.quit();
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Tray icon from assets/tray.png (tray@2x.png is picked up on high-DPI screens)
function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
  return img.isEmpty() ? drawnTrayIcon() : img;
}

// Fallback when the file is missing: a blue circle with a white play mark
function drawnTrayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const dx = x + 0.5 - 16;
      const dy = y + 0.5 - 16;
      if (dx * dx + dy * dy > 15 * 15) continue; // transparent outside the circle
      // play triangle: x 12..23, narrowing to the right
      const inTriangle = x >= 12 && x <= 23 && Math.abs(dy) <= (23 - x) * 0.58;
      const [r, g, b] = inTriangle ? [255, 255, 255] : [0x25, 0x63, 0xeb];
      buf[o] = b; // BGRA
      buf[o + 1] = g;
      buf[o + 2] = r;
      buf[o + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size }).resize({ width: 16, height: 16 });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("스케줄 플레이어");
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: "열기", click: showWindow },
    {
      label: "PC 시작 시 자동 실행",
      type: "checkbox",
      enabled: app.isPackaged,
      checked: getAutostart(),
      click: (item) => setAutostart(item.checked),
    },
    {
      label: "창을 닫으면",
      submenu: Object.entries(CLOSE_ACTIONS).map(([value, label]) => ({
        label,
        type: "radio",
        checked: closeAction === value,
        click: () => setCloseAction(value),
      })),
    },
    { type: "separator" },
    { label: "종료", accelerator: "Ctrl+Q", click: requestQuit },
  ]);
  tray.setContextMenu(menu);
}

// --- PC 시작(Windows 로그인) 시 자동 실행 ---
// Only for the installed exe: in development it would register electron.exe itself.
function getAutostart() {
  if (!app.isPackaged) return false;
  return app.getLoginItemSettings({ args: [AUTOSTART_ARG] }).openAtLogin;
}

function setAutostart(on) {
  if (!app.isPackaged) return false;
  app.setLoginItemSettings({ openAtLogin: on, args: [AUTOSTART_ARG] });
  updateTrayMenu();
  if (mainWindow) mainWindow.webContents.send("autostart-changed", getAutostart());
  return getAutostart();
}

ipcMain.handle("autostart:get", () => ({ available: app.isPackaged, on: getAutostart() }));
ipcMain.handle("autostart:set", (_e, on) => setAutostart(!!on));

// 스케줄 상태를 트레이 아이콘 툴팁에 표시
ipcMain.on("status", (_e, text, on) => {
  scheduleOn = !!on;
  if (tray) tray.setToolTip(`스케줄 플레이어\n${text}`.slice(0, 127));
});

app.on("before-quit", () => {
  quitting = true;
});

// 창이 모두 숨겨져도 트레이에서 계속 실행 (종료는 트레이 메뉴에서)
app.on("window-all-closed", () => {});
