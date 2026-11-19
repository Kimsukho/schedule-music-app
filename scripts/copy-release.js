// Copies the installer just built in dist/ into releases/ (kept per version).
// Run by `npm run release` after electron-builder.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const file = `${pkg.name} Setup ${pkg.version}.exe`;
const from = path.join(root, "dist", file);
const toDir = path.join(root, "releases");
const to = path.join(toDir, file);

if (!fs.existsSync(from)) {
  console.error(`설치 파일이 없습니다: ${from}`);
  process.exit(1);
}
fs.mkdirSync(toDir, { recursive: true });
if (fs.existsSync(to)) {
  console.log(`같은 버전(${pkg.version})이 이미 있어 새로 만든 파일로 바꿉니다. 버전을 올리려면 package.json의 version을 바꾸세요.`);
}
fs.copyFileSync(from, to);
console.log(`releases\\${file} 에 저장했습니다.`);
