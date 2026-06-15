export type LoadedModel = {
  modelId: string;
  pid: number;
  port: number;
  gpu: string;
  status: string;
  loadedAt: string;
  lastRequest: string;
};

export type Status = {
  status: string;
  uptimeSeconds: number;
  listen: string;
  activeBackend: string;
  loadedModels: LoadedModel[];
};

export type GpuInfo = {
  id: string;
  name: string;
  vram: number;
  vramUsed?: number;
  utilization: number;
  temperature: number;
  computeCapability: string;
  cudaArchitecture: string;
};

export type ModelInfo = {
  id: string;
  family: string;
  profile: string;
  tags: string[];
  file: string;
  mmproj?: string;
  gpu: string;
  ttl?: number;
  args: string;
  aliases: string[];
  status: string;
};

export type ModelFile = {
  name: string;
  path: string;
  relative: string;
  sizeBytes: number;
  configured: string[];
};

export type HFModelFile = {
  name: string;
  path: string;
  quant: string;
  size: number;
  url: string;
};

export type HFModelResult = {
  id: string;
  author: string;
  name: string;
  downloads: number;
  tags: string[];
  files: HFModelFile[];
};

export type DownloadJob = {
  id: string;
  repo?: string;
  filename: string;
  url: string;
  dest: string;
  status: string;
  bytes: number;
  total: number;
  error?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
};

export type TrafficCapture = {
  id: string;
  time: string;
  path: string;
  model: string;
  resolvedModel: string;
  status: number;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  requestPreview: string;
  responsePreview: string;
};

export type Diagnostic = {
  kind: string;
  id: string;
  path: string;
  ok: boolean;
  message?: string;
};

export type BackendPlan = {
  id: string;
  path: string;
  buildDir: string;
  binary: string;
  cudaArchitectures?: string[];
  configureCommand: string[];
  buildCommand: string[];
};

export type EngineInfo = {
  id: string;
  path: string;
  binary: string;
  ready: boolean;
  cloned: boolean;
  gitHash?: string;
};

export type BackendJob = {
  id: string;
  backendId: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  startedAt: string;
  endedAt?: string;
  error?: string;
  logs: string[];
  plan: BackendPlan;
};

export type OnboardingState = {
  complete: boolean;
  doneAt?: string;
};

export type LogFile = {
  name: string;
  path: string;
  lines: string[];
};

export type LogBundle = {
  directory: string;
  ignite: LogFile;
  models: LogFile[];
};

export type AboutInfo = {
  name: string;
  version: string;
  commit: string;
  repo: string;
  links: {
    authorName: string;
    author: string;
    timbre: string;
    ignite: string;
    releases: string;
  };
  update: {
    configured: boolean;
    available: boolean;
    currentVersion: string;
    latestVersion?: string;
    releaseUrl?: string;
    prerelease?: boolean;
    checkedAt?: string;
    error?: string;
  };
};

export type IgniteConfig = {
  listen: string;
  logLevel: string;
  logsPath: string;
  backends: Record<string, unknown>;
  activeBackend: string;
  modelsPath: string;
  mmprojectsPath: string;
  gpus: GpuInfo[];
  ttl: { global: number };
  healthCheck: { model: string; timeout: number };
  startPort: number;
  downloads: { directory: string; concurrent: number };
  groups: Record<string, { swap: boolean; persistent: boolean; members: string[] }>;
  models: Record<string, Omit<ModelInfo, "id" | "status">>;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || response.statusText);
  }
  return response.json() as Promise<T>;
}

export const api = {
  status: () => request<Status>("/api/status"),
  about: () => request<AboutInfo>("/api/about"),
  gpus: () => request<{ detected: GpuInfo[]; config: GpuInfo[]; error?: string }>("/api/gpus"),
  models: () => request<ModelInfo[]>("/api/models"),
  modelFiles: () => request<ModelFile[]>("/api/model-files"),
  deleteModelFile: (relative: string) => request<{ status: string }>(`/api/model-files?relative=${encodeURIComponent(relative)}`, { method: "DELETE" }),
  huggingFaceRepo: (repo: string) => request<{ repo: string; files: HFModelFile[] }>(`/api/huggingface/repo?repo=${encodeURIComponent(repo)}`),
  huggingFaceModels: (search = "", limit = 30) => request<{ items: HFModelResult[] }>(`/api/huggingface/models?limit=${limit}${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ""}`),
  downloads: () => request<DownloadJob[]>("/api/downloads"),
  startDownload: (payload: { repo: string; filename: string; url: string }) => request<DownloadJob>("/api/downloads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }),
  cancelDownload: (id: string) => request<{ status: string }>(`/api/downloads/${encodeURIComponent(id)}`, { method: "DELETE" }),
  runtimeTraffic: () => request<TrafficCapture[]>("/api/runtime/traffic"),
  config: () => request<IgniteConfig>("/api/config"),
  diagnostics: () => request<Diagnostic[]>("/api/config/diagnostics"),
  backends: () => request<{ active: string; items: Record<string, unknown>; plans: Record<string, BackendPlan>; engines: Record<string, EngineInfo> }>("/api/backends"),
  backendJobs: () => request<BackendJob[]>("/api/backend-jobs"),
  onboarding: () => request<OnboardingState>("/api/onboarding"),
  completeOnboarding: () => request<OnboardingState>("/api/onboarding/complete", { method: "POST" }),
  logs: () => request<LogBundle>("/api/logs"),
  loadModel: (id: string) => request<LoadedModel>(`/api/models/${encodeURIComponent(id)}/load`, { method: "POST" }),
  unloadModel: (id: string) => request<{ status: string }>(`/api/models/${encodeURIComponent(id)}/unload`, { method: "POST" }),
  updateConfig: (config: IgniteConfig) => request<{ status: string; config: IgniteConfig }>("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  }),
  updateModel: (id: string, model: Omit<ModelInfo, "id" | "status">) => request<ModelInfo>(`/api/models/${encodeURIComponent(id)}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(model)
  }),
  buildBackend: (id: string) => request<BackendJob>(`/api/backends/${encodeURIComponent(id)}/build`, { method: "POST" }),
  updateBackend: (id: string) => request<BackendJob>(`/api/backends/${encodeURIComponent(id)}/update`, { method: "POST" })
};
