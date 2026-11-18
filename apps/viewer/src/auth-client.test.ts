import assert from "node:assert/strict";
import { test } from "node:test";
import { getViewerSession, requestViewerLogin, signOutViewer } from "./auth-client.js";

test("viewer login request posts email without consuming or returning a login token", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const result = await requestViewerLogin("person@example.com", async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ deliveryConfigured: false }), { status: 202 });
  });

  assert.equal(requestUrl, "/auth/request-login");
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.credentials, "include");
  assert.equal(requestInit?.cache, "no-store");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { email: "person@example.com" });
  assert.deepEqual(result, { deliveryConfigured: false });
});

test("viewer login request exposes safe validation and rate-limit errors", async () => {
  await assert.rejects(
    () => requestViewerLogin("bad", async () => new Response(null, { status: 400 })),
    /valid email/,
  );
  await assert.rejects(
    () => requestViewerLogin("person@example.com", async () => new Response(null, { status: 429 })),
    /Too many sign-in requests/,
  );
});

test("viewer session retrieval handles expired sessions and returns only account details", async () => {
  assert.equal(await getViewerSession(async () => new Response(null, { status: 401 })), null);
  const account = await getViewerSession(async () => new Response(JSON.stringify({
    user: { id: "user-1", email: "person@example.com", token: "ignored" },
  }), { status: 200 }));
  assert.deepEqual(account, { id: "user-1", email: "person@example.com" });
});

test("viewer sign-out uses the cookie session endpoint", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  await signOutViewer(async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(null, { status: 204 });
  });
  assert.equal(requestUrl, "/auth/logout");
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.credentials, "include");
  assert.equal(requestInit?.cache, "no-store");
});
