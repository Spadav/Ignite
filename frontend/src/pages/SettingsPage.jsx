import React, { useEffect, useState } from 'react'

function Section({ title, description, children }) {
  return (
    <details className="card mb-6">
      <summary className="cursor-pointer list-none flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          {description && (
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              {description}
            </p>
          )}
        </div>
        <span className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>
          Expand
        </span>
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  )
}

function SettingsPage() {
  const [settings, setSettings] = useState(null)
  const [meta, setMeta] = useState(null)
  const [runtimeStatus, setRuntimeStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [copiedField, setCopiedField] = useState('')

  useEffect(() => {
    fetchSettings()
  }, [])

  const fetchSettings = async () => {
    try {
      const [settingsResponse, statusResponse] = await Promise.all([
        fetch('/api/settings'),
        fetch('/api/status')
      ])
      if (!settingsResponse.ok || !statusResponse.ok) throw new Error('API error')

      const data = await settingsResponse.json()
      const statusData = await statusResponse.json()
      setMeta(data._meta || null)
      setRuntimeStatus(statusData || null)
      delete data._meta
      setSettings(data)
    } catch {
      setSettings(null)
      setRuntimeStatus(null)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    try {
      setSaving(true)
      setMessage(null)
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.detail || 'Save failed')
      setMeta(data._meta || null)
      delete data._meta
      setSettings(data)
      await fetchSettings()
      setMessage({ type: 'success', text: 'Settings saved' })
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Failed to save settings' })
    } finally {
      setSaving(false)
    }
  }

  const handleChange = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  const copyText = async (label, value) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(label)
      setTimeout(() => setCopiedField(''), 1600)
    } catch {
      setMessage({ type: 'error', text: `Copy failed. Value: ${value}` })
    }
  }

  if (loading) return <p className="p-6">Loading...</p>
  if (!settings) return <p className="p-6 text-red-500">Failed to load settings</p>

  const inputClass = 'w-full px-3 py-2 rounded-lg border bg-transparent'
  const detectedGpus = Array.isArray(runtimeStatus?.gpu?.gpus) ? runtimeStatus.gpu.gpus : []
  const hasFallbackOnlyGpu = Boolean(runtimeStatus?.gpu?.available) && detectedGpus.length === 0
  const runtimeGpuWarning = runtimeStatus?.runtime_gpu_warning || null
  const speech = runtimeStatus?.speech || null
  const speechApiBaseUrl = `${window.location.protocol}//127.0.0.1:${runtimeStatus?.speaches_port || 8000}/v1`
  const apiBaseUrl = `${window.location.protocol}//127.0.0.1:${settings.llama_swap_port}/v1`
  const adminBaseUrl = `${window.location.protocol}//127.0.0.1:${settings.backend_port}/api`
  const healthUrl = `${window.location.protocol}//127.0.0.1:${settings.backend_port}/health`
  const configuredModelIds = Array.isArray(runtimeStatus?.configured_model_ids) ? runtimeStatus.configured_model_ids : []
  const defaultModelId = runtimeStatus?.default_model_id || configuredModelIds[0] || 'YourModel'
  const defaultModelMode = runtimeStatus?.default_model_mode || 'chat'
  const embeddingModelId = configuredModelIds.find((id) => /embed/i.test(id)) || 'YourEmbeddingModel'
  const speechRuntime = meta?.speech_runtime || null
  const speechAccelOptions = Array.isArray(meta?.speech_accel_options) ? meta.speech_accel_options : ['cpu', 'cuda']
  const runtimeRefs = meta?.runtime_refs || null

  const chatExample = defaultModelMode === 'completion'
    ? `curl ${apiBaseUrl}/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${defaultModelId}","prompt":"Write a short function that adds two numbers."}'`
    : `curl ${apiBaseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${defaultModelId}","messages":[{"role":"user","content":"hi"}]}'`
  const speechExample = `curl ${speechApiBaseUrl}/audio/speech \\
  -H "Content-Type: application/json" \\
  -d '{"model":"speaches-ai/Kokoro-82M-v1.0-ONNX","voice":"af_heart","input":"Hello from Ignite."}' \\
  --output speech.mp3`
  const transcriptionExample = `curl ${speechApiBaseUrl}/audio/transcriptions \\
  -F "model=Systran/faster-distil-whisper-small" \\
  -F "file=@sample.wav"`
  const embeddingsExample = `curl ${apiBaseUrl}/embeddings \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${embeddingModelId}","input":"Local AI is useful for private workflows."}'`
  const fields = [
    { key: 'gguf_directory', label: 'GGUF Model Directory', type: 'text', description: 'Where .gguf model files are stored' },
    { key: 'llama_swap_dir', label: 'llama-swap Directory', type: 'text', description: 'llama-swap installation directory' },
    { key: 'llama_swap_config', label: 'llama-swap Config File', type: 'text', description: 'Path to llama-swap config.yaml' },
    { key: 'llama_swap_port', label: 'llama-swap Port', type: 'number', description: 'Port llama-swap listens on' },
    { key: 'backend_port', label: 'Backend Port', type: 'number', description: 'Port this control panel runs on (requires restart)' },
  ]

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6 gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Runtime settings, Docker-managed paths, speech mode, and endpoint reference.
          </p>
        </div>
        <button onClick={handleSave} disabled={saving} className="btn btn-primary">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      {message && (
        <div className={`mb-4 px-4 py-2 rounded-lg text-sm border ${message.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`} style={{ borderColor: 'var(--line-soft)' }}>
          {message.text}
        </div>
      )}

      {meta?.managed_runtime && (
        <Section
          title="Docker Mode"
          description="Ignite is managing the runtime inside Docker. Most runtime values are read-only here and come from container startup configuration."
        >
          <div className="space-y-3 text-sm" style={{ color: 'var(--text-muted)' }}>
            <div>Current Docker restart policy: {meta?.docker_restart_policy || 'unknown'}</div>
            <div>Model folder: <span className="font-mono">{meta?.docker_paths?.models_dir || './models'}</span></div>
            <div>Config folder: <span className="font-mono">{meta?.docker_paths?.config_dir || './config'}</span></div>
          </div>
        </Section>
      )}

      <Section
        title="UI And Runtime Controls"
        description="Advanced UI toggles, boot behavior, and GPU detection summary."
      >
        <div className="space-y-4">
          <label className="flex items-start justify-between gap-4 rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
            <div>
              <div className="font-medium">Advanced GPU Mode</div>
              <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                Show per-model GPU assignment controls in Config.
              </p>
            </div>
            <input
              type="checkbox"
              checked={Boolean(settings.advanced_gpu_mode)}
              onChange={(e) => handleChange('advanced_gpu_mode', e.target.checked)}
            />
          </label>

          {meta?.managed_runtime && (
            <label className="flex items-start justify-between gap-4 rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
              <div>
                <div className="font-medium">Start Ignite Automatically After Reboot</div>
                <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                  Applies Docker restart policy to Ignite-managed containers.
                </p>
              </div>
              <input
                type="checkbox"
                checked={Boolean(settings.restart_on_boot)}
                onChange={(e) => handleChange('restart_on_boot', e.target.checked)}
              />
            </label>
          )}

          <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
            <div className="font-medium mb-1">Runtime GPU Detection</div>
            {detectedGpus.length > 0 ? (
              <div className="space-y-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                <p>Ignite can see these GPUs directly.</p>
                {detectedGpus.map((gpu) => (
                  <div key={gpu.uuid || gpu.index} className="rounded-lg border p-3 font-mono" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                    GPU {gpu.index}: {gpu.name} · {gpu.memory_total_gb} GiB · {gpu.uuid}
                  </div>
                ))}
              </div>
            ) : hasFallbackOnlyGpu ? (
              <div className="text-sm" style={{ color: '#fde68a' }}>
                {runtimeGpuWarning?.message || 'GPU exists, but direct GPU enumeration failed. Config will fall back to `Any Visible GPU`.'}
                {runtimeGpuWarning?.next_step && (
                  <div className="mt-2 text-xs">{runtimeGpuWarning.next_step}</div>
                )}
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                No directly detectable GPUs are available to Ignite right now.
              </p>
            )}
          </div>
        </div>
      </Section>

      {meta?.managed_runtime && (
        <Section
          title="llama.cpp Runtime"
          description="Choose which base llama.cpp image Ignite should build the runtime from. Saving rebuilds and recreates the runtime container."
        >
          <div className="space-y-4">
            <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
              <div className="text-sm font-medium">Current configured base image</div>
              <div className="mt-2 text-sm font-mono break-all" style={{ color: 'var(--text-muted)' }}>
                {runtimeRefs?.llama_cpp_image || settings.llama_cpp_image || 'ghcr.io/ggml-org/llama.cpp:server-cuda'}
              </div>
              <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                Use the upstream image by default, or point Ignite at your own prebuilt runtime image.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Base llama.cpp Image</label>
              <input
                type="text"
                value={settings.llama_cpp_image || ''}
                onChange={(e) => handleChange('llama_cpp_image', e.target.value)}
                className={inputClass}
                placeholder="ghcr.io/ggml-org/llama.cpp:server-cuda"
              />
              <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                Example: `ghcr.io/yourname/llama.cpp:server-cuda-custom`. Saving persists this in Ignite settings and rebuilds `llama-runtime`. The startup scripts reuse the same saved value automatically.
              </p>
            </div>
          </div>
        </Section>
      )}

      {meta?.managed_runtime && (
        <Section
          title="Speech Runtime"
          description="Choose whether Speaches should run on CPU or CUDA. Saving this setting recreates only the speech container."
        >
          <div className="space-y-4">
            <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
              <div className="text-sm font-medium">Current speech runtime</div>
              <div className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                Desired: <span className="font-mono">{settings.speaches_accel || 'cpu'}</span>
              </div>
              <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                Actual: <span className="font-mono">{speechRuntime?.accel || speech?.accel || 'unknown'}</span>
              </div>
              <div className="mt-1 text-sm font-mono break-all" style={{ color: 'var(--text-muted)' }}>
                {speechRuntime?.image || speech?.image || 'No speech image detected'}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Speech Acceleration</label>
              <select
                value={settings.speaches_accel || 'cpu'}
                onChange={(e) => handleChange('speaches_accel', e.target.value)}
                className={inputClass}
              >
                {speechAccelOptions.map((option) => (
                  <option key={option} value={option}>{option.toUpperCase()}</option>
                ))}
              </select>
              <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                CPU is the safest default. CUDA is faster, but requires working NVIDIA Docker support.
              </p>
            </div>
          </div>
        </Section>
      )}

      {meta?.managed_runtime && (
        <Section
          title="Docker Paths"
          description="Mounted host folders and example environment values used by the startup scripts."
        >
          <div className="space-y-3">
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Model Folder</div>
                  <div className="font-mono text-sm mt-1">{meta?.docker_paths?.models_dir || './models'}</div>
                </div>
                <button onClick={() => copyText('models-dir', meta?.docker_paths?.models_dir || './models')} className="btn btn-secondary text-sm">
                  {copiedField === 'models-dir' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Config Folder</div>
                  <div className="font-mono text-sm mt-1">{meta?.docker_paths?.config_dir || './config'}</div>
                </div>
                <button onClick={() => copyText('config-dir', meta?.docker_paths?.config_dir || './config')} className="btn btn-secondary text-sm">
                  {copiedField === 'config-dir' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Example `.env`</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
{`IGNITE_MODELS_DIR=/home/your-user/models
IGNITE_CONFIG_DIR=/home/your-user/ignite-config
IGNITE_PORT=3000
LLAMA_SWAP_PORT=8090
LLAMA_CPP_IMAGE=ghcr.io/ggml-org/llama.cpp:server-cuda
SPEACHES_ACCEL=cuda`}
              </div>
            </div>
          </div>
        </Section>
      )}

      {meta?.managed_runtime && (
        <Section
          title="Runtime Updates"
          description="Refresh llama.cpp and other floating runtime images from the terminal."
        >
          <div className="rounded-lg border p-3 font-mono text-sm" style={{ borderColor: 'var(--line-soft)' }}>
            ./scripts/update.sh
          </div>
        </Section>
      )}

      {meta?.managed_runtime && (
        <Section
          title="Runtime API"
          description="OpenAI-compatible runtime endpoints for apps, curl, and local integrations."
        >
          <div className="space-y-3">
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
              <div className="text-sm font-medium">Base URL</div>
              <div className="font-mono text-sm mt-1">{apiBaseUrl}</div>
            </div>
            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Examples</div>
              <div className="space-y-3 font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                <div>{chatExample}</div>
                <div>{embeddingsExample}</div>
              </div>
            </div>
          </div>
        </Section>
      )}

      {meta?.managed_runtime && (
        <Section
          title="Speech API"
          description="Optional speech endpoints exposed by Speaches for TTS and STT."
        >
          <div className="space-y-3">
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
              <div className="text-sm font-medium">Speech Base URL</div>
              <div className="font-mono text-sm mt-1">{speechApiBaseUrl}</div>
            </div>
            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Speech service status</div>
              <div style={{ color: 'var(--text-muted)' }}>
                {speech?.reachable ? `Reachable. Installed speech models: ${speech?.details?.model_count ?? 0}` : (speech?.error || 'Speech service is not reachable right now.')}
              </div>
            </div>
            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Examples</div>
              <div className="space-y-3 font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                <div>{speechExample}</div>
                <div>{transcriptionExample}</div>
              </div>
            </div>
          </div>
        </Section>
      )}

      <Section
        title="Ignite Admin API"
        description="Operational endpoints for status, config, updates, logs, and the LLM test route."
      >
        <div className="space-y-3">
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
            <div className="text-sm font-medium">Admin Base URL</div>
            <div className="font-mono text-sm mt-1">{adminBaseUrl}</div>
          </div>
          <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
            <div className="font-medium mb-2">Useful endpoints</div>
            <div className="space-y-2 font-mono" style={{ color: 'var(--text-muted)' }}>
              <div>GET {adminBaseUrl}/status</div>
              <div>GET {adminBaseUrl}/settings</div>
              <div>GET {adminBaseUrl}/config</div>
              <div>GET {adminBaseUrl}/updates?refresh=true</div>
              <div>GET {adminBaseUrl}/runtime/models</div>
              <div>POST {adminBaseUrl}/service/start</div>
              <div>POST {adminBaseUrl}/service/stop</div>
              <div>POST {adminBaseUrl}/test</div>
              <div>GET {healthUrl}</div>
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Runtime Paths And Ports"
        description="Underlying runtime file and port settings. Managed Docker values stay read-only here."
      >
        <div className="space-y-5">
          {fields.map(({ key, label, type, description }) => (
            <div key={key}>
              <label className="block text-sm font-medium mb-1">{label}</label>
              {meta?.managed_runtime ? (
                <div className="w-full px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)', color: 'var(--text-muted)' }}>
                  <div className="flex items-center justify-between gap-3">
                    <span className={type === 'number' ? '' : 'font-mono text-sm'}>{settings[key] ?? ''}</span>
                    <span className="text-xs px-2 py-1 rounded-full" style={{ background: 'rgba(148, 163, 184, 0.14)', color: 'var(--text-muted)' }}>
                      Managed by Docker
                    </span>
                  </div>
                </div>
              ) : (
                <input
                  type={type}
                  value={settings[key] ?? ''}
                  onChange={(e) => handleChange(key, type === 'number' ? parseInt(e.target.value, 10) || 0 : e.target.value)}
                  className={inputClass}
                />
              )}
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{description}</p>
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}

export default SettingsPage
