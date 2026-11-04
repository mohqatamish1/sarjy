import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
const LIMIT = 11 * 1024 * 1024;

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  // Fixed upstream, safe path segments, no user-supplied target URLs.
  if (
    path.some(
      (segment) => !/^[a-zA-Z0-9._-]+$/.test(segment) || segment === "..",
    )
  ) {
    return Response.json({ detail: "Invalid path" }, { status: 400 });
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > LIMIT)
    return Response.json({ detail: "Request is too large" }, { status: 413 });
  const headers = new Headers();
  for (const key of ["content-type", "cookie", "origin"]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (request.body) {
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > LIMIT) {
          await reader.cancel();
          return Response.json(
            { detail: "Request is too large" },
            { status: 413 },
          );
        }
        chunks.push(value);
      }
    }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const upstream = await fetch(
      `${process.env.BACKEND_URL || "http://backend:8000"}/api/${path.join("/")}${request.nextUrl.search}`,
      {
        method: request.method,
        headers,
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(70000),
        redirect: "manual",
      },
    );
    const outputHeaders = new Headers({
      "Content-Type":
        upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
    });
    for (const cookie of upstream.headers.getSetCookie())
      outputHeaders.append("Set-Cookie", cookie);
    const speechParts = upstream.headers.get("x-speech-parts");
    if (speechParts) outputHeaders.set("X-Speech-Parts", speechParts);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: outputHeaders,
    });
  } catch {
    return Response.json(
      {
        detail:
          "The assistant is temporarily unreachable. Check that the backend is running.",
      },
      { status: 502 },
    );
  }
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
