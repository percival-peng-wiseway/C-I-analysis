import { Container } from "@cloudflare/containers";
import { createRemoteJWKSet, jwtVerify } from "jose";

interface Env {
  ASSETS: Fetcher;
  E3_API: DurableObjectNamespace<E3ApiContainer>;
  E3_OBJECTS: R2Bucket;
  DATABASE_URL: string;
  DURABLE_API_BEARER_TOKEN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  LOCAL_WORKSPACE_ID: string;
  LOCAL_OWNER_ID: string;
  LOCAL_ACTOR_ID: string;
  LOCAL_ACTOR_DISPLAY_NAME: string;
}

const accessJwks = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

export class E3ApiContainer extends Container<Env> {
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env, {
      defaultPort: 8080,
      sleepAfter: "10m",
      envVars: {
        DATABASE_URL: env.DATABASE_URL,
        OBJECT_STORE_BACKEND: "http",
        OBJECT_STORE_HTTP_BASE_URL: "http://e3-r2.internal",
        DURABLE_API_AUTH_MODE: "restricted",
        DURABLE_API_BEARER_TOKEN: env.DURABLE_API_BEARER_TOKEN,
        LOCAL_WORKSPACE_ID: env.LOCAL_WORKSPACE_ID,
        LOCAL_OWNER_ID: env.LOCAL_OWNER_ID,
        LOCAL_ACTOR_ID: env.LOCAL_ACTOR_ID,
        LOCAL_ACTOR_DISPLAY_NAME: env.LOCAL_ACTOR_DISPLAY_NAME,
      },
    });
  }
}

E3ApiContainer.outboundByHost = {
  "e3-r2.internal": async (request, env) => {
    const url = new URL(request.url);
    let key: string;
    try {
      key = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return new Response("Invalid object key", { status: 400 });
    }
    if (!key || key.includes("..")) {
      return new Response("Invalid object key", { status: 400 });
    }

    if (request.method === "PUT") {
      await env.E3_OBJECTS.put(key, request.body, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: {
          sha256: request.headers.get("X-E3-SHA256") ?? "",
        },
      });
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET") {
      const object = await env.E3_OBJECTS.get(key);
      if (object === null) {
        return new Response(null, { status: 404 });
      }
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("ETag", object.httpEtag);
      return new Response(object.body, { headers });
    }
    if (request.method === "DELETE") {
      await env.E3_OBJECTS.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, PUT, DELETE" },
    });
  },
};

function accessIssuer(teamDomain: string): string {
  const normalized = teamDomain.replace(/\/$/, "");
  return normalized.startsWith("https://")
    ? normalized
    : `https://${normalized}`;
}

async function verifyAccess(request: Request, env: Env): Promise<Response | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return new Response("Cloudflare Access is not configured", { status: 503 });
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return new Response("Cloudflare Access authentication is required", {
      status: 403,
    });
  }

  const issuer = accessIssuer(env.ACCESS_TEAM_DOMAIN);
  try {
    let jwks = accessJwks.get(issuer);
    if (jwks === undefined) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      accessJwks.set(issuer, jwks);
    }
    await jwtVerify(token, jwks, {
      issuer,
      audience: env.ACCESS_AUD,
    });
    return null;
  } catch {
    return new Response("Invalid Cloudflare Access token", { status: 403 });
  }
}

async function proxyApi(request: Request, env: Env): Promise<Response> {
  if (!env.DATABASE_URL || !env.DURABLE_API_BEARER_TOKEN) {
    return new Response("Backend secrets are not configured", { status: 503 });
  }

  const url = new URL(request.url);
  if (url.pathname !== "/api/health") {
    const accessFailure = await verifyAccess(request, env);
    if (accessFailure !== null) {
      return accessFailure;
    }
  }

  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${env.DURABLE_API_BEARER_TOKEN}`);
  headers.delete("Cf-Access-Jwt-Assertion");
  const upstreamRequest = new Request(request, { headers });
  const containerId = env.E3_API.idFromName("primary");
  try {
    const response = await env.E3_API.get(containerId).fetch(upstreamRequest);
    if (!response.ok) {
      console.error("E3 container upstream failed", {
        status: response.status,
        body: await response.clone().text(),
      });
    }
    return response;
  } catch (error) {
    console.error(
      "E3 Durable Object proxy failed",
      error instanceof Error ? error.message : String(error),
    );
    return new Response("Backend container unavailable", { status: 503 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return proxyApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
