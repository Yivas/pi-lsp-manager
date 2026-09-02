import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const wikiRoot = path.resolve(scriptDirectory, "..");
const distRoot = path.join(wikiRoot, "dist");
const base = "/pi-lsp-manager";

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

const requiredFiles = [
  "index.html",
  "404.html",
  "robots.txt",
  "favicon.svg",
  "sitemap-index.xml",
  "pagefind/pagefind.js",
  "start/install/index.html",
  "operations/security/index.html",
];
const errors = [];
for (const relative of requiredFiles) {
  if (!existsSync(path.join(distRoot, relative))) errors.push(`missing build output: ${relative}`);
}

if (existsSync(distRoot)) {
  for (const file of walk(distRoot).filter((entry) => entry.endsWith(".html"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\b(?:href|src)="(\/[^"#?]*)/g)) {
      const url = match[1];
      if (url !== base && !url.startsWith(`${base}/`)) {
        errors.push(`${path.relative(distRoot, file)}: generated URL escapes ${base}: ${url}`);
      }
    }
  }

  const index = readFileSync(path.join(distRoot, "index.html"), "utf8");
  for (const expected of [
    `${base}/start/install/`,
    `${base}/operations/security/`,
    "https://github.com/Yivas/pi-lsp-manager/edit/main/wiki/src/content/docs/index.mdx",
  ]) {
    if (!index.includes(expected)) errors.push(`index.html: missing expected URL: ${expected}`);
  }
  if (!index.includes(`${base}/favicon.svg`)) {
    errors.push("index.html: missing the configured favicon URL");
  }

  const robots = readFileSync(path.join(distRoot, "robots.txt"), "utf8");
  const sitemap = "https://yivas.github.io/pi-lsp-manager/sitemap-index.xml";
  if (!robots.includes(sitemap)) errors.push(`robots.txt: missing sitemap URL: ${sitemap}`);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked built documentation under ${base}.`);
}
