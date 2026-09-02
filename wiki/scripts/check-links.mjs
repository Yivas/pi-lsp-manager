import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const wikiRoot = path.resolve(scriptDirectory, "..");
const docsRoot = path.join(wikiRoot, "src", "content", "docs");
const publicRoot = path.join(wikiRoot, "public");
const configPath = path.join(wikiRoot, "astro.config.mjs");
const markdownExtensions = new Set([".md", ".mdx"]);
const assetExtensions = new Set([
  ".avif",
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".map",
  ".png",
  ".svg",
  ".webp",
]);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function routeFor(file) {
  const relative = path.relative(docsRoot, file).replaceAll(path.sep, "/");
  const withoutExtension = relative.replace(/\.mdx?$/, "");
  return withoutExtension === "index" ? "/" : `/${withoutExtension}/`;
}

function slugify(heading) {
  return heading
    .replace(/`/g, "")
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function parsePage(file) {
  const source = readFileSync(file, "utf8");
  const withoutCode = source.replace(/```[\s\S]*?```/g, "");
  const anchors = new Set();
  for (const match of withoutCode.matchAll(/^#{1,6}\s+(.+)$/gm)) anchors.add(slugify(match[1]));

  const referenceDefinitions = new Map(
    [...withoutCode.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)/gm)].map((match) => [
      match[1].trim().toLowerCase(),
      match[2].trim().replace(/^<|>$/g, ""),
    ]),
  );
  const inlineLinks = [...withoutCode.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((match) =>
    match[1].trim().replace(/^<|>$/g, "").split(/\s+/, 1)[0],
  );
  const unresolvedReferences = [];
  const referenceLinks = [...withoutCode.matchAll(/!?\[([^\]]+)\]\[([^\]]*)\]/g)].flatMap(
    (match) => {
      const key = (match[2] || match[1]).trim().toLowerCase();
      if (referenceDefinitions.has(key)) return [referenceDefinitions.get(key)];
      unresolvedReferences.push(key);
      return [];
    },
  );
  const componentLinks = [...withoutCode.matchAll(/\bhref=["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  const frontmatterLinks = [...withoutCode.matchAll(/^\s+link:\s*["']?([^\s"']+)["']?\s*$/gm)].map(
    (match) => match[1],
  );
  const autolinks = [...withoutCode.matchAll(/<(https:\/\/[^>]+)>/g)].map((match) => match[1]);

  return {
    file,
    route: routeFor(file),
    anchors,
    unresolvedReferences,
    links: [
      ...new Set([
        ...inlineLinks,
        ...referenceLinks,
        ...componentLinks,
        ...frontmatterLinks,
        ...autolinks,
      ]),
    ],
  };
}

function configValue(name) {
  const config = readFileSync(configPath, "utf8");
  const match = config.match(new RegExp(`${name}:\\s*["']([^"']+)["']`));
  if (!match) throw new Error(`astro.config.mjs: missing ${name}`);
  return match[1].replace(/\/$/, "");
}

function configuredSlugs() {
  const config = readFileSync(configPath, "utf8");
  return [...config.matchAll(/slug:\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

function normalizeRoute(route) {
  const normalized = path.posix.normalize(route.startsWith("/") ? route : `/${route}`);
  return normalized === "/" ? "/" : `${normalized.replace(/\/$/, "")}/`;
}

function decodePath(rawPath, errors, file) {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    errors.push(`${file}: link contains invalid URL encoding: ${rawPath}`);
    return null;
  }
}

function logicalPath(rawPath, currentRoute, base, errors, file) {
  const decoded = decodePath(rawPath, errors, file);
  if (decoded === null) return null;
  if (!decoded.startsWith("/")) return path.posix.join(currentRoute, decoded);
  if (decoded === base || decoded.startsWith(`${base}/`)) {
    const withoutBase = decoded.slice(base.length) || "/";
    return withoutBase.startsWith("/") ? withoutBase : `/${withoutBase}`;
  }
  errors.push(`${file}: root-relative link must include the Astro base ${base}: ${rawPath}`);
  return null;
}

function validateExternal(url, errors, file) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname) {
      errors.push(`${file}: external link must be an HTTPS URL: ${url}`);
    }
  } catch {
    errors.push(`${file}: invalid external URL: ${url}`);
  }
}

function checkAsset(target, errors, file) {
  if (!isInside(wikiRoot, target)) {
    errors.push(`${file}: asset link escapes wiki/: ${target}`);
  } else if (!existsSync(target) || !statSync(target).isFile()) {
    errors.push(`${file}: missing asset: ${target}`);
  }
}

function resolveLink(page, href, pages, pagesByRoute, base, errors) {
  if (!href || href.startsWith("mailto:") || href.startsWith("tel:")) return null;
  if (/^https?:\/\//.test(href)) {
    validateExternal(href, errors, page.file);
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;

  const [rawPath, rawAnchor = ""] = href.split("#", 2);
  let target = page;
  if (rawPath) {
    const decodedRawPath = decodePath(rawPath, errors, page.file);
    if (decodedRawPath === null) return null;
    if (
      !decodedRawPath.startsWith("/") &&
      !isInside(docsRoot, path.resolve(path.dirname(page.file), decodedRawPath))
    ) {
      errors.push(`${page.file}: page link escapes docs/: ${href}`);
      return null;
    }
    const logical = logicalPath(rawPath, page.route, base, errors, page.file);
    if (logical === null) return null;
    const extension = path.extname(logical).toLowerCase();
    if (assetExtensions.has(extension)) {
      const asset = rawPath.startsWith("/")
        ? path.resolve(publicRoot, `.${logical}`)
        : path.resolve(path.dirname(page.file), decodeURIComponent(rawPath));
      checkAsset(asset, errors, page.file);
      return null;
    }
    if (markdownExtensions.has(extension)) {
      const source = path.resolve(path.dirname(page.file), decodeURIComponent(rawPath));
      if (!isInside(docsRoot, source)) {
        errors.push(`${page.file}: page link escapes docs/: ${href}`);
        return null;
      }
      target = pages.find((candidate) => candidate.file === source);
    } else {
      const targetRoute = normalizeRoute(logical);
      target = pagesByRoute.get(targetRoute);
    }
    if (!target) {
      errors.push(`${page.file}: missing internal page: ${href}`);
      return null;
    }
  }

  if (rawAnchor) {
    const decodedAnchor = decodePath(rawAnchor, errors, page.file);
    if (decodedAnchor !== null && !target.anchors.has(decodedAnchor)) {
      errors.push(`${page.file}: missing anchor in ${target.route}: #${rawAnchor}`);
    }
  }
  return target;
}

