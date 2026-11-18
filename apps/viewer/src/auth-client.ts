export type ViewerAccount = {
  id: string;
  email: string;
};

type ViewerFetch = typeof fetch;

export async function getViewerSession(fetcher: ViewerFetch = fetch): Promise<ViewerAccount | null> {
  const response = await fetcher("/auth/session", {
    credentials: "include",
    cache: "no-store",
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("The sign-in service is unavailable.");

  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body.user) ||
    typeof body.user.id !== "string" || typeof body.user.email !== "string") {
    throw new Error("The sign-in service returned an invalid session.");
  }
  return { id: body.user.id, email: body.user.email };
}

export async function requestViewerLogin(
  email: string,
  fetcher: ViewerFetch = fetch,
): Promise<{ deliveryConfigured: boolean }> {
  const response = await fetcher("/auth/request-login", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) {
    if (response.status === 429) throw new Error("Too many sign-in requests. Please try again later.");
    if (response.status === 400) throw new Error("Enter a valid email address.");
    throw new Error("A sign-in link could not be requested.");
  }

  const body: unknown = await response.json();
  return {
    deliveryConfigured: !isRecord(body) || body.deliveryConfigured !== false,
  };
}

export async function signOutViewer(fetcher: ViewerFetch = fetch): Promise<void> {
  const response = await fetcher("/auth/logout", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Sign-out could not be completed.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
