const calculationOperations = new Set([
  "dispatch_run",
  "tariff_replay_run",
  "finance_run",
]);

export function canPrepareContainerRetry(method: string, operation: string): boolean {
  return method === "GET" || method === "HEAD" || method === "PUT"
    || (method === "POST" && calculationOperations.has(operation));
}

export function canRetryContainerFailure(
  method: string,
  operation: string,
  failureCode: string,
): boolean {
  if (!canPrepareContainerRetry(method, operation)) return false;
  // Provisioning failed before a container accepted the request. Once a
  // calculation's connection breaks, it may still be running or committed:
  // let the caller confirm its durable checkpoint, never start a second solve.
  return failureCode === "container_provisioning"
    || (failureCode === "container_unavailable" && method !== "POST");
}
