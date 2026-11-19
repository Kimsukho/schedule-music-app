const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require("electron");
const path = require("path");

// --- 핫렐로드 (개발 실행일 때만) ---
if (!app.isPackaged) {
  try {
    require("electron-reload")(__dirname, {
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

// 앱은 하나만 실행: 두 번째로 실행하면 기존 창을 띄움
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(() => {
    app.setAppUserModelId("com.example.schedulemusic"); // Windows notifications
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

  // 창을 닫아도 종료하지 않고 트레이로 숨김 (스케줄은 계속 동작)
  mainWindow.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    if (!trayHintShown && tray && process.platform === "win32") {
      trayHintShown = true;
      tray.displayBalloon({
        title: "스케줄 음악 플레이어",
        content: "창을 닫아도 트레이에서 계속 실행됩니다. 종료하려면 트레이 아이콘 메뉴에서 '종료'를 누르세요.",
      });
    }
  });
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
  tray.setToolTip("스케줄 음악 플레이어");
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
    { type: "separator" },
    {
      label: "종료",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
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
ipcMain.on("status", (_e, text) => {
  if (tray) tray.setToolTip(`스케줄 음악 플레이어\n${text}`.slice(0, 127));
});

app.on("before-quit", () => {
  quitting = true;
});

// 창이 모두 숨겨져도 트레이에서 계속 실행 (종료는 트레이 메뉴에서)
app.on("window-all-closed", () => {});
