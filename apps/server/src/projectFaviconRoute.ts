import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const FAVICON_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const FALLBACK_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;

// Well-known favicon paths checked relative to an app root.
const FAVICON_RELATIVE_PATHS = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
];

// Files that may contain a <link rel="icon"> or icon metadata declaration, relative to an app root.
const ICON_SOURCE_RELATIVE_PATHS = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
];

// Directories commonly containing sub-apps in monorepos.
const MONOREPO_APP_DIRS = ["apps", "packages"];

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  const objMatch = source.match(LINK_ICON_OBJ_RE);
  if (objMatch?.[1]) return objMatch[1];
  return null;
}

function resolveIconHref(projectCwd: string, href: string): string[] {
  const clean = href.replace(/^\//, "");
  return [path.join(projectCwd, "public", clean), path.join(projectCwd, clean)];
}

function isPathWithinProject(projectCwd: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(projectCwd), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function serveFaviconFile(filePath: string, res: http.ServerResponse): void {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = FAVICON_MIME_TYPES[ext] ?? "application/octet-stream";
  fs.readFile(filePath, (readErr, data) => {
    if (readErr) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Read error");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
    });
    res.end(data);
  });
}

function serveFallbackFavicon(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(FALLBACK_FAVICON_SVG);
}

/**
 * Discover immediate subdirectories inside a monorepo app directory.
 * Returns absolute paths (e.g. ["/project/apps/web", "/project/apps/admin"]).
 */
function listSubDirs(parentDir: string, cb: (dirs: string[]) => void): void {
  fs.readdir(parentDir, { withFileTypes: true }, (err, entries) => {
    if (err || !entries) {
      cb([]);
      return;
    }
    cb(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => path.join(parentDir, e.name)),
    );
  });
}

/**
 * Collect all monorepo sub-app directories for the given project root.
 * Scans MONOREPO_APP_DIRS (apps/, packages/) in parallel, then returns
 * all discovered subdirectories.
 */
function collectMonorepoAppDirs(projectCwd: string, cb: (dirs: string[]) => void): void {
  let pending = MONOREPO_APP_DIRS.length;
  if (pending === 0) {
    cb([]);
    return;
  }
  const allDirs: string[] = [];
  for (const dir of MONOREPO_APP_DIRS) {
    listSubDirs(path.join(projectCwd, dir), (dirs) => {
      allDirs.push(...dirs);
      pending--;
      if (pending === 0) cb(allDirs);
    });
  }
}

export function tryHandleProjectFaviconRequest(url: URL, res: http.ServerResponse): boolean {
  if (url.pathname !== "/api/project-favicon") {
    return false;
  }

  const projectCwd = url.searchParams.get("cwd");
  if (!projectCwd) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing cwd parameter");
    return true;
  }

  const tryResolvedPaths = (paths: string[], index: number, onExhausted: () => void): void => {
    if (index >= paths.length) {
      onExhausted();
      return;
    }
    const candidate = paths[index]!;
    if (!isPathWithinProject(projectCwd, candidate)) {
      tryResolvedPaths(paths, index + 1, onExhausted);
      return;
    }
    fs.stat(candidate, (err, stats) => {
      if (err || !stats?.isFile()) {
        tryResolvedPaths(paths, index + 1, onExhausted);
        return;
      }
      serveFaviconFile(candidate, res);
    });
  };

  /** Try favicon file candidates relative to a given root directory. */
  const tryCandidatesIn = (
    root: string,
    candidates: string[],
    index: number,
    onExhausted: () => void,
  ): void => {
    if (index >= candidates.length) {
      onExhausted();
      return;
    }
    const candidate = path.join(root, candidates[index]!);
    if (!isPathWithinProject(projectCwd, candidate)) {
      tryCandidatesIn(root, candidates, index + 1, onExhausted);
      return;
    }
    fs.stat(candidate, (err, stats) => {
      if (err || !stats?.isFile()) {
        tryCandidatesIn(root, candidates, index + 1, onExhausted);
        return;
      }
      serveFaviconFile(candidate, res);
    });
  };

  /** Try source files that may contain icon link declarations relative to a given root. */
  const trySourceFilesIn = (
    root: string,
    sourceFiles: string[],
    index: number,
    onExhausted: () => void,
  ): void => {
    if (index >= sourceFiles.length) {
      onExhausted();
      return;
    }
    const sourceFile = path.join(root, sourceFiles[index]!);
    fs.readFile(sourceFile, "utf8", (err, content) => {
      if (err) {
        trySourceFilesIn(root, sourceFiles, index + 1, onExhausted);
        return;
      }
      const href = extractIconHref(content);
      if (!href) {
        trySourceFilesIn(root, sourceFiles, index + 1, onExhausted);
        return;
      }
      // Resolve href relative to the sub-app root first, then the project root.
      const candidates = [...resolveIconHref(root, href), ...resolveIconHref(projectCwd, href)];
      // Deduplicate while preserving order
      const seen = new Set<string>();
      const unique = candidates.filter((c) => {
        if (seen.has(c)) return false;
        seen.add(c);
        return true;
      });
      tryResolvedPaths(unique, 0, () =>
        trySourceFilesIn(root, sourceFiles, index + 1, onExhausted),
      );
    });
  };

  /** Search a single root directory for favicons (candidates first, then source files). */
  const tryRoot = (root: string, onExhausted: () => void): void => {
    tryCandidatesIn(root, FAVICON_RELATIVE_PATHS, 0, () => {
      trySourceFilesIn(root, ICON_SOURCE_RELATIVE_PATHS, 0, onExhausted);
    });
  };

  /** Iterate through a list of root directories. */
  const tryRoots = (roots: string[], index: number, onExhausted: () => void): void => {
    if (index >= roots.length) {
      onExhausted();
      return;
    }
    tryRoot(roots[index]!, () => tryRoots(roots, index + 1, onExhausted));
  };

  // 1. Try the project root first (existing behavior).
  tryRoot(projectCwd, () => {
    // 2. Discover monorepo sub-apps and try each one.
    collectMonorepoAppDirs(projectCwd, (appDirs) => {
      tryRoots(appDirs, 0, () => {
        // 3. Nothing found — serve fallback.
        serveFallbackFavicon(res);
      });
    });
  });

  return true;
}
