import {
  Activity,
  Boxes,
  ChevronRight,
  CircleHelp,
  Cpu,
  Database,
  ExternalLink,
  FileCode,
  Gauge,
  Github,
  HardDriveDownload,
  Home,
  Layers3,
  Loader2,
  Play,
  Power,
  RefreshCw,
  ScrollText,
  ServerCog,
  Settings,
  Square,
  Star,
  Terminal,
  Wrench,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import logo from "./assets/ignite-logo.jpeg";
import { api, BackendFlag, BackendFlagCatalog, HFModelFile, HFModelResult, IgniteConfig, ModelFile, ModelInfo, TrafficCapture } from "./lib/api";
import { IgniteData, useIgniteData } from "./lib/useIgniteData";

type View = "dashboard" | "models" | "config" | "runtime" | "logs" | "engines" | "playground" | "settings";

const navItems: { id: View; label: string; icon: React.ElementType }[] = [
  { id: "dashboard", label: "Dashboard", icon: Home },
  { id: "models", label: "Models", icon: HardDriveDownload },
  { id: "config", label: "Config", icon: Boxes },
  { id: "runtime", label: "Runtime", icon: Activity },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "engines", label: "Engines", icon: ServerCog },
  { id: "playground", label: "Playground", icon: Terminal }
];

export function App() {
  const data = useIgniteData();
  const [view, setView] = useState<View>("dashboard");

  if (!data.loading && !data.onboarding?.complete) {
    return <Setup data={data} onFinish={async () => {
      await api.completeOnboarding();
      await data.refresh();
    }} />;
  }

  return (
    <div className="app-shell">
      <Sidebar view={view} onView={setView} data={data} />
      <main className="main-surface">
        {data.error ? <Banner message={data.error} /> : null}
        {view === "dashboard" && <Dashboard data={data} />}
        {view === "models" && <ModelLibrary data={data} />}
        {view === "config" && <Models data={data} />}
        {view === "engines" && <Engines data={data} />}
        {view === "playground" && <Playground data={data} />}
        {view === "runtime" && <Runtime data={data} />}
        {view === "logs" && <LogsView data={data} />}
        {view === "settings" && <SettingsView data={data} />}
      </main>
    </div>
  );
}

function Sidebar({ view, onView, data }: { view: View; onView: (view: View) => void; data: IgniteData }) {
  const activeBackend = data.status?.activeBackend || "mainline";
  const updateAvailable = Boolean(data.about?.update.available);
  return (
    <aside className="sidebar">
      <div className="brand">
        <img src={logo} alt="" />
        <span>Ignite</span>
      </div>
      <nav className="nav-list">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} className={view === item.id ? "nav-item active" : "nav-item"} onClick={() => onView(item.id)} title={item.label}>
              <Icon size={18} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <div><span className="dot hot" /><span>{activeBackend}</span></div>
        <button className={view === "settings" ? "settings-icon active" : "settings-icon"} onClick={() => onView("settings")} title={updateAvailable ? `Ignite ${data.about?.update.latestVersion} available` : "Settings"}>
          <Settings size={17} />
          {updateAvailable ? <span className="update-dot" /> : null}
        </button>
      </div>
    </aside>
  );
}

