import { useCallback, useEffect, useMemo, useState } from "react";
import { api, AboutInfo, BackendJob, BackendPlan, Diagnostic, DownloadJob, EngineInfo, GpuInfo, IgniteConfig, LogBundle, ModelFile, ModelInfo, OnboardingState, Status, TrafficCapture } from "./api";

export type IgniteData = {
  status?: Status;
  about?: AboutInfo;
  gpus: GpuInfo[];
  models: ModelInfo[];
  modelFiles: ModelFile[];
  downloads: DownloadJob[];
  config?: IgniteConfig;
  diagnostics: Diagnostic[];
  backendPlans: Record<string, BackendPlan>;
  engines: Record<string, EngineInfo>;
  backendJobs: BackendJob[];
  onboarding?: OnboardingState;
  traffic: TrafficCapture[];
  logBundle?: LogBundle;
  logs: { time: string; level: string; message: string }[];
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
};

export function useIgniteData(): IgniteData {
  const [status, setStatus] = useState<Status>();
  const [about, setAbout] = useState<AboutInfo>();
  const [gpus, setGpus] = useState<GpuInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelFiles, setModelFiles] = useState<ModelFile[]>([]);
  const [downloads, setDownloads] = useState<DownloadJob[]>([]);
  const [config, setConfig] = useState<IgniteConfig>();
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [backendPlans, setBackendPlans] = useState<Record<string, BackendPlan>>({});
  const [engines, setEngines] = useState<Record<string, EngineInfo>>({});
  const [backendJobs, setBackendJobs] = useState<BackendJob[]>([]);
  const [onboarding, setOnboarding] = useState<OnboardingState>();
  const [traffic, setTraffic] = useState<TrafficCapture[]>([]);
  const [logBundle, setLogBundle] = useState<LogBundle>();
  const [logs, setLogs] = useState<{ time: string; level: string; message: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setError(undefined);
      const [nextStatus, nextAbout, nextGpus, nextModels, nextModelFiles, nextDownloads, nextTraffic, nextConfig, nextDiagnostics, nextBackends, nextJobs, nextLogs, nextOnboarding] = await Promise.all([
        api.status(),
        api.about(),
        api.gpus(),
        api.models(),
        api.modelFiles(),
        api.downloads(),
        api.runtimeTraffic(),
        api.config(),
        api.diagnostics(),
        api.backends(),
        api.backendJobs(),
        api.logs(),
        api.onboarding()
      ]);
      setStatus(nextStatus);
      setAbout(nextAbout);
      setGpus(sortGpus(nextGpus.detected || []));
      setModels(sortModels(nextModels));
      setModelFiles(sortModelFiles(nextModelFiles));
      setDownloads(sortDownloads(nextDownloads));
      setTraffic(nextTraffic);
      setConfig(nextConfig);
      setDiagnostics(sortDiagnostics(nextDiagnostics));
      setBackendPlans(nextBackends.plans || {});
      setEngines(nextBackends.engines || {});
      setBackendJobs(sortBackendJobs(nextJobs));
      setLogBundle(nextLogs);
      setLogs(parseIgniteLogEntries(nextLogs.ignite.lines).slice(-160).reverse());
      setOnboarding(nextOnboarding);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reach Ignite");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  return useMemo(
    () => ({ status, about, gpus, models, modelFiles, downloads, config, diagnostics, backendPlans, engines, backendJobs, onboarding, traffic, logBundle, logs, loading, error, refresh }),
    [status, about, gpus, models, modelFiles, downloads, config, diagnostics, backendPlans, engines, backendJobs, onboarding, traffic, logBundle, logs, loading, error, refresh]
  );
}

function parseIgniteLogEntries(lines: string[]) {
  return lines.map((line) => {
    const match = line.match(/^(\S+)\s+\[(\w+)\]\s+(.*)$/);
    if (!match) return { time: new Date().toISOString(), level: "info", message: line };
    return { time: match[1], level: match[2], message: match[3] };
  });
}

function sortGpus(gpus: GpuInfo[]) {
  return [...gpus].sort((a, b) => {
    const name = b.name.localeCompare(a.name);
    return name || a.id.localeCompare(b.id);
  });
}

function sortModels(models: ModelInfo[]) {
  return [...models].sort((a, b) =>
    a.family.localeCompare(b.family) ||
    a.profile.localeCompare(b.profile) ||
    a.id.localeCompare(b.id)
  );
}

function sortModelFiles(files: ModelFile[]) {
  return [...files].sort((a, b) => a.relative.localeCompare(b.relative));
}

function sortDownloads(downloads: DownloadJob[]) {
  return [...downloads].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

function sortDiagnostics(diagnostics: Diagnostic[]) {
  return [...diagnostics].sort((a, b) =>
    a.kind.localeCompare(b.kind) ||
    a.id.localeCompare(b.id) ||
    a.path.localeCompare(b.path)
  );
}

function sortBackendJobs(jobs: BackendJob[]) {
  return [...jobs].sort((a, b) =>
    (b.startedAt || "").localeCompare(a.startedAt || "") ||
    a.id.localeCompare(b.id)
  );
}