export function checkLinks() {
  const errors = [];
  const base = configValue("base");
  const files = walk(docsRoot).filter((file) => markdownExtensions.has(path.extname(file)));
  const pages = files.map(parsePage);
  const pagesByRoute = new Map(pages.map((page) => [page.route, page]));
  const configuredRoutes = new Set(
    configuredSlugs().map((slug) => (slug === "index" ? "/" : `/${slug}/`)),
  );

  for (const route of configuredRoutes) {
    if (!pagesByRoute.has(route)) errors.push(`astro.config.mjs: configured page does not exist: ${route}`);
  }
  for (const page of pages) {
    for (const reference of page.unresolvedReferences) {
      errors.push(`${page.file}: missing Markdown reference definition: ${reference}`);
    }
    if (page.route !== "/404/" && !configuredRoutes.has(page.route)) {
      errors.push(`${page.file}: page is not registered in the Starlight sidebar`);
    }
  }

  const edges = new Map();
  for (const page of pages) {
    const targets = [];
    for (const href of page.links) {
      const target = resolveLink(page, href, pages, pagesByRoute, base, errors);
      if (target) targets.push(target.route);
    }
    edges.set(page.route, targets);
  }

  const reachable = new Set(["/"]);
  const pending = ["/"];
  while (pending.length > 0) {
    const route = pending.shift();
    for (const target of edges.get(route) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        pending.push(target);
      }
    }
  }
  for (const route of configuredRoutes) {
    if (!reachable.has(route)) errors.push(`configured page is not reachable from the home page: ${route}`);
  }

  const sourceLink = "https://github.com/Yivas/pi-lsp-manager";
  if (!pages.some((page) => page.links.includes(sourceLink))) {
    errors.push(`critical external link is missing: ${sourceLink}`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkLinks();
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    const pageCount = walk(docsRoot).filter((file) => markdownExtensions.has(path.extname(file))).length;
    console.log(`Checked ${pageCount} documentation pages against ${configValue("base")}.`);
  }
}
