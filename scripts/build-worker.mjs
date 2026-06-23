import { mkdir, readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

const sourcePath = "worker/index.js";
const cssPath = "worker/styles.generated.css";
const outPath = "dist/worker/index.js";

const [source, css] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(cssPath, "utf8"),
]);

const assetFiles = {
  "logo.svg": { path: "worker/assets/logo.svg", type: "image/svg+xml; charset=utf-8", encoding: "text" },
  "pyro.svg": { path: "worker/assets/pyro.svg", type: "image/svg+xml; charset=utf-8", encoding: "text" },
  "pyro-gpu.svg": { path: "worker/assets/pyro-gpu.svg", type: "image/svg+xml; charset=utf-8", encoding: "text" },
  "pyro-512.png": { path: "worker/assets/pyro-512.png", type: "image/png", encoding: "base64" },
  "og-landing.png": { path: "worker/assets/og-landing.png", type: "image/png", encoding: "base64" },
};

const assets = Object.fromEntries(await Promise.all(Object.entries(assetFiles).map(async ([name, asset]) => {
  const buffer = await readFile(asset.path);
  return [name, {
    type: asset.type,
    encoding: asset.encoding,
    body: asset.encoding === "base64" ? buffer.toString("base64") : buffer.toString("utf8"),
  }];
})));

const landing = decodePNG(await readFile("worker/assets/og-landing.png"));
assets["og-landing-rgba"] = {
  type: "image/raw-rgba",
  encoding: "base64",
  width: landing.width,
  height: landing.height,
  body: Buffer.from(landing.pixels).toString("base64"),
};

const escapedCSS = css
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

let built = source.replace(
  /function css\(\) \{\n[\s\S]*?\n\}/,
  `function css() {\n  return \`${escapedCSS}\`;\n}`
);

if (built === source) {
  throw new Error("Could not replace css() in Worker source");
}

const withAssets = built.replace(
  /function assetData\(\) \{\n[\s\S]*?\n\}/,
  `function assetData() {\n  return ${JSON.stringify(assets)};\n}`
);

if (withAssets === built) {
  throw new Error("Could not replace assetData() in Worker source");
}

built = withAssets;

await mkdir("dist/worker", { recursive: true });
await writeFile(outPath, built);

function decodePNG(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) throw new Error("Invalid PNG signature");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) throw new Error("Only non-interlaced 8-bit RGBA PNGs are supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  const compressed = Buffer.concat(idat);
  const raw = inflateSync(compressed);
  const stride = width * 4;
  const pixels = new Uint8Array(width * height * 4);
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[input++];
    const row = raw.subarray(input, input + stride);
    input += stride;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[out + x - 4] : 0;
      const up = y > 0 ? pixels[out + x - stride] : 0;
      const upLeft = y > 0 && x >= 4 ? pixels[out + x - stride - 4] : 0;
      let value = row[x];
      if (filter === 1) value = (value + left) & 255;
      else if (filter === 2) value = (value + up) & 255;
      else if (filter === 3) value = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) value = (value + paeth(left, up, upLeft)) & 255;
      else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
      pixels[out + x] = value;
    }
  }
  return { width, height, pixels };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
