import { Container, type StopParams } from "@cloudflare/containers";
export { ContainerProxy } from "@cloudflare/containers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { canPrepareContainerRetry, canRetryContainerFailure } from "./container-retry";

interface Env {
  ASSETS: Fetcher;
  E3_API: DurableObjectNamespace<E3ApiContainer>;
  E3_OBJECTS: R2Bucket;
  DATABASE_URL: string;
  DURABLE_API_BEARER_TOKEN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ACCESS_AUTH_MODE: "required" | "disabled";
  LOCAL_WORKSPACE_ID: string;
  LOCAL_OWNER_ID: string;
  LOCAL_ACTOR_ID: string;
  LOCAL_ACTOR_DISPLAY_NAME: string;
  CI_SCENARIO_PROCESS_WORKERS: string;
  CI_SCENARIO_PROCESS_TIMEOUT_SECONDS: string;
}

const accessJwks = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

const API_PORT = 8080;
const CONTAINER_INSTANCE_TIMEOUT_MS = 60_000;
const CONTAINER_PORT_TIMEOUT_MS = 120_000;
const CONTAINER_WAIT_INTERVAL_MS = 500;
const INFRASTRUCTURE_RETRY_AFTER_SECONDS = 5;
const REQUEST_ID_HEADER = "X-E3-Request-ID";
const OPERATION_HEADER = "X-E3-Operation";

type InfrastructureErrorCode =
  | "access_unconfigured"
  | "backend_unconfigured"
  | "container_provisioning"
  | "container_start_timeout"
  | "container_unavailable";

interface OperationalLog {
  request_id: string;
  operation: string;
  status: string | number;
  elapsed: number;
}

function logOperation(level: "error" | "info", event: OperationalLog): void {
  const logger = level === "error" ? console.error : console.log;
  logger("e3_cloudflare", event);
}

function infrastructureErrorResponse(
  errorCode: InfrastructureErrorCode,
  message: string,
  requestId: string,
): Response {
  return new Response(
    JSON.stringify({ error_code: errorCode, message, request_id: requestId }),
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": String(INFRASTRUCTURE_RETRY_AFTER_SECONDS),
      },
    },
  );
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

function classifyContainerError(error: unknown): InfrastructureErrorCode {
  const message = errorMessage(error);
  if (
    message.includes(
      "there is no container instance that can be provided to this durable object",
    ) ||
    message.includes("there is no container instance available at this time") ||
    message.includes("currently provisioning the container")
  ) {
    return "container_provisioning";
  }
  if (
    message.includes("container did not start after") ||
    message.includes("the container is not listening") ||
    message.includes("failed to verify port")
  ) {
    return "container_start_timeout";
  }
  return "container_unavailable";
}

function infrastructureMessage(errorCode: InfrastructureErrorCode): string {
  switch (errorCode) {
    case "access_unconfigured":
      return "Cloudflare Access is not configured.";
    case "backend_unconfigured":
      return "The analysis service is not configured.";
    case "container_provisioning":
      return "The analysis service is starting. Try again shortly.";
    case "container_start_timeout":
      return "The analysis service did not become ready in time. Wait a moment, then run Analysis again.";
    case "container_unavailable":
      return "The analysis connection was interrupted before completion could be confirmed. Wait a moment, then run Analysis again.";
  }
}

async function infrastructureErrorCode(
  response: Response,
): Promise<InfrastructureErrorCode | null> {
  if (response.status !== 500 && response.status !== 503) {
    return null;
  }
  const body = await response.clone().text();
  if (
    response.status === 500 &&
    (
      body === "Container suddenly disconnected, try again" ||
      body.startsWith("Error proxying request to container:")
    )
  ) {
    return "container_unavailable";
  }
  if (response.status !== 503) {
    return null;
  }
  try {
    const payload = JSON.parse(body) as { error_code?: unknown };
    if (
      payload.error_code === "access_unconfigured" ||
      payload.error_code === "backend_unconfigured" ||
      payload.error_code === "container_provisioning" ||
      payload.error_code === "container_start_timeout" ||
      payload.error_code === "container_unavailable"
    ) {
      return payload.error_code;
    }
  } catch {
    // The container library's provisioning response is plain text.
  }
  return body.includes("There is no Container instance available at this time")
    ? "container_provisioning"
    : null;
}

function operationForRequest(request: Request): string {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") {
    return "health";
  }
  if (url.pathname.endsWith("/tariff-replay")) {
    return request.method === "POST" ? "tariff_replay_run" : "tariff_replay_state";
  }
  if (url.pathname.endsWith("/tariff-profile")) {
    return request.method === "PUT" ? "tariff_profile_save" : "tariff_profile_state";
  }
  if (url.pathname.endsWith("/design-feasibility")) {
    return request.method === "POST" ? "dispatch_run" : "dispatch_state";
  }
  if (url.pathname.includes("/annual-financial")) {
    return request.method === "POST" ? "finance_run" : "finance_state";
  }
  return "api_request";
}

