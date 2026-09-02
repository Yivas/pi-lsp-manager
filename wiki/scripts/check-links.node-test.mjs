import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkLinks } from "./check-links.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const docsDirectory = path.resolve(scriptsDirectory, "../src/content/docs");
const indexPath = path.join(docsDirectory, "index.mdx");

function withTemporaryContent(file, content, assertion) {
  const existed = file === indexPath;
  const original = existed ? readFileSync(file, "utf8") : null;
  try {
    writeFileSync(file, content);
    assertion();
  } finally {
    if (existed) writeFileSync(file, original);
    else unlinkSync(file);
  }
}

test("the documentation graph has no broken links", { concurrency: false }, () => {
  assert.deepEqual(checkLinks(), []);
});

test("rejects a relative page link that escapes the documentation root", { concurrency: false }, () => {
  const original = readFileSync(indexPath, "utf8");
  withTemporaryContent(indexPath, `${original}\n[invalid escape](../../outside)\n`, () => {
    assert.ok(checkLinks().some((error) => error.includes("page link escapes docs/")));
  });
});

test("rejects root-relative frontmatter links without the Pages base", { concurrency: false }, () => {
  const original = readFileSync(indexPath, "utf8");
  const invalid = original.replace(
    "link: /pi-lsp-manager/start/install/",
    "link: /start/install/",
  );
  withTemporaryContent(indexPath, invalid, () => {
    assert.ok(checkLinks().some((error) => error.includes("must include the Astro base")));
  });
});

test("rejects missing Markdown reference definitions", { concurrency: false }, () => {
  const original = readFileSync(indexPath, "utf8");
  withTemporaryContent(indexPath, `${original}\n[missing reference][]\n`, () => {
    assert.ok(
      checkLinks().some((error) => error.includes("missing Markdown reference definition")),
    );
  });
});

test("checks unregistered pages instead of hiding their broken links", { concurrency: false }, () => {
  const hiddenPath = path.join(docsDirectory, "hidden.md");
  withTemporaryContent(
    hiddenPath,
    "---\ntitle: Hidden\n---\n\n[missing](/pi-lsp-manager/does-not-exist/)\n",
    () => {
      const errors = checkLinks();
      assert.ok(errors.some((error) => error.includes("not registered in the Starlight sidebar")));
      assert.ok(errors.some((error) => error.includes("missing internal page")));
    },
  );
});
