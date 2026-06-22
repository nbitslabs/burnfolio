import { mkdir, readFile, writeFile } from "node:fs/promises";

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