export class E3ApiContainer extends Container<Env> {
  private lifecycleRequestId: string = crypto.randomUUID();
  private lifecycleStartedAt = Date.now();

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env, {
      defaultPort: API_PORT,
      sleepAfter: "2h",
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
        CI_SCENARIO_PROCESS_WORKERS: env.CI_SCENARIO_PROCESS_WORKERS,
        CI_SCENARIO_PROCESS_TIMEOUT_SECONDS:
          env.CI_SCENARIO_PROCESS_TIMEOUT_SECONDS,
      },
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const requestId = request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
    const operation = request.headers.get(OPERATION_HEADER) ?? "api_request";
    const startedAt = Date.now();
    try {
      const state = await this.getState();
      if (state.status !== "healthy") {
        this.lifecycleRequestId = requestId;
        this.lifecycleStartedAt = startedAt;
        await this.startAndWaitForPorts({
          ports: API_PORT,
          cancellationOptions: {
            abort: request.signal,
            instanceGetTimeoutMS: CONTAINER_INSTANCE_TIMEOUT_MS,
            portReadyTimeoutMS: CONTAINER_PORT_TIMEOUT_MS,
            waitInterval: CONTAINER_WAIT_INTERVAL_MS,
          },
        });
      }
      const response = await super.fetch(request);
      const failureCode = await infrastructureErrorCode(response);
      if (failureCode !== null) {
        logOperation("error", {
          request_id: requestId,
          operation,
          status: failureCode,
          elapsed: Date.now() - startedAt,
        });
        return infrastructureErrorResponse(
          failureCode,
          infrastructureMessage(failureCode),
          requestId,
        );
      }
      return response;
    } catch (error) {
      const failureCode = classifyContainerError(error);
      logOperation("error", {
        request_id: requestId,
        operation,
        status: failureCode,
        elapsed: Date.now() - startedAt,
      });
      return infrastructureErrorResponse(
        failureCode,
        infrastructureMessage(failureCode),
        requestId,
      );
    }
  }

  override onStart(): void {
    logOperation("info", {
      request_id: this.lifecycleRequestId,
      operation: "container_start",
      status: "ready",
      elapsed: Date.now() - this.lifecycleStartedAt,
    });
  }

  override onStop(params: StopParams): void {
    logOperation("info", {
      request_id: crypto.randomUUID(),
      operation: "container_stop",
      status: `${params.reason}:${params.exitCode}`,
      elapsed: 0,
    });
  }

  override onError(error: unknown): never {
    logOperation("error", {
      request_id: this.lifecycleRequestId,
      operation: "container_lifecycle",
      status: classifyContainerError(error),
      elapsed: Date.now() - this.lifecycleStartedAt,
    });
    throw error;
  }
}

// Keep this identity stable: changing it does not guarantee a new image and
// can exhaust max_instances while the old pairing is still draining.
// Cloudflare rolls the image in place; verify /api/health source hashes after
// rollout completion before considering a calculation release deployed.
const PRIMARY_CONTAINER_NAME = "primary-v10";

