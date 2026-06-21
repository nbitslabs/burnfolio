import { mkdir, readFile, writeFile } from "node:fs/promises";

const sourcePath = "worker/index.js";
const cssPath = "worker/styles.generated.css";
const outPath = "dist/worker/index.js";

const [source, css] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(cssPath, "utf8"),
]);

const escapedCSS = css
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const built = source.replace(
  /function css\(\) \{\n[\s\S]*?\n\}\n\nfunction signupScript\(\) \{/,
  `function css() {\n  return \`${escapedCSS}\`;\n}\n\nfunction signupScript() {`
);

if (built === source) {
  throw new Error("Could not replace css() in Worker source");
}

await mkdir("dist/worker", { recursive: true });
await writeFile(outPath, built);
