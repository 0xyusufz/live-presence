import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { mimeType, resolveAssetPath } from "./app-protocol.js";

const root = resolve("/tmp/live-presence-renderer");

test("app protocol resolves normal and encoded asset paths under the renderer root", () => {
  assert.equal(resolveAssetPath(root, "/index.html"), resolve(root, "index.html"));
  assert.equal(resolveAssetPath(root, "/assets/app%20bundle.js"), resolve(root, "assets/app bundle.js"));
});

test("app protocol rejects malformed encoding and traversal", () => {
  assert.equal(resolveAssetPath(root, "/%"), null);
  assert.equal(resolveAssetPath(root, "/../secret"), null);
  assert.equal(resolveAssetPath(root, "/%2e%2e/secret"), null);
  assert.equal(resolveAssetPath(root, "/..%2fsecret"), null);
  assert.equal(resolveAssetPath(root, "/%00secret"), null);
});

test("app protocol returns explicit renderer MIME types", () => {
  assert.equal(mimeType("/index.html"), "text/html; charset=utf-8");
  assert.equal(mimeType("/assets/app.js"), "text/javascript; charset=utf-8");
  assert.equal(mimeType("/assets/app.unknown"), "application/octet-stream");
});