function primaryContainer(env: Env) {
  return env.E3_API.get(env.E3_API.idFromName(PRIMARY_CONTAINER_NAME));
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

async function verifyAccess(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return infrastructureErrorResponse(
      "access_unconfigured",
      infrastructureMessage("access_unconfigured"),
      requestId,
    );
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
  const requestId = crypto.randomUUID();
  const operation = operationForRequest(request);
  const startedAt = Date.now();
  if (!env.DATABASE_URL || !env.DURABLE_API_BEARER_TOKEN) {
    const response = infrastructureErrorResponse(
      "backend_unconfigured",
      infrastructureMessage("backend_unconfigured"),
      requestId,
    );
    logOperation("error", {
      request_id: requestId,
      operation,
      status: response.status,
      elapsed: Date.now() - startedAt,
    });
    return response;
  }

  const url = new URL(request.url);
  if (
    url.pathname !== "/api/health" &&
    env.ACCESS_AUTH_MODE !== "disabled"
  ) {
    const accessFailure = await verifyAccess(request, env, requestId);
    if (accessFailure !== null) {
      logOperation("error", {
        request_id: requestId,
        operation,
        status: accessFailure.status,
        elapsed: Date.now() - startedAt,
      });
      return accessFailure;
    }
  }

  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${env.DURABLE_API_BEARER_TOKEN}`);
  headers.set(REQUEST_ID_HEADER, requestId);
  headers.set(OPERATION_HEADER, operation);
  headers.delete("Cf-Access-Jwt-Assertion");
  const retrySource = canPrepareContainerRetry(request.method, operation)
    ? request.clone()
    : null;
  const upstreamRequest = new Request(request, { headers });
  const retryRequest = retrySource === null
    ? null
    : new Request(retrySource as unknown as RequestInfo, { headers });
  const container = primaryContainer(env);
  let didRetry = false;
  try {
    let response = await container.fetch(upstreamRequest);
    const initialFailureCode = await infrastructureErrorCode(response);
    if (
      retryRequest !== null &&
      initialFailureCode !== null &&
      canRetryContainerFailure(request.method, operation, initialFailureCode)
    ) {
      didRetry = true;
      logOperation("info", {
        request_id: requestId,
        operation,
        status: `retrying_${initialFailureCode}`,
        elapsed: Date.now() - startedAt,
      });
      await container.startAndWaitForPorts({
        ports: API_PORT,
        cancellationOptions: {
          abort: request.signal,
          instanceGetTimeoutMS: CONTAINER_INSTANCE_TIMEOUT_MS,
          portReadyTimeoutMS: CONTAINER_PORT_TIMEOUT_MS,
          waitInterval: CONTAINER_WAIT_INTERVAL_MS,
        },
      });
      response = await container.fetch(retryRequest);
    }
    const failureCode = await infrastructureErrorCode(response);
    if (failureCode !== null) {
      response = infrastructureErrorResponse(
        failureCode,
        infrastructureMessage(failureCode),
        requestId,
      );
    }
    logOperation(response.ok ? "info" : "error", {
      request_id: requestId,
      operation,
      status: response.status,
      elapsed: Date.now() - startedAt,
    });
    return response;
  } catch (error) {
    let failureCode = classifyContainerError(error);
    if (
      retryRequest !== null &&
      !didRetry &&
      canRetryContainerFailure(request.method, operation, failureCode)
    ) {
      didRetry = true;
      logOperation("info", {
        request_id: requestId,
        operation,
        status: `retrying_${failureCode}`,
        elapsed: Date.now() - startedAt,
      });
      try {
        await container.startAndWaitForPorts({
          ports: API_PORT,
          cancellationOptions: {
            abort: request.signal,
            instanceGetTimeoutMS: CONTAINER_INSTANCE_TIMEOUT_MS,
            portReadyTimeoutMS: CONTAINER_PORT_TIMEOUT_MS,
            waitInterval: CONTAINER_WAIT_INTERVAL_MS,
          },
        });
        let response = await container.fetch(retryRequest);
        const retryFailureCode = await infrastructureErrorCode(response);
        if (retryFailureCode !== null) {
          response = infrastructureErrorResponse(
            retryFailureCode,
            infrastructureMessage(retryFailureCode),
            requestId,
          );
        }
        logOperation(response.ok ? "info" : "error", {
          request_id: requestId,
          operation,
          status: response.status,
          elapsed: Date.now() - startedAt,
        });
        return response;
      } catch (retryError) {
        failureCode = classifyContainerError(retryError);
      }
    }
    const response = infrastructureErrorResponse(
      failureCode,
      infrastructureMessage(failureCode),
      requestId,
    );
    logOperation("error", {
      request_id: requestId,
      operation,
      status: response.status,
      elapsed: Date.now() - startedAt,
    });
    return response;
  }
}

async function prewarmApiContainer(env: Env): Promise<void> {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  try {
    await primaryContainer(env).startAndWaitForPorts({
      ports: API_PORT,
      cancellationOptions: {
        instanceGetTimeoutMS: CONTAINER_INSTANCE_TIMEOUT_MS,
        portReadyTimeoutMS: CONTAINER_PORT_TIMEOUT_MS,
        waitInterval: CONTAINER_WAIT_INTERVAL_MS,
      },
    });
    logOperation("info", {
      request_id: requestId,
      operation: "container_prewarm",
      status: "ready",
      elapsed: Date.now() - startedAt,
    });
  } catch {
    logOperation("error", {
      request_id: requestId,
      operation: "container_prewarm",
      status: "error",
      elapsed: Date.now() - startedAt,
    });
  }
}

function isDocumentNavigation(request: Request): boolean {
  return request.method === "GET" && (
    request.headers.get("Sec-Fetch-Dest") === "document" ||
    request.headers.get("Accept")?.includes("text/html") === true
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return proxyApi(request, env);
    }
    if (isDocumentNavigation(request)) {
      ctx.waitUntil(prewarmApiContainer(env));
    }
    return env.ASSETS.fetch(request);
  },
};
