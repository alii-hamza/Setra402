import type {
  AppConfig,
  OperatorHealth,
  Service,
  TaskCall,
  TaskOutcome,
  TaskStatus,
} from "./types";

let csrfToken: string | undefined;

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(body === undefined
        ? {}
        : csrfToken
        ? { "x-setra-csrf": csrfToken }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const message =
      value && typeof value === "object" && "error" in value
        ? String(value.error)
        : "Request failed";
    throw new Error(message);
  }
  return value as T;
}

export async function getConfig(): Promise<AppConfig> {
  const config = await request<AppConfig>("/api/config");
  csrfToken = config.csrfToken;
  return config;
}

export function getServices(): Promise<{ services: Service[] }> {
  return request("/api/services");
}

export function getHealth(): Promise<OperatorHealth> {
  return request("/api/health");
}

export async function getProviderProfiles(): Promise<
  AppConfig["providerProfiles"]
> {
  return (await getConfig()).providerProfiles;
}

export function registerService(
  service: Omit<Service, "policy_hash" | "provider_type">
): Promise<{ status: string; service: Service }> {
  return request("/api/services", service);
}

export function getTaskQuote(call: TaskCall): Promise<TaskOutcome> {
  return request("/api/tasks/quote", call);
}

export function fundTask(call: TaskCall): Promise<TaskOutcome> {
  return request("/api/tasks/fund", call);
}

export function executeTask(call: TaskCall): Promise<TaskOutcome> {
  return request("/api/tasks/run", call);
}

export function getTaskStatus(call: TaskCall): Promise<TaskStatus> {
  return request("/api/tasks/status", call);
}

export function requestRefund(
  call: TaskCall
): Promise<TaskOutcome & { outcome?: TaskOutcome }> {
  return request("/api/tasks/refund", call);
}
