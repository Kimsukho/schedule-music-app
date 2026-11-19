// Renders assets/icon.svg to PNGs in Electron (canvas keeps transparency) and packs a Windows .ico.
// Usage: npm run icon   (= electron scripts/make-icon.js .)
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const appDir = process.argv[process.argv.length - 1];

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(appDir, "assets", "icon.svg"), "utf8");
  const w = new BrowserWindow({ show: false });
  await w.loadURL("data:text/html,<html><body></body></html>");
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
  const urls = await w.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = "data:image/svg+xml;base64," + ${JSON.stringify(Buffer.from(svg).toString("base64"))};
    await img.decode();
    const out = {};
    for (const s of ${JSON.stringify(sizes)}) {
      const c = document.createElement("canvas");
      c.width = c.height = s;
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, s, s);
      out[s] = c.toDataURL("image/png");
    }
    return out;
  })()`);
  const png = (s) => Buffer.from(urls[s].split(",")[1], "base64");

  fs.mkdirSync(path.join(appDir, "build"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "assets", "icon.png"), png(256)); // window icon
  fs.writeFileSync(path.join(appDir, "assets", "tray.png"), png(16)); // tray icon
  fs.writeFileSync(path.join(appDir, "assets", "tray@2x.png"), png(32)); // tray on high-DPI screens
  fs.writeFileSync(path.join(appDir, "build", "icon.png"), png(512));

  // ICO with PNG-compressed entries (supported since Windows Vista)
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const images = icoSizes.map(png);
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((data, k) => {
    const s = icoSizes[k];
    const e = 6 + 16 * k;
    header.writeUInt8(s >= 256 ? 0 : s, e);
    header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  fs.writeFileSync(path.join(appDir, "build", "icon.ico"), Buffer.concat([header, ...images]));
  console.log("wrote icons:", icoSizes.join(","));
  app.exit(0);
});