function Setup({ data, onFinish }: { data: IgniteData; onFinish: () => void | Promise<void> }) {
  const [step, setStep] = useState(0);
  const [popularModels, setPopularModels] = useState<HFModelResult[]>([]);
  const [repo, setRepo] = useState("");
  const [repoFiles, setRepoFiles] = useState<HFModelFile[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [setupError, setSetupError] = useState("");
  const steps = ["Hardware", "Engine", "Models"];
  const activeBackend = data.status?.activeBackend || data.config?.activeBackend || "mainline";
  const activePlan = data.backendPlans[activeBackend] || sortedValues(data.backendPlans)[0];
  const engine = activePlan ? data.engines[activePlan.id] : undefined;
  const engineJob = latestBackendJob(data.backendJobs, activePlan?.id);
  const engineBusy = engineJob?.status === "queued" || engineJob?.status === "running";
  const hasModels = data.modelFiles.length > 0;
  const gpuKey = data.gpus.map((gpu) => `${gpu.id}:${gpu.vram}`).join("|");

  useEffect(() => {
    if (step !== 2 || hasModels) return;
    let cancelled = false;
    setDiscoverLoading(true);
    setSetupError("");
    api.huggingFaceModels("", 10)
      .then((result) => {
        if (!cancelled) setPopularModels(filterFittingModels(result.items, data.gpus).slice(0, 10));
      })
      .catch((err) => {
        if (!cancelled) setSetupError(err instanceof Error ? err.message : "Unable to load model suggestions.");
      })
      .finally(() => {
        if (!cancelled) setDiscoverLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, hasModels, gpuKey]);

  const buildEngine = async () => {
    if (!activePlan) return;
    setSetupError("");
    try {
      await api.buildBackend(activePlan.id);
      await data.refresh();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Unable to start engine build.");
    }
  };

  const selectSetupModel = (model: HFModelResult) => {
    setRepo(model.id);
    setRepoFiles(model.files);
  };

  const startSetupDownload = async (file: HFModelFile) => {
    setSetupError("");
    try {
      await api.startDownload({ repo, filename: file.name, url: file.url });
      await data.refresh();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Unable to start download.");
    }
  };

  const continueSetup = () => {
    if (step === 0) {
      setStep(1);
      return;
    }
    if (step === 1) {
      if (hasModels) {
        void onFinish();
      } else {
        setStep(2);
      }
      return;
    }
    void onFinish();
  };

  const skipEngineSetup = () => {
    if (hasModels) {
      void onFinish();
      return;
    }
    setStep(2);
  };

  return (
    <div className="setup-screen">
      <section className="setup-panel">
        <header className="setup-head">
          <div className="brand compact">
            <img src={logo} alt="" />
            <span>Ignite</span>
          </div>
          <span className="mono muted">setup</span>
        </header>
        <div className="setup-steps">
          {steps.map((label, index) => (
            <div className={index === step ? "setup-step active" : "setup-step"} key={label}>
              <span>{index + 1}</span>
              <b>{label}</b>
            </div>
          ))}
        </div>
        {step === 0 && (
          <div className="setup-body">
            <h1>Your hardware</h1>
            <p>Ignite detected {data.gpus.length || 0} GPUs ready for inference.</p>
            <div className="setup-grid">
              {data.gpus.map((gpu, index) => (
                <div className="gpu-tile" key={gpu.id}>
                  <div className="tile-top"><span>GPU {index}</span><span><span className="dot" /> ready</span></div>
                  <strong>{shortGpuName(gpu.name)}</strong>
                  <div className="big-number">{Math.round(gpu.vram / 1024)} <small>GB</small></div>
                  <span className="muted">{index === 0 ? "primary" : "secondary"}</span>
                </div>
              ))}
            </div>
            <div className="inline-meta">total vram {sumVram(data.gpus)} GB</div>
          </div>
        )}
        {step === 1 && (
          <div className="setup-body">
            <h1>Engine</h1>
            <p>Ignite needs one llama.cpp engine before it can load models.</p>
            <div className="setup-card">
              <div className="row spread"><span>engine</span><b>{activePlan?.id || "mainline"}</b></div>
              <div className="row spread"><span>state</span><b>{engine?.ready ? "ready" : engineBusy ? "building" : engine?.cloned ? "needs build" : "not installed"}</b></div>
              {engine?.path ? <div className="row spread"><span>path</span><b>{engine.path}</b></div> : null}
              {engine?.gitHash ? <div className="row spread"><span>git</span><b>{engine.gitHash}</b></div> : null}
              {!engine?.ready ? <button className="secondary-btn" disabled={!activePlan || engineBusy} onClick={() => void buildEngine()}>{engineBusy ? "Building" : engine?.cloned ? "Build engine" : "Clone and build"}</button> : null}
              {engineJob ? (
                <div className="setup-log">
                  <div className="row spread"><span>{engineJob.kind}</span><b>{engineJob.status}</b></div>
                  <small>{engineJob.error || engineJob.logs[engineJob.logs.length - 1] || "Waiting for output."}</small>
                </div>
              ) : null}
            </div>
            {setupError ? <div className="inline-error">{setupError}</div> : null}
          </div>
        )}
        {step === 2 && (
          <div className="setup-body">
            <h1>Models</h1>
            <p>{hasModels ? `${data.modelFiles.length} GGUF files found.` : "Choose a model that fits your GPUs, or skip and add models later."}</p>
            {!hasModels ? (
              <div className="setup-model-picker">
                {discoverLoading ? <div className="empty-state compact"><Loader2 size={18} className="spin" /><span>Loading model suggestions.</span></div> : null}
                {popularModels.length > 0 ? <ModelDiscoveryGrid models={popularModels} gpus={data.gpus} onSelect={selectSetupModel} /> : null}
                {repoFiles.length > 0 ? (
                  <div className="quant-list">
                    {repoFiles.map((file) => (
                      <button key={file.path} className="quant-option" onClick={() => void startSetupDownload(file)}>
                        <b>{file.quant || "GGUF"}</b>
                        <span>{file.name}</span>
                        <small>{formatBytes(file.size)}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
                {data.downloads.length > 0 ? (
                  <div className="download-list">
                    {data.downloads.slice(0, 4).map((job) => {
                      const pct = job.total > 0 ? Math.round((job.bytes / job.total) * 100) : 0;
                      return (
                        <div className="download-row" key={job.id}>
                          <div><b>{job.filename}</b><small>{job.status}{job.error ? ` · ${job.error}` : ""}</small></div>
                          <span>{job.total > 0 ? `${pct}%` : formatBytes(job.bytes)}</span>
                          <div className="bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
                          {job.status === "downloading" || job.status === "queued"
                            ? <button className="icon-btn danger-btn" onClick={() => void api.cancelDownload(job.id).then(data.refresh)} title="Stop download"><Square size={12} /></button>
                            : <span />}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
            {setupError ? <div className="inline-error">{setupError}</div> : null}
          </div>
        )}
        <footer className="setup-actions">
          <span>{step + 1} / {steps.length}</span>
          {step === 1 && !engine?.ready ? <button className="secondary-btn" disabled={engineBusy} onClick={skipEngineSetup}>Skip for now</button> : null}
          {step === 2 && !hasModels ? <button className="secondary-btn" onClick={() => void onFinish()}>Skip</button> : null}
          <button className="primary-btn" disabled={(step === 1 && !engine?.ready) || (step === 2 && !hasModels)} onClick={continueSetup}>Continue</button>
        </footer>
      </section>
    </div>
  );
}

function Dashboard({ data }: { data: IgniteData }) {
  const running = data.status?.loadedModels || [];
  const throughput = estimateThroughput(data.traffic);
  return (
    <section className="view">
      <PageHeader title="Dashboard" detail={`${running.length} models running`} />
      <div className="stat-grid">
        <Metric label="Models loaded" value={String(running.length)} />
        <Metric label="VRAM in use" value={`${formatGb(totalVramUsed(data.gpus))} `} suffix={`/ ${formatGb(totalVram(data.gpus))} GB`} />
        <Metric label="Throughput" value={throughput || "-"} suffix="tok/s" spark={Boolean(throughput)} />
        <Metric label="Uptime" value={formatUptime(data.status?.uptimeSeconds || 0)} />
      </div>
      <SectionTitle title="GPUs" />
      <div className="gpu-grid">
        {data.gpus.map((gpu, index) => {
          const active = running.filter((model) => model.gpu === gpu.id);
          return <GpuCard key={gpu.id} gpu={gpu} index={index} activeModels={active.map((model) => model.modelId)} />;
        })}
      </div>
      <div className="bottom-grid">
        <ActivityPanel traffic={data.traffic} logs={data.logs} />
        <ConnectPanel endpoint={data.config?.listen || "127.0.0.1:8091"} />
      </div>
    </section>
  );
}

function Models({ data }: { data: IgniteData }) {
  const [selectedId, setSelectedId] = useState<string | undefined>(data.models[0]?.id);
  const [editingId, setEditingId] = useState<string>();
  const [draftModel, setDraftModel] = useState<ModelInfo>();
  const [createError, setCreateError] = useState("");
  useEffect(() => {
    if ((!selectedId || !data.models.some((model) => model.id === selectedId)) && data.models[0]) {
      setSelectedId(data.models[0].id);
    }
  }, [data.models, selectedId]);
  const grouped = groupBy(data.models, (model) => model.family || "Other");
  const editing = data.models.find((model) => model.id === editingId);
  const addConfig = () => {
    setCreateError("");
    setDraftModel(createDraftModel(data));
  };
  const deleteConfig = async (model: ModelInfo) => {
    if (!window.confirm(`Delete config "${model.id}"? The GGUF file stays on disk.`)) return;
    setCreateError("");
    try {
      await api.deleteModel(model.id);
      await data.refresh();
      if (selectedId === model.id) setSelectedId(undefined);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to delete model config.");
    }
  };
  return (
    <section className="view">
      <header className="page-head with-action">
        <div>
          <h1>Config</h1>
          <span>{data.models.length} model profiles</span>
        </div>
        <button className="primary-btn" onClick={() => void addConfig()}>Add config</button>
      </header>
      {createError ? <div className="inline-error">{createError}</div> : null}
      <RuntimeGroupsManager data={data} />
      <div className="model-groups">
        {sortedEntries(grouped).map(([family, models]) => (
          <div className="family-block" key={family}>
            <SectionTitle title={family} />
            <div className="model-grid">
              {models.map((model) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  data={data}
                  selected={model.id === selectedId}
                  onSelect={() => setSelectedId(model.id)}
                  onEdit={() => {
                    setSelectedId(model.id);
                    setEditingId(model.id);
                  }}
                  onDelete={() => void deleteConfig(model)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <ModelConfigModal model={editing} data={data} onClose={() => setEditingId(undefined)} />
      <ModelConfigModal
        model={draftModel}
        data={data}
        creating
        onClose={() => setDraftModel(undefined)}
        onCreated={(id) => {
          setSelectedId(id);
          setEditingId(id);
        }}
      />
    </section>
  );
}

function ModelLibrary({ data }: { data: IgniteData }) {
  const configuredFiles = data.modelFiles.filter((file) => file.configured.length > 0).length;
  const looseFiles = data.modelFiles.length - configuredFiles;
  const [repo, setRepo] = useState("");
  const [repoFiles, setRepoFiles] = useState<HFModelFile[]>([]);
  const [popularModels, setPopularModels] = useState<HFModelResult[]>([]);
  const [searchResults, setSearchResults] = useState<HFModelResult[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [addError, setAddError] = useState("");
  const [draftModel, setDraftModel] = useState<ModelInfo>();
  const gpuKey = data.gpus.map((gpu) => `${gpu.id}:${gpu.vram}`).join("|");

  useEffect(() => {
    let cancelled = false;
    setDiscoverLoading(true);
    api.huggingFaceModels("", 30)
      .then((result) => {
        if (!cancelled) setPopularModels(filterFittingModels(result.items, data.gpus));
      })
      .catch((err) => {
        if (!cancelled) setRepoError(err instanceof Error ? err.message : "Unable to load popular Hugging Face models.");
      })
      .finally(() => {
        if (!cancelled) setDiscoverLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gpuKey]);

  const lookupRepo = async () => {
    const value = repo.trim();
    if (!value) return;
    setRepoError("");
    if (!value.includes("/")) {
      setSearchLoading(true);
      try {
        const result = await api.huggingFaceModels(value, 20);
        setSearchResults(result.items);
        setRepoFiles([]);
      } catch (err) {
        setRepoError(err instanceof Error ? err.message : "Unable to search Hugging Face.");
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
      return;
    }
    setRepoLoading(true);
    try {
      const result = await api.huggingFaceRepo(value);
      setRepoFiles(result.files);
      setSearchResults([]);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : "Unable to fetch Hugging Face repo.");
      setRepoFiles([]);
    } finally {
      setRepoLoading(false);
    }
  };
  const selectDiscoveredModel = (model: HFModelResult) => {
    setRepo(model.id);
    setRepoFiles(model.files);
    setSearchResults([]);
    setRepoError("");
  };
  const startDownload = async (file: HFModelFile) => {
    setRepoError("");
    try {
      await api.startDownload({ repo, filename: file.name, url: file.url });
      await data.refresh();
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : "Unable to start download.");
    }
  };
  const deleteFile = async (file: { relative: string; configured: string[] }) => {
    const detail = file.configured.length ? ` It is used by: ${file.configured.join(", ")}.` : "";
    if (!window.confirm(`Delete ${file.relative} from disk?${detail}`)) return;
    setDeleteError("");
    try {
      await api.deleteModelFile(file.relative);
      await data.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unable to delete model file.");
    }
  };
  const addFileConfig = (file: ModelFile) => {
    setAddError("");
    setDraftModel(createDraftModel(data, file));
  };
  return (
    <section className="view">
      <PageHeader title="Models" detail={data.config?.modelsPath || ""} />
      <div className="panel discover-panel">
        <div className="panel-head">
          <div>
            <b>Popular models for your hardware</b>
            <small>{discoverLoading ? "Checking Hugging Face" : `${popularModels.length} fitting GGUF repos from Hugging Face`}</small>
          </div>
        </div>
        {popularModels.length > 0 ? (
          <ModelDiscoveryGrid models={popularModels.slice(0, 10)} gpus={data.gpus} onSelect={selectDiscoveredModel} />
        ) : (
          <div className="empty-state compact">{discoverLoading ? <Loader2 size={18} className="spin" /> : <Database size={18} />}<span>{discoverLoading ? "Loading popular GGUF repos." : "No fitting popular GGUF repos found."}</span></div>
        )}
      </div>
      <div className="panel download-manager">
        <div className="download-head">
          <div>
            <b>Search or download from Hugging Face</b>
            <span>{data.config?.downloads.directory || data.config?.modelsPath || "No downloads folder configured"}</span>
          </div>
          <div className="download-lookup">
            <input value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="search models or owner/model-GGUF" />
            <button className="primary-btn" disabled={repoLoading || searchLoading || !repo.trim()} onClick={() => void lookupRepo()}>{repoLoading || searchLoading ? "Searching" : "Search"}</button>
          </div>
        </div>
        {repoError ? <div className="inline-error">{repoError}</div> : null}
        {searchResults.length > 0 ? (
          <ModelDiscoveryGrid models={searchResults.slice(0, 10)} gpus={data.gpus} onSelect={selectDiscoveredModel} />
        ) : null}
        {repoFiles.length > 0 ? (
          <div className="quant-list">
            {repoFiles.map((file) => (
              <button key={file.path} className="quant-option" onClick={() => void startDownload(file)}>
                <b>{file.quant || "GGUF"}</b>
                <span>{file.name}</span>
                <small>{formatBytes(file.size)}</small>
              </button>
            ))}
          </div>
        ) : null}
        {data.downloads.length > 0 ? (
          <div className="download-list">
            {data.downloads.slice(0, 8).map((job) => {
              const pct = job.total > 0 ? Math.round((job.bytes / job.total) * 100) : 0;
              return (
                <div className="download-row" key={job.id}>
                  <div><b>{job.filename}</b><small>{job.status}{job.error ? ` · ${job.error}` : ""}</small></div>
                  <span>{job.total > 0 ? `${pct}%` : formatBytes(job.bytes)}</span>
                  <div className="bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
                  {job.status === "downloading" || job.status === "queued"
                    ? <button className="icon-btn danger-btn" onClick={() => void api.cancelDownload(job.id).then(data.refresh)} title="Stop download"><Square size={12} /></button>
                    : job.status === "completed" || job.status === "cancelled" || job.status === "failed"
                      ? <button className="icon-btn" onClick={() => void api.cancelDownload(job.id).then(data.refresh)} title="Clear download"><X size={14} /></button>
                      : <span />}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="path-grid">
        <Metric label="GGUF files" value={String(data.modelFiles.length)} compact />
        <Metric label="Configured files" value={String(configuredFiles)} compact />
        <Metric label="Ready to add" value={String(looseFiles)} compact />
      </div>
      {deleteError ? <div className="inline-error">{deleteError}</div> : null}
      {addError ? <div className="inline-error">{addError}</div> : null}
      <div className="model-file-list">
        <div className="model-file-row header"><span className="file-cell">file</span><span className="size-cell">size</span><span className="config-cell">config</span><span className="actions-cell">actions</span></div>
        {data.modelFiles.length === 0 ? (
          <div className="empty-state">
            <Database size={22} />
            <span>No GGUF files found in the configured models folder.</span>
          </div>
        ) : data.modelFiles.map((file) => (
          <div className="model-file-row" key={file.path}>
            <div className="file-cell">
              <b>{file.name}</b>
              <small>{file.relative}</small>
            </div>
            <span className="size-cell">{formatBytes(file.sizeBytes)}</span>
            <div className="tag-row config-cell">
              {file.configured.length > 0
                ? file.configured.map((id) => <span key={id}>{id}</span>)
                : <span>not configured</span>}
            </div>
            <div className="row-actions actions-cell">
              <button className="secondary-btn" onClick={() => addFileConfig(file)}>Add</button>
              <button className="secondary-btn danger-btn" onClick={() => void deleteFile(file)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      <ModelConfigModal
        model={draftModel}
        data={data}
        creating
        onClose={() => setDraftModel(undefined)}
        onCreated={() => void data.refresh()}
      />
    </section>
  );
}

function ModelDiscoveryGrid({ models, gpus, onSelect }: { models: HFModelResult[]; gpus: { id: string; name: string; vram: number }[]; onSelect: (model: HFModelResult) => void }) {
  return (
    <div className="discovery-grid">
      {models.map((model) => {
        const reference = referenceGGUF(model.files);
        return (
          <button className="discovery-card" key={model.id} onClick={() => onSelect(model)}>
            <div className="discovery-title">
              <b>{model.name}</b>
              <small>{model.author || "Hugging Face"}</small>
            </div>
            <div className="discovery-meta">
              <span>{formatDownloads(model.downloads)} downloads</span>
              <small>{reference ? `${reference.quant || "GGUF"} · ${formatBytes(reference.size)}` : "No GGUF sizes"}</small>
            </div>
            <div className="fit-row">
              {gpus.length > 0 ? gpus.map((gpu) => {
                const fit = reference ? fitForGpu(reference.size, gpu.vram) : "unknown";
                return <span className={`fit ${fit}`} key={gpu.id}>{compactGpuName(gpu.name || gpu.id)}: {fitLabel(fit)}</span>;
              }) : <span className="fit unknown">No GPU data</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function RuntimeGroupsManager({ data }: { data: IgniteData }) {
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const groups = data.config?.groups || {};
  const groupEntries = sortedEntries(groups);
  const memberCount = groupEntries.reduce((sum, [, group]) => sum + group.members.length, 0);

  const saveGroups = async (nextGroups: IgniteConfig["groups"]) => {
    if (!data.config) return;
    setSaving(true);
    setError("");
    try {
      await api.updateGroups(nextGroups);
      await data.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save runtime groups.");
    } finally {
      setSaving(false);
    }
  };

  const addGroup = async () => {
    const name = newGroupName.trim();
    if (!name || groups[name]) return;
    await saveGroups({ ...groups, [name]: { swap: true, persistent: false, members: [] } });
    setNewGroupName("");
  };

  const renameGroup = async (oldName: string, nextName: string) => {
    const name = nextName.trim();
    if (!name || name === oldName || groups[name]) return;
    const next: IgniteConfig["groups"] = {};
    for (const [groupName, group] of sortedEntries(groups)) {
      next[groupName === oldName ? name : groupName] = group;
    }
    await saveGroups(next);
  };

  const updateGroup = async (name: string, patch: Partial<IgniteConfig["groups"][string]>) => {
    await saveGroups({ ...groups, [name]: { ...groups[name], ...patch } });
  };

  const deleteGroup = async (name: string) => {
    const next = { ...groups };
    delete next[name];
    await saveGroups(next);
  };

  const assignMember = async (groupName: string, modelId: string) => {
    if (!modelId) return;
    await saveGroups(assignModelGroup(groups, modelId, groupName));
  };

  const removeMember = async (groupName: string, modelId: string) => {
    const group = groups[groupName];
    if (!group) return;
    await updateGroup(groupName, { members: group.members.filter((member) => member !== modelId) });
  };

  return (
    <div className="panel runtime-groups-panel">
      <div className="panel-head">
        <div>
          <b>Runtime groups</b>
          <small>{groupEntries.length} groups · {memberCount} assignments · controls model swap policy</small>
        </div>
        <div className="panel-actions">
          <button className="icon-btn help-icon" onClick={() => setHelpOpen(true)} title="Runtime groups help"><CircleHelp size={16} /></button>
          <button className="secondary-btn" onClick={() => setOpen((current) => !current)}>{open ? "Hide" : "Manage"}</button>
        </div>
      </div>
      {helpOpen ? <RuntimeGroupsHelpModal onClose={() => setHelpOpen(false)} /> : null}
      {error ? <div className="inline-error">{error}</div> : null}

      {open ? (
        <>
        <div className="inline-form runtime-group-create">
          <input value={newGroupName} disabled={saving} placeholder="New group" onChange={(event) => setNewGroupName(event.target.value)} />
          <button className="secondary-btn" disabled={saving || !newGroupName.trim()} onClick={() => void addGroup()}>Create</button>
        </div>

      {groupEntries.length === 0 ? (
        <div className="empty compact">No runtime groups. Models use default swapping until you create a group.</div>
      ) : (
        <div className="runtime-group-grid">
          {groupEntries.map(([name, group]) => (
            <div className="runtime-group-card" key={name}>
              <div className="runtime-group-head">
                <input defaultValue={name} disabled={saving} onBlur={(event) => void renameGroup(name, event.target.value)} />
                <button className="icon-btn" disabled={saving} onClick={() => void deleteGroup(name)} title="Remove group"><X size={15} /></button>
              </div>
              <div className="toggle-row">
                <label><input type="checkbox" checked={group.swap} disabled={saving} onChange={(event) => void updateGroup(name, { swap: event.target.checked })} /> Swap</label>
                <label><input type="checkbox" checked={group.persistent} disabled={saving} onChange={(event) => void updateGroup(name, { persistent: event.target.checked })} /> Persistent</label>
              </div>
              <label className="field">
                <span>Add model</span>
                <select value="" disabled={saving} onChange={(event) => void assignMember(name, event.target.value)}>
                  <option value="">Select model</option>
                  {data.models.filter((model) => !group.members.includes(model.id)).map((model) => (
                    <option key={model.id} value={model.id}>{model.id}</option>
                  ))}
                </select>
              </label>
              <div className="member-list">
                {group.members.length === 0 ? <small>No members</small> : group.members.map((member) => (
                  <span key={member}>{member}<button disabled={saving} onClick={() => void removeMember(name, member)} title="Remove member"><X size={12} /></button></span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
        </>
      ) : (
        <div className="runtime-group-summary">
          {groupEntries.length === 0 ? "No runtime groups configured." : groupEntries.map(([name]) => name).join(", ")}
        </div>
      )}
    </div>
  );
}

function RuntimeGroupsHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal-panel help-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Runtime groups help">
        <header className="modal-head">
          <div>
            <span className="modal-kicker">Runtime groups</span>
            <h2>Swap and persistent</h2>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close"><X size={18} /></button>
        </header>
        <div className="modal-body help-body">
          <div>
            <b>Swap</b>
            <p>If enabled, this group behaves like one-at-a-time swapping. Starting one model in the group unloads another running model in the same group on the same GPU.</p>
          </div>
          <div>
            <b>Persistent</b>
            <p>If enabled, this group is marked as something you want to keep loaded if hardware allows it. It does not force-load models by itself.</p>
          </div>
          <div>
            <b>Keep two models loaded</b>
            <p>Put each model in its own group, set swap off, and keep persistent on. Models on different GPUs can stay loaded together.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function Engines({ data }: { data: IgniteData }) {
  return (
    <section className="view">
      <PageHeader title="Engines" detail={data.status?.activeBackend || "mainline"} />
      <div className="engine-grid">
        {sortedValues(data.backendPlans).map((plan) => (
          <div className="panel" key={plan.id}>
            <div className="panel-head"><b>{plan.id}</b><span>{plan.cudaArchitectures?.join(";") || "auto"}</span></div>
            <div className="kv"><span>path</span><code>{plan.path}</code></div>
            <div className="kv"><span>binary</span><code>{plan.binary}</code></div>
            <pre>{plan.configureCommand.join(" \\\n  ")}</pre>
            <div className="row-actions">
              <ActionButton icon={Wrench} label="Build" onClick={() => void api.buildBackend(plan.id).then(data.refresh)} />
              <ActionButton icon={RefreshCw} label="Update" onClick={() => void api.updateBackend(plan.id).then(data.refresh)} />
            </div>
          </div>
        ))}
      </div>
      <SectionTitle title="Jobs" />
      <div className="table-card">
        {data.backendJobs.length === 0 ? <div className="empty">No backend jobs</div> : data.backendJobs.map((job) => (
          <div className="table-row" key={job.id}>
            <b>{job.kind}</b><span>{job.backendId}</span><span className="mono">{job.status}</span><small>{job.error || job.logs[job.logs.length - 1]}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function Runtime({ data }: { data: IgniteData }) {
  const [traffic, setTraffic] = useState<TrafficCapture[]>([]);
  const [expanded, setExpanded] = useState<string>();
  const [reasoningExpanded, setReasoningExpanded] = useState<string>();
  const [expertExpanded, setExpertExpanded] = useState<string>();
  const [error, setError] = useState("");

  const refreshTraffic = useCallback(async () => {
    try {
      const res = await fetch("/api/runtime/traffic");
      if (!res.ok) throw new Error(await res.text());
      setTraffic(await res.json());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load runtime traffic.");
    }
  }, []);

  useEffect(() => {
    void refreshTraffic();
    const id = window.setInterval(refreshTraffic, 2000);
    return () => window.clearInterval(id);
  }, [refreshTraffic]);

  const running = data.status?.loadedModels || [];
  return (
    <section className="view">
      <PageHeader title="Runtime" detail={`${traffic.length} captured requests`} />
      <div className="stat-grid runtime-stats">
        <Metric label="Running" value={String(running.length)} />
        <Metric label="Requests" value={String(traffic.length)} />
        <Metric label="Latency" value={traffic[0] ? String(traffic[0].durationMs) : "-"} suffix="ms" />
        <Metric label="Tokens" value={traffic[0]?.totalTokens ? String(traffic[0].totalTokens) : "-"} />
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="runtime-table">
        <div className="runtime-row header"><span>time</span><span>model</span><span>endpoint</span><span>status</span><span>timing</span><span>tokens</span></div>
        {traffic.length === 0 ? <div className="empty">No runtime traffic yet. Send a request from Playground or any OpenAI-compatible client.</div> : traffic.map((item) => (
          <div key={item.id} className="runtime-item">
            <button className="runtime-row" onClick={() => setExpanded((current) => current === item.id ? undefined : item.id)}>
              <span data-label="time">{new Date(item.time).toLocaleTimeString()}</span>
              <span data-label="model"><b>{item.model}</b><small>{item.resolvedModel !== item.model ? item.resolvedModel : ""}</small></span>
              <span data-label="endpoint">{item.path}</span>
              <span data-label="status" className={item.status >= 400 ? "status error" : "status running"}>{item.status}</span>
              <span data-label="timing">{item.durationMs} ms</span>
              <span data-label="tokens">{item.totalTokens || "-"} <small>{item.promptTokens || 0}/{item.completionTokens || 0}</small></span>
            </button>
            {expanded === item.id ? <RuntimeDetail
              item={item}
              reasoningOpen={reasoningExpanded === item.id}
              expertOpen={expertExpanded === item.id}
              onToggleReasoning={() => setReasoningExpanded((current) => current === item.id ? undefined : item.id)}
              onToggleExpert={() => setExpertExpanded((current) => current === item.id ? undefined : item.id)}
            /> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function RuntimeDetail({
  item,
  reasoningOpen,
  expertOpen,
  onToggleReasoning,
  onToggleExpert
}: {
  item: TrafficCapture;
  reasoningOpen: boolean;
  expertOpen: boolean;
  onToggleReasoning: () => void;
  onToggleExpert: () => void;
}) {
  const parsed = parsePlaygroundResponse(item.responsePreview);
  return (
    <div className="runtime-detail">
      <div className="runtime-request">
        <b>Request</b>
        <pre>{formatRawResponse(item.requestPreview)}</pre>
      </div>
      <div className="runtime-response">
        <div className="runtime-detail-head">
          <b>Response</b>
          <button className="secondary-btn" onClick={onToggleExpert}>{expertOpen ? "Hide expert" : "Expert"}</button>
        </div>
        {expertOpen ? (
          <div className="response-fold">
            <pre>{formatRawResponse(item.responsePreview)}</pre>
          </div>
        ) : (
          <>
            <div className="answer-box compact-answer">{parsed.answer || "No response content."}</div>
            {parsed.reasoning ? (
              <div className="response-fold">
                <button className="secondary-btn" onClick={onToggleReasoning}>{reasoningOpen ? "Hide reasoning" : "Show reasoning"}</button>
                {reasoningOpen ? <pre>{parsed.reasoning}</pre> : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function LogsView({ data }: { data: IgniteData }) {
  const bundle = data.logBundle;
  const [selectedModel, setSelectedModel] = useState("");
  const modelLogs = bundle?.models || [];
  const activeModelLog = modelLogs.find((log) => log.name === selectedModel) || modelLogs[0];
  useEffect(() => {
    if (!selectedModel && modelLogs[0]) setSelectedModel(modelLogs[0].name);
    if (selectedModel && modelLogs.length > 0 && !modelLogs.some((log) => log.name === selectedModel)) {
      setSelectedModel(modelLogs[0].name);
    }
  }, [modelLogs, selectedModel]);

  return (
    <section className="view">
      <PageHeader title="Logs" detail={bundle?.directory || data.config?.logsPath || ""} />
      <div className="log-summary">
        <span><span className="dot hot" /> Saved to disk</span>
        <span>Updates every 5 seconds</span>
        <span>Newest entries first</span>
      </div>
      <div className="logs-layout">
        <div className="panel log-panel">
          <div className="panel-head">
            <div>
              <b>Ignite</b>
              <small>{bundle?.ignite.path || "No log file yet"}</small>
            </div>
            <span>{bundle?.ignite.lines.length || 0} recent lines</span>
          </div>
          <LogLines lines={bundle?.ignite.lines || []} empty="No Ignite logs yet." />
        </div>
        <div className="panel log-panel">
          <div className="panel-head">
            <div>
              <b>llama.cpp</b>
              <small>{activeModelLog?.path || "No model log file yet"}</small>
            </div>
            <div className="log-controls">
              {activeModelLog ? <span>{activeModelLog.lines.length} recent lines</span> : null}
              {modelLogs.length > 0 ? (
                <select value={activeModelLog?.name || ""} onChange={(event) => setSelectedModel(event.target.value)}>
                  {modelLogs.map((log) => <option key={log.name} value={log.name}>{log.name.replace(/\.log$/, "")}</option>)}
                </select>
              ) : null}
            </div>
          </div>
          <LogLines lines={activeModelLog?.lines || []} empty="No llama.cpp logs yet. Load a model to start capturing stdout/stderr." />
        </div>
      </div>
    </section>
  );
}

function LogLines({ lines, empty }: { lines: string[]; empty: string }) {
  const tail = lines.slice(-220).reverse();
  return (
    <pre className="log-lines">
      {tail.length > 0 ? tail.join("\n") : empty}
    </pre>
  );
}

function Playground({ data }: { data: IgniteData }) {
  const [modelId, setModelId] = useState(data.models[0]?.id || "");
  const [endpoint, setEndpoint] = useState<"chat" | "completion" | "embedding">("chat");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [prompt, setPrompt] = useState("Reply with a short test response.");
  const [temperature, setTemperature] = useState("0.2");
  const [maxTokens, setMaxTokens] = useState("128");
  const [topP, setTopP] = useState("0.95");
  const [topK, setTopK] = useState("40");
  const [repeatPenalty, setRepeatPenalty] = useState("1.05");
  const [seed, setSeed] = useState("");
  const [stream, setStream] = useState(false);
  const [expertArgsOpen, setExpertArgsOpen] = useState(false);
  const [extraArgsText, setExtraArgsText] = useState("{}");
  const [imageData, setImageData] = useState("");
  const [imageName, setImageName] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [rawResponse, setRawResponse] = useState("");
  const [elapsedMs, setElapsedMs] = useState<number>();
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [rawResponseOpen, setRawResponseOpen] = useState(false);

  useEffect(() => {
    if ((!modelId || !data.models.some((model) => model.id === modelId)) && data.models[0]) {
      setModelId(data.models[0].id);
    }
  }, [data.models, modelId]);

  const selected = data.models.find((model) => model.id === modelId);
  const send = async () => {
    setSending(true);
    setError("");
    setRawResponse("");
    setElapsedMs(undefined);
    try {
      const extra = extraArgsText.trim() ? JSON.parse(extraArgsText) : {};
      const requestArgs = cleanRequestArgs({
        temperature: Number(temperature),
        max_tokens: Number(maxTokens),
        top_p: Number(topP),
        top_k: Number(topK),
        repeat_penalty: Number(repeatPenalty),
        seed: seed === "" ? undefined : Number(seed),
        stream
      });
      const body = buildPlaygroundBody(endpoint, modelId, prompt, systemPrompt, imageData, extra);
      Object.assign(body, requestArgs);
      const path = endpoint === "chat" ? "/v1/chat/completions" : endpoint === "completion" ? "/v1/completions" : "/v1/embeddings";
      const started = performance.now();
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const text = await res.text();
      const elapsed = Math.round(performance.now() - started);
      if (!res.ok) throw new Error(responseErrorMessage(text, res.statusText));
      setElapsedMs(elapsed);
      setRawResponse(text);
      void data.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setSending(false);
    }
  };

  const parsed = parsePlaygroundResponse(rawResponse);

  const pickImage = (file?: File) => {
    if (!file) {
      setImageData("");
      setImageName("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImageData(String(reader.result || ""));
      setImageName(file.name);
    };
    reader.readAsDataURL(file);
  };

  return (
    <section className="view">
      <PageHeader title="Playground" detail={selected ? `${selected.profile} · ${gpuIndex(data, selected.gpu)}` : ""} />
      <div className="playground-layout">
        <div className="panel playground-form">
          <div className="editor-grid">
            <label className="field">
              <span>Model</span>
              <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
                {data.models.map((model) => (
                  <option key={model.id} value={model.id}>{model.id}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Endpoint</span>
              <select value={endpoint} onChange={(event) => setEndpoint(event.target.value as "chat" | "completion" | "embedding")}>
                <option value="chat">Chat completions</option>
                <option value="completion">Completions</option>
                <option value="embedding">Embeddings</option>
              </select>
            </label>
          </div>

          <Field label="System" value={systemPrompt} multiline onChange={setSystemPrompt} />
          <Field label={endpoint === "embedding" ? "Input" : "Prompt"} value={prompt} multiline tall onChange={setPrompt} />

          <div className="editor-section compact-section">
            <div className="editor-section-title">Request args</div>
            <div className="args-grid">
              <Field label="Temperature" value={temperature} onChange={setTemperature} />
              <Field label="Max tokens" value={maxTokens} onChange={setMaxTokens} />
              <Field label="Top P" value={topP} onChange={setTopP} />
              <Field label="Top K" value={topK} onChange={setTopK} />
              <Field label="Repeat penalty" value={repeatPenalty} onChange={setRepeatPenalty} />
              <Field label="Seed" value={seed} onChange={setSeed} />
            </div>
            <label className="toggle-line"><input type="checkbox" checked={stream} onChange={(event) => setStream(event.target.checked)} /> Stream</label>
            <div>
              <button className="secondary-btn" onClick={() => setExpertArgsOpen((current) => !current)}>{expertArgsOpen ? "Hide expert args" : "Expert args"}</button>
            </div>
            {expertArgsOpen ? <Field label="Extra request JSON" value={extraArgsText} multiline tall onChange={setExtraArgsText} /> : null}
          </div>

          <div className="image-input-row">
            <label className="secondary-btn">
              Image
              <input type="file" accept="image/*" onChange={(event) => pickImage(event.target.files?.[0])} />
            </label>
            <span>{imageName || "No image attached"}</span>
            {imageData ? <button className="secondary-btn" onClick={() => pickImage()}>Remove</button> : null}
          </div>

          {imageData ? <img className="image-preview" src={imageData} alt="" /> : null}

          {error ? <div className="inline-error">{error}</div> : null}
          <div className="row-actions">
            <button className="primary-btn" disabled={sending || !modelId} onClick={() => void send()}>{sending ? "Sending" : "Send"}</button>
          </div>
        </div>

        <div className="panel playground-response">
          <div className="panel-head"><b>Response</b><span className="status">{selected?.status || "stopped"}</span></div>
          {elapsedMs !== undefined ? <span className="response-meta">{elapsedMs} ms</span> : null}
          <div className="response-box answer-box">{parsed.answer || "No response yet."}</div>
          {parsed.reasoning ? (
            <div className="response-fold">
              <button className="secondary-btn" onClick={() => setReasoningOpen((current) => !current)}>{reasoningOpen ? "Hide reasoning" : "Show reasoning"}</button>
              {reasoningOpen ? <pre>{parsed.reasoning}</pre> : null}
            </div>
          ) : null}
          {rawResponse ? (
            <div className="response-fold">
              <button className="secondary-btn" onClick={() => setRawResponseOpen((current) => !current)}>{rawResponseOpen ? "Hide full response" : "Expert: full response"}</button>
              {rawResponseOpen ? <pre>{formatRawResponse(rawResponse)}</pre> : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SettingsView({ data }: { data: IgniteData }) {
  const [draft, setDraft] = useState(data.config);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(data.config), [data.config]);
  const update = (patch: Partial<NonNullable<typeof draft>>) => {
    setDraft((current) => current ? { ...current, ...patch } : current);
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await api.updateConfig(draft);
      await data.refresh();
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="view">
      <PageHeader title="Settings" detail={data.config?.listen || ""} />
      {data.about?.update.available ? (
        <div className="update-banner">
          <div>
            <b>Ignite v{data.about.update.latestVersion} {data.about.update.prerelease ? "beta " : ""}available</b>
            <span>You are running v{data.about.update.currentVersion}. Update when you are ready.</span>
          </div>
          {data.about.update.releaseUrl ? <a className="secondary-btn" href={data.about.update.releaseUrl} target="_blank" rel="noreferrer">Release <ExternalLink size={14} /></a> : null}
        </div>
      ) : null}
      <div className="settings-grid">
        <div className="panel form-panel">
          <div className="panel-head"><b>Runtime</b><button className="primary-btn" disabled={saving || !draft} onClick={save}>{saving ? "Saving" : "Save"}</button></div>
          <Field label="Listen address" value={draft?.listen || ""} onChange={(value) => update({ listen: value })} />
          <Field label="Logs path" value={draft?.logsPath || ""} onChange={(value) => update({ logsPath: value })} />
          <Field label="Models path" value={draft?.modelsPath || ""} onChange={(value) => update({ modelsPath: value, downloads: { ...(draft?.downloads || { concurrent: 2, directory: value }), directory: value } })} />
          <Field label="Projectors path" value={draft?.mmprojectsPath || ""} onChange={(value) => update({ mmprojectsPath: value })} />
          <Field label="Start port" value={String(draft?.startPort || 5800)} onChange={(value) => update({ startPort: Number(value) || 5800 })} />
        </div>
        <div className="panel form-panel">
          <div className="panel-head"><b>Behavior</b></div>
          <Field label="Global TTL seconds" value={String(draft?.ttl.global || 0)} onChange={(value) => update({ ttl: { global: Number(value) || 0 } })} />
          <Field label="Health check model" value={draft?.healthCheck.model || ""} onChange={(value) => update({ healthCheck: { ...(draft?.healthCheck || { timeout: 120 }), model: value } })} />
          <Field label="Health timeout seconds" value={String(draft?.healthCheck.timeout || 120)} onChange={(value) => update({ healthCheck: { ...(draft?.healthCheck || { model: "" }), timeout: Number(value) || 120 } })} />
          <Field label="Active backend" value={draft?.activeBackend || ""} onChange={(value) => update({ activeBackend: value })} />
        </div>
      </div>
      <AboutPanel data={data} />
    </section>
  );
}

function AboutPanel({ data }: { data: IgniteData }) {
  const about = data.about;
  const update = about?.update;
  return (
    <div className="panel about-panel">
      <div className="panel-head">
        <b>About</b>
        <span>v{about?.version || "0.1.0"}</span>
      </div>
      <div className="about-grid">
        <div>
          <span>Ignite</span>
          <strong>{about?.repo ? about.repo : "local build"}</strong>
          <small>{update?.configured ? updateStatusText(update) : "Update checks will enable once the public repo is configured."}</small>
        </div>
        <div className="about-links">
          <a href={about?.links.author || "#"} target="_blank" rel="noreferrer"><Github size={16} /> {about?.links.authorName || "Spadav_"}</a>
          <a href={about?.links.timbre || "#"} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Looking for local TTS/STT? Check out Timbre</a>
          {about?.links.ignite ? (
            <a href={about.links.ignite} target="_blank" rel="noreferrer"><Star size={16} /> Star Ignite on GitHub</a>
          ) : (
            <span><Star size={16} /> GitHub repo not configured yet</span>
          )}
        </div>
      </div>
    </div>
  );
}

function Placeholder({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <section className="view">
      <PageHeader title={title} />
      <div className="placeholder-panel">
        <Layers3 size={24} />
        <p>{subtitle}</p>
      </div>
    </section>
  );
}

function PageHeader({ title, detail }: { title: string; detail?: string }) {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      {detail ? <span><span className="dot hot" /> {detail}</span> : null}
      <code>http://localhost:8091/v1</code>
    </header>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <h2 className="section-title">{title}</h2>;
}

function Metric({ label, value, suffix, spark, compact }: { label: string; value: string; suffix?: string; spark?: boolean; compact?: boolean }) {
  return (
    <div className={compact ? "metric compact" : "metric"}>
      <span>{label}</span>
      <strong>{value}<small>{suffix}</small></strong>
      {spark ? <svg viewBox="0 0 120 26" aria-hidden="true"><polyline points="0,18 12,14 24,16 36,9 48,13 60,6 72,10 84,4 96,8 108,5 120,9" /></svg> : null}
    </div>
  );
}

function GpuCard({
  gpu,
  index,
  activeModels
}: {
  gpu: { name: string; vram: number; vramUsed?: number; utilization: number; temperature: number };
  index: number;
  activeModels: string[];
}) {
  const used = gpu.vramUsed || 0;
  const memoryPct = gpu.vram ? Math.round((used / gpu.vram) * 100) : 0;
  const activeLabel = activeModels.length > 0 ? activeModels.join(", ") : "idle";
  return (
    <div className="gpu-card">
      <div className="card-title"><span>GPU {index}</span><b>{shortGpuName(gpu.name)}</b><em>{gpu.temperature}°C</em></div>
      <Progress label="utilization" value={gpu.utilization || 0} />
      <Progress label="VRAM" value={memoryPct} detail={`${formatGb(used)} / ${formatGb(gpu.vram)} GB`} />
      <div className="running-line"><span className={activeModels.length ? "dot hot" : "dot"} /> {activeModels.length ? <>running <b>{activeLabel}</b></> : "idle"}</div>
    </div>
  );
}

function Progress({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <div className="progress-row">
      <div><span>{label}</span><small>{detail || `${value}%`}</small></div>
      <div className="bar"><i style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
    </div>
  );
}

function updateStatusText(update: NonNullable<IgniteData["about"]>["update"]) {
  if (update.available) return `v${update.latestVersion}${update.prerelease ? " beta" : ""} is available.`;
  if (update.error) return `Update check failed: ${update.error}`;
  if (update.checkedAt) return "Ignite is up to date.";
  return "Update check pending.";
}

function ModelCard({ model, data, selected, onSelect, onEdit, onDelete }: { model: ModelInfo; data: IgniteData; selected: boolean; onSelect: () => void; onEdit: () => void; onDelete: () => void }) {
  const running = model.status === "running";
  return (
    <div className={selected ? "model-card selected" : "model-card"} onClick={onSelect}>
      <div className="panel-head"><b>{model.id}</b><span className={running ? "status running" : "status"}>{model.status}</span></div>
      <small>{model.profile} · {gpuIndex(data, model.gpu)}</small>
      <code>{model.file}</code>
      <div className="tag-row">{model.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
      <div className="row-actions" onClick={(event) => event.stopPropagation()}>
        <ActionButton icon={Settings} label="Edit" onClick={onEdit} />
        <ActionButton icon={X} label="Delete" onClick={onDelete} />
        {running ? <ActionButton icon={Power} label="Unload" onClick={() => void api.unloadModel(model.id).then(data.refresh)} /> : <ActionButton icon={Play} label="Load" onClick={() => void api.loadModel(model.id).then(data.refresh)} />}
      </div>
    </div>
  );
}

function ModelConfigModal({ model, data, creating = false, onClose, onCreated }: { model?: ModelInfo; data: IgniteData; creating?: boolean; onClose: () => void; onCreated?: (id: string) => void }) {
  const [draft, setDraft] = useState<ModelInfo | undefined>(model);
  const [runtimeGroup, setRuntimeGroup] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [flagCatalog, setFlagCatalog] = useState<BackendFlagCatalog>();
  const [flagsLoading, setFlagsLoading] = useState(false);
  const [flagsError, setFlagsError] = useState("");
  const [rawArgsOpen, setRawArgsOpen] = useState(false);
  const openedModelId = model?.id;
  const activeBackend = data.config?.activeBackend || data.status?.activeBackend;

  useEffect(() => {
    setDraft(model);
    const nextGroup = model && data.config ? getModelAssignedGroup(model.id, data.config.groups || {}) : "";
    setRuntimeGroup(nextGroup);
    setError("");
  }, [openedModelId, creating]);

  useEffect(() => {
    if (!openedModelId || !activeBackend) return;
    let cancelled = false;
    setFlagsLoading(true);
    setFlagsError("");
    api.backendFlags(activeBackend)
      .then((catalog) => {
        if (!cancelled) setFlagCatalog(catalog);
      })
      .catch((err) => {
        if (!cancelled) setFlagsError(err instanceof Error ? err.message : "Unable to inspect llama.cpp flags.");
      })
      .finally(() => {
        if (!cancelled) setFlagsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openedModelId, activeBackend]);

  if (!draft) return null;

  const set = (patch: Partial<ModelInfo>) => setDraft((current) => current ? { ...current, ...patch } : current);
  const thinkingEnabled = !isThinkingDisabled(draft.args);
  const save = async () => {
    if (!data.config || !model) return;
    const nextId = draft.id.trim();
    if (!nextId) {
      setError("Model ID is required.");
      return;
    }
    if ((creating || nextId !== model.id) && data.config.models[nextId]) {
      setError(`Model ID "${nextId}" already exists.`);
      return;
    }
    if (!draft.file) {
      setError("Choose a GGUF file.");
      return;
    }
    if (!draft.gpu) {
      setError("Choose a GPU.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const { id: _id, status: _status, ...payload } = draft;
      if (creating) {
        await api.createModel(nextId, payload, runtimeGroup);
        onCreated?.(nextId);
      } else if (nextId === model.id) {
        await api.updateModel(model.id, payload, runtimeGroup);
      } else {
        const models = { ...data.config.models };
        delete models[model.id];
        models[nextId] = payload;
        const healthCheck = data.config.healthCheck.model === model.id
          ? { ...data.config.healthCheck, model: nextId }
          : data.config.healthCheck;
        const nextConfig = {
          ...data.config,
          healthCheck,
          models,
          groups: assignModelGroup(data.config.groups || {}, nextId, runtimeGroup, model.id)
        };
        await api.updateConfig(nextConfig);
      }
      await data.refresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save model config.");
    } finally {
      setSaving(false);
    }
  };
  const gpuOptions = mergeGpuOptions(data);
  const chooseFile = (file: string) => {
    if (!creating) {
      set({ file });
      return;
    }
    const baseName = ggufName(file);
    set({
      file,
      id: uniqueModelId(baseName, data.config?.models || {}),
      family: inferModelFamily(baseName)
    });
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal-panel model-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Model config">
        <header className="modal-head">
          <div>
            <span className="modal-kicker">{creating ? "New model config" : "Model config"}</span>
            <h2>{draft.id}</h2>
            <code>{draft.file ? ggufName(draft.file) : "choose a GGUF file"}</code>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close"><X size={18} /></button>
        </header>

        <div className="modal-body">
          {error ? <div className="inline-error">{error}</div> : null}
          <div className="editor-section">
            <div className="editor-section-title">Identity</div>
            <div className="editor-grid">
              <Field label="Model ID (request name)" value={draft.id} onChange={(value) => set({ id: value })} />
              <Field label="Model name" value={ggufName(draft.file)} disabled />
              <Field label="Family" value={draft.family} onChange={(value) => set({ family: value })} />
              <Field label="Profile" value={draft.profile} onChange={(value) => set({ profile: value })} />
              <label className="field">
                <span>GGUF file</span>
                <select value={draft.file} onChange={(event) => chooseFile(event.target.value)}>
                  <option value="">Choose from models folder</option>
                  {data.modelFiles.map((file) => (
                    <option key={file.relative} value={file.relative}>{file.relative}</option>
                  ))}
                </select>
              </label>
              <Field label="MMProj" value={draft.mmproj || ""} onChange={(value) => set({ mmproj: value })} />
            </div>
          </div>

          <div className="editor-section">
            <div className="editor-section-title">Runtime</div>
            <div className="editor-grid">
              <label className="field">
                <span>GPU assignment</span>
                <select value={draft.gpu} onChange={(event) => set({ gpu: event.target.value })}>
                  <option value="">Select GPU</option>
                  {gpuOptions.map((gpu, index) => (
                    <option key={gpu.id} value={gpu.id}>{gpuLabel(gpu, index)}</option>
                  ))}
                </select>
              </label>
              <Field label="TTL seconds" value={draft.ttl === undefined ? "" : String(draft.ttl)} onChange={(value) => set({ ttl: value === "" ? undefined : Number(value) || 0 })} />
              <label className="field">
                <span>Runtime group</span>
                <select value={runtimeGroup} onChange={(event) => setRuntimeGroup(event.target.value)}>
                  <option value="">Default swapping</option>
                  {sortedEntries(data.config?.groups || {}).map(([name]) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
            </div>
          </div>

          <div className="editor-section">
            <div className="editor-section-title">Alternative request names</div>
            <div className="editor-grid single">
              <Field label="Aliases" value={draft.aliases.join("\n")} multiline onChange={(value) => set({ aliases: lines(value) })} />
              <Field label="Tags" value={draft.tags.join("\n")} multiline onChange={(value) => set({ tags: lines(value) })} />
            </div>
          </div>

          <div className="editor-section">
            <div className="editor-section-title">Thinking</div>
            <div className="segmented">
              <button className={thinkingEnabled ? "active" : ""} onClick={() => set({ args: setThinking(draft.args, true) })}>On</button>
              <button className={!thinkingEnabled ? "active" : ""} onClick={() => set({ args: setThinking(draft.args, false) })}>Off</button>
            </div>
          </div>

          <div className="editor-section">
            <div className="editor-section-title">llama.cpp flags</div>
            <ModelFlagsEditor
              args={draft.args}
              catalog={flagCatalog}
              loading={flagsLoading}
              error={flagsError}
              onChange={(args) => set({ args })}
            />
            <div className="expert-command-toggle">
              <button className="secondary-btn" onClick={() => setRawArgsOpen((current) => !current)}>
                {rawArgsOpen ? "Hide expert command" : "Expert command"}
              </button>
              <small>Unknown or custom arguments are preserved.</small>
            </div>
            {rawArgsOpen ? <Field label="Raw llama-server args" value={draft.args} multiline tall onChange={(value) => set({ args: value })} /> : null}
          </div>
        </div>

        <footer className="modal-actions">
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" disabled={saving || !data.config} onClick={save}>{saving ? "Saving" : creating ? "Create" : "Save"}</button>
        </footer>
      </section>
    </div>
  );
}

type ConfiguredBackendFlag = {
  flag: BackendFlag;
  alias: string;
  value: string;
  negative: boolean;
};

function ModelFlagsEditor({ args, catalog, loading, error, onChange }: { args: string; catalog?: BackendFlagCatalog; loading: boolean; error: string; onChange: (args: string) => void }) {
  const [search, setSearch] = useState("");
  const configured = configuredBackendFlags(args, catalog?.flags || []);
  const configuredNames = new Set(configured.map((entry) => entry.flag.name));
  const query = search.trim().toLowerCase();
  const available = (catalog?.flags || []).filter((flag) => {
    if (flag.managed || configuredNames.has(flag.name)) return false;
    if (!query) return true;
    return `${flag.name} ${flag.aliases.join(" ")} ${flag.description} ${flag.category}`.toLowerCase().includes(query);
  });

  const addFlag = (name: string) => {
    const flag = catalog?.flags.find((item) => item.name === name);
    if (!flag) return;
    onChange(updateBackendFlag(args, flag, defaultFlagValue(flag), true));
    setSearch("");
  };

  return (
    <div className="flag-editor">
      <div className="flag-catalog-meta">
        <div>
          <b>{catalog ? `${catalog.flags.filter((flag) => !flag.managed).length} flags available` : "Backend flag catalog"}</b>
          <small>{catalog ? `${catalog.backendId}${catalog.gitHash ? ` · ${catalog.gitHash}` : ""}` : loading ? "Reading llama-server --help" : "Catalog unavailable"}</small>
        </div>
        {loading ? <Loader2 size={16} className="spin" /> : null}
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      {catalog ? (
        <div className="flag-add-controls">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search llama.cpp flags" />
          <select value="" onChange={(event) => addFlag(event.target.value)}>
            <option value="">Add flag</option>
            {groupFlagsByCategory(available).map(([category, flags]) => (
              <optgroup key={category} label={category}>
                {flags.slice(0, 60).map((flag) => <option key={flag.name} value={flag.name}>{flag.name} · {shortFlagDescription(flag.description)}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
      ) : null}
      <div className="configured-flags">
        {configured.length === 0 ? <div className="empty compact">No recognized backend flags in this command.</div> : configured.map((entry) => (
          <div className="configured-flag" key={entry.flag.name}>
            <div className="configured-flag-info">
              <div><b>{entry.flag.name}</b><span>{entry.flag.category}</span></div>
              <small>{entry.flag.description}</small>
            </div>
            <div className="configured-flag-control">
              {entry.flag.kind === "boolean" ? (
                entry.flag.negativeName ? (
                  <select value={entry.negative ? "off" : "on"} onChange={(event) => onChange(updateBackendFlag(args, entry.flag, event.target.value, true))}>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                ) : <span className="flag-enabled">Enabled</span>
              ) : entry.flag.kind === "select" && entry.flag.choices?.length ? (
                <select value={entry.value} onChange={(event) => onChange(updateBackendFlag(args, entry.flag, event.target.value, true))}>
                  {!entry.flag.choices.includes(entry.value) ? <option value={entry.value}>{entry.value || "Choose value"}</option> : null}
                  {entry.flag.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                </select>
              ) : (
                <input
                  type={entry.flag.kind === "number" ? "number" : "text"}
                  value={entry.value}
                  placeholder={entry.flag.valueHint || "value"}
                  onChange={(event) => onChange(updateBackendFlag(args, entry.flag, event.target.value, true))}
                />
              )}
              <button className="icon-btn" onClick={() => onChange(updateBackendFlag(args, entry.flag, "", false))} title={`Remove ${entry.flag.name}`}><X size={14} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, multiline, tall, disabled }: { label: string; value: string; onChange?: (value: string) => void; multiline?: boolean; tall?: boolean; disabled?: boolean }) {
  return (
    <label className="field">
      <span>{label}</span>
      {multiline ? (
        <textarea className={tall ? "tall" : ""} value={value} disabled={disabled} onChange={(event) => onChange?.(event.target.value)} />
      ) : (
        <input value={value} disabled={disabled} onChange={(event) => onChange?.(event.target.value)} />
      )}
    </label>
  );
}

function ActivityPanel({ traffic, logs }: { traffic: TrafficCapture[]; logs: { time: string; message: string }[] }) {
  const recent = traffic.slice(0, 5);
  return (
    <div>
      <SectionTitle title="Recent activity" />
      <div className="activity panel">
        {recent.length > 0 ? recent.map((item) => (
          <div className="activity-row request-activity" key={item.id}>
            <time>{new Date(item.time).toLocaleTimeString()}</time>
            <b>{item.model}</b>
            <span className={item.status >= 400 ? "status error" : "status running"}>{item.status}</span>
            <small>{item.durationMs} ms · {item.totalTokens || "-"} tok</small>
          </div>
        )) : logs.slice(0, 5).map((log, index) => (
          <div className="activity-row" key={index}><time>{new Date(log.time).toLocaleTimeString()}</time><b>{extractActivity(log.message)}</b></div>
        ))}
      </div>
    </div>
  );
}

function ConnectPanel({ endpoint }: { endpoint: string }) {
  return (
    <div>
      <SectionTitle title="Connect" />
      <div className="panel connect">
        <b>OpenAI-compatible</b>
        <span>Point any client at the endpoint.</span>
        <pre>{`curl localhost:${endpoint.split(":").pop()}/v1/chat/completions \\
  -d '{"model":"model-name","messages":[...]}'`}</pre>
      </div>
    </div>
  );
}

function ActionButton({ icon: Icon, label, onClick }: { icon: React.ElementType; label: string; onClick: () => void }) {
  return <button className="action-btn" onClick={onClick} title={label}><Icon size={15} /> {label}</button>;
}

function Banner({ message }: { message: string }) {
  return <div className="banner"><Activity size={16} /> {message}</div>;
}

function buildPlaygroundBody(
  endpoint: "chat" | "completion" | "embedding",
  model: string,
  prompt: string,
  systemPrompt: string,
  imageData: string,
  extra: Record<string, unknown>
) {
  if (endpoint === "embedding") {
    return { model, input: prompt, ...extra };
  }
  if (endpoint === "completion") {
    return { model, prompt, ...extra };
  }

  const messages: unknown[] = [];
  if (systemPrompt.trim()) {
    messages.push({ role: "system", content: systemPrompt });
  }
  const content = imageData
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageData } }
      ]
    : prompt;
  messages.push({ role: "user", content });
  return { model, messages, ...extra };
}

function cleanRequestArgs(args: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => {
      if (value === undefined || value === "") return false;
      if (typeof value === "number" && Number.isNaN(value)) return false;
      return true;
    })
  );
}

function parsePlaygroundResponse(raw: string): { answer: string; reasoning: string } {
  if (!raw) return { answer: "", reasoning: "" };
  if (raw.startsWith("data: ") || raw.includes("\ndata: ")) {
    return parseStreamResponse(raw);
  }
  try {
    const json = JSON.parse(raw);
    const choice = json.choices?.[0] || {};
    const message = choice.message || {};
    const answer = String(message.content ?? choice.text ?? json.data?.[0]?.embedding?.slice?.(0, 12)?.join(", ") ?? "");
    const reasoning = String(message.reasoning_content ?? choice.reasoning_content ?? "");
    return splitThinkBlock(answer, reasoning);
  } catch {
    return splitThinkBlock(raw, "");
  }
}

function parseStreamResponse(raw: string) {
  let answer = "";
  let reasoning = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta || {};
      answer += delta.content || "";
      reasoning += delta.reasoning_content || "";
    } catch {
      // Keep malformed stream fragments in the raw expert view.
    }
  }
  return splitThinkBlock(answer, reasoning);
}

function splitThinkBlock(answer: string, existingReasoning: string) {
  const match = answer.match(/<think>([\s\S]*?)<\/think>/i);
  if (!match) return { answer: answer.trim(), reasoning: existingReasoning.trim() };
  return {
    answer: answer.replace(match[0], "").trim(),
    reasoning: `${existingReasoning ? `${existingReasoning}\n\n` : ""}${match[1]}`.trim()
  };
}

function formatRawResponse(text: string) {
  try {
    const json = JSON.parse(text);
    return JSON.stringify(json, null, 2);
  } catch {
    return text;
  }
}

function responseErrorMessage(text: string, fallback: string) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || text || fallback;
  } catch {
    return text || fallback;
  }
}

function configuredBackendFlags(args: string, flags: BackendFlag[]): ConfiguredBackendFlag[] {
  const aliases = new Map<string, BackendFlag>();
  for (const flag of flags) {
    for (const alias of flag.aliases) aliases.set(alias, flag);
  }
  const configured = new Map<string, ConfiguredBackendFlag>();
  const tokens = tokenizeCommandArgs(args);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const equals = token.indexOf("=");
    const alias = equals > 0 ? token.slice(0, equals) : token;
    const flag = aliases.get(alias);
    if (!flag || flag.managed) continue;
    let value = equals > 0 ? token.slice(equals + 1) : "";
    if (flag.kind !== "boolean" && equals < 0 && index + 1 < tokens.length) {
      value = tokens[index + 1];
      index += 1;
    }
    configured.set(flag.name, {
      flag,
      alias,
      value,
      negative: isNegativeFlagAlias(alias, flag)
    });
  }
  return [...configured.values()];
}

function updateBackendFlag(args: string, flag: BackendFlag, value: string, enabled: boolean) {
  const aliases = new Set(flag.aliases);
  const tokens = tokenizeCommandArgs(args);
  const next: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const equals = token.indexOf("=");
    const alias = equals > 0 ? token.slice(0, equals) : token;
    if (!aliases.has(alias)) {
      next.push(token);
      continue;
    }
    if (flag.kind !== "boolean" && equals < 0 && index + 1 < tokens.length) index += 1;
  }
  if (enabled) {
    if (flag.kind === "boolean") {
      next.push(value === "off" && flag.negativeName ? flag.negativeName : flag.name);
    } else {
      next.push(flag.name);
      if (value !== "") next.push(value);
    }
  }
  return serializeCommandArgs(next);
}

function tokenizeCommandArgs(input: string) {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function serializeCommandArgs(tokens: string[]) {
  return tokens.map((token) => {
    if (/^[A-Za-z0-9_./:=,+;{}-]+$/.test(token)) return token;
    return `"${token.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }).join(" ");
}

function isNegativeFlagAlias(alias: string, flag: BackendFlag) {
  if (!flag.negativeName) return false;
  return alias === flag.negativeName || (alias.startsWith("-n") && !alias.startsWith("--"));
}

function defaultFlagValue(flag: BackendFlag) {
  if (flag.kind === "boolean") return "on";
  if (flag.choices?.length) {
    const normalizedDefault = flag.default?.toLowerCase() || "";
    return flag.choices.find((choice) => normalizedDefault.includes(choice.toLowerCase())) || (flag.choices.includes("auto") ? "auto" : flag.choices[0]);
  }
  if (flag.kind === "number") return flag.default?.match(/-?\d+(?:\.\d+)?/)?.[0] || "";
  return "";
}

function groupFlagsByCategory(flags: BackendFlag[]) {
  const grouped = new Map<string, BackendFlag[]>();
  for (const flag of flags) {
    const items = grouped.get(flag.category) || [];
    items.push(flag);
    grouped.set(flag.category, items);
  }
  return [...grouped.entries()];
}

function shortFlagDescription(description: string) {
  const clean = description.replace(/\s+/g, " ").trim();
  return clean.length > 72 ? `${clean.slice(0, 69)}...` : clean;
}

function byId(models: ModelInfo[]) {
  return Object.fromEntries(models.map((model) => [model.id, model]));
}

function groupBy<T>(items: T[], fn: (item: T) => string) {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const key = fn(item);
    acc[key] ||= [];
    acc[key].push(item);
    return acc;
  }, {});
}

function sortedEntries<T>(obj: Record<string, T>) {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
}

function sortedValues<T extends { id?: string }>(obj: Record<string, T>) {
  return sortedEntries(obj).map(([, value]) => value).sort((a, b) => (a.id || "").localeCompare(b.id || ""));
}

function ggufName(file: string) {
  const name = file.split("/").pop() || file;
  return name.replace(/\.gguf$/i, "");
}

function createDraftModel(data: IgniteData, file?: ModelFile): ModelInfo {
  const gpu = mergeGpuOptions(data)[0];
  const baseName = file ? ggufName(file.relative || file.name) : "new-model";
  const id = uniqueModelId(baseName, data.config?.models || {});
  return {
    id,
    family: inferModelFamily(baseName),
    profile: "Default",
    tags: [],
    file: file?.relative || "",
    mmproj: "",
    gpu: gpu?.id || "",
    args: "-ngl 99 -fa on -c 8192 --split-mode none --main-gpu 0",
    aliases: [],
    status: "stopped"
  };
}

function uniqueModelId(name: string, existing: Record<string, unknown>) {
  const base = sanitizeModelId(name) || "model";
  let id = base;
  let index = 2;
  while (existing[id]) {
    id = `${base}-${index}`;
    index += 1;
  }
  return id;
}

function sanitizeModelId(name: string) {
  return name
    .replace(/\.gguf$/i, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function inferModelFamily(name: string) {
  const compact = name.replace(/[-_.]+/g, " ").trim();
  return compact.split(/\s+/).slice(0, 2).join(" ") || "Local";
}

function mergeGpuOptions(data: IgniteData) {
  const map = new Map<string, { id: string; name: string; vram?: number }>();
  for (const gpu of data.config?.gpus || []) {
    if (gpu.id) map.set(gpu.id, gpu);
  }
  for (const gpu of data.gpus) {
    if (gpu.id) map.set(gpu.id, { ...map.get(gpu.id), ...gpu });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function gpuLabel(gpu: { id: string; name: string; vram?: number }, index: number) {
  const vram = gpu.vram ? ` · ${Math.round(gpu.vram / 1024)} GB` : "";
  return `GPU ${index}: ${shortGpuName(gpu.name)} · ${gpu.id}${vram}`;
}

function getModelAssignedGroup(modelId: string, groups: Record<string, { members: string[] }>) {
  return sortedEntries(groups).find(([, group]) => group.members?.includes(modelId))?.[0] || "";
}

function assignModelGroup(
  groups: Record<string, { swap: boolean; persistent: boolean; members: string[] }>,
  modelId: string,
  nextGroup: string,
  previousModelId = modelId
) {
  const next = Object.fromEntries(
    sortedEntries(groups).map(([name, group]) => [
      name,
      { ...group, members: (group.members || []).filter((member) => member !== modelId && member !== previousModelId) }
    ])
  );

  if (nextGroup) {
    next[nextGroup] = {
      ...(next[nextGroup] || { swap: true, persistent: false, members: [] }),
      members: [...(next[nextGroup]?.members || []), modelId]
    };
  }

  return next;
}

function isThinkingDisabled(args: string) {
  const normalized = args.replace(/\s+/g, "");
  return normalized.includes('enable_thinking":false') || normalized.includes("enable_thinking':false");
}

function setThinking(args: string, enabled: boolean) {
  let next = args
    .replace(/--chat-template-kwargs\s+('(?:[^']*)'|"(?:[^"]*)")/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (enabled) return next;
  if (!/(^|\s)--jinja(?=\s|$)/.test(next)) {
    next = `${next} --jinja`.trim();
  }
  return `${next} --chat-template-kwargs '{"enable_thinking":false}'`.trim();
}

function sumVram(gpus: { vram: number }[]) {
  return Math.round(gpus.reduce((sum, gpu) => sum + gpu.vram, 0) / 1024);
}

function totalVram(gpus: { vram: number }[]) {
  return gpus.reduce((sum, gpu) => sum + (gpu.vram || 0), 0);
}

function totalVramUsed(gpus: { vramUsed?: number }[]) {
  return gpus.reduce((sum, gpu) => sum + (gpu.vramUsed || 0), 0);
}

function formatGb(mib: number) {
  if (!Number.isFinite(mib) || mib <= 0) return "0";
  const gb = mib / 1024;
  return gb >= 10 ? gb.toFixed(0) : gb.toFixed(1);
}

function estimateThroughput(traffic: TrafficCapture[]) {
  const item = traffic.find((capture) => capture.status < 400 && capture.totalTokens && capture.durationMs > 0);
  if (!item?.totalTokens || !item.durationMs) return "";
  const value = item.totalTokens / (item.durationMs / 1000);
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function gpuIndex(data: IgniteData, gpuId: string) {
  const index = data.gpus.findIndex((gpu) => gpu.id === gpuId);
  return index >= 0 ? `GPU ${index}` : "GPU -";
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDownloads(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(value);
}

function referenceGGUF(files: HFModelFile[]) {
  const modelFiles = files.filter((file) => file.size > 0 && isModelWeightFile(file.name));
  if (!modelFiles.length) return undefined;
  return modelFiles.find((file) => file.quant.toUpperCase() === "Q4_K_M") ||
    [...modelFiles].sort((a, b) => a.size - b.size)[0];
}

function isModelWeightFile(name: string) {
  const normalized = name.toLowerCase();
  return !normalized.includes("mmproj") &&
    !normalized.includes("mtp") &&
    !normalized.includes("projector") &&
    !normalized.includes("vision");
}

function fitForGpu(fileSize: number, vramMiB: number) {
  const vramBytes = vramMiB * 1024 * 1024;
  if (!Number.isFinite(fileSize) || fileSize <= 0 || !Number.isFinite(vramBytes) || vramBytes <= 0) return "unknown";
  if (fileSize < vramBytes * 0.8) return "fits";
  if (fileSize < vramBytes * 0.95) return "tight";
  return "no";
}

function fitLabel(fit: string) {
  if (fit === "fits") return "fits";
  if (fit === "tight") return "tight";
  if (fit === "no") return "no";
  return "unknown";
}

function filterFittingModels(models: HFModelResult[], gpus: { vram: number }[]) {
  if (!gpus.length) return models;
  return models.filter((model) => {
    const reference = referenceGGUF(model.files);
    if (!reference) return false;
    return gpus.some((gpu) => fitForGpu(reference.size, gpu.vram) !== "no");
  });
}

function latestBackendJob(jobs: IgniteData["backendJobs"], backendId?: string) {
  if (!backendId) return undefined;
  return jobs.find((job) => job.backendId === backendId);
}

function shortGpuName(name: string) {
  return name.replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "").replace(/\s+/g, " ").trim();
}

function compactGpuName(name: string) {
  const short = shortGpuName(name);
  return short.match(/\b(?:RTX\s*)?([0-9]{4}(?:\s*Ti)?)\b/i)?.[1].replace(/\s+/g, " ") || short;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

function extractActivity(message: string) {
  const match = message.match(/model ([^ ]+)/);
  return match?.[1] || message.slice(0, 80);
}

function lines(value: string) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}
