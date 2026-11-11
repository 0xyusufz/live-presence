import { resolve, sep } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function resolveAssetPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes("..")) return null;
  const normalizedRoot = resolve(root);
  const requested = resolve(normalizedRoot, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (requested !== normalizedRoot && !requested.startsWith(`${normalizedRoot}${sep}`)) return null;
  return requested;
}

export function mimeType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}
