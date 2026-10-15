const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const icon = fs.readFileSync(path.join(root, manifest.icon));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

if (
  icon.length < 33 ||
  !icon.subarray(0, 8).equals(pngSignature) ||
  icon.readUInt32BE(8) !== 13 ||
  icon.toString("ascii", 12, 16) !== "IHDR"
) {
  throw new Error(`Extension icon must be a PNG image: ${manifest.icon}`);
}

const width = icon.readUInt32BE(16);
const height = icon.readUInt32BE(20);
if (width < 1 || height < 1 || width > 1024 || height > 1024) {
  throw new Error(`Extension icon is ${width}x${height}; Marketplace allows at most 1024x1024 pixels.`);
}

console.log(`Extension icon OK: ${manifest.icon} (${width}x${height})`);
