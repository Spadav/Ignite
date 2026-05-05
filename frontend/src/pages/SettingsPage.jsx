import React, { useState, useEffect } from 'react'

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
    } catch (error) {
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
      if (!response.ok) throw new Error('Save failed')
      const data = await response.json()
      setMeta(data._meta || null)
      delete data._meta
      setSettings(data)
      setMessage({ type: 'success', text: 'Settings saved' })
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to save settings' })
    } finally {
      setSaving(false)
    }
  }

  const handleChange = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }))
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

  const inputClass = "w-full px-3 py-2 rounded-lg border bg-transparent"
  const detectedGpus = Array.isArray(runtimeStatus?.gpu?.gpus) ? runtimeStatus.gpu.gpus : []
  const hasFallbackOnlyGpu = Boolean(runtimeStatus?.gpu?.available) && detectedGpus.length === 0
  const apiBaseUrl = `${window.location.protocol}//127.0.0.1:${settings.llama_swap_port}/v1`
  const modelsUrl = `${apiBaseUrl}/models`
  const adminBaseUrl = `${window.location.protocol}//127.0.0.1:${settings.backend_port}/api`
  const healthUrl = `${window.location.protocol}//127.0.0.1:${settings.backend_port}/health`
  const configuredModelIds = Array.isArray(runtimeStatus?.configured_model_ids) ? runtimeStatus.configured_model_ids : []
  const defaultModelId = runtimeStatus?.default_model_id || configuredModelIds[0] || 'YourModel'
  const defaultModelMode = runtimeStatus?.default_model_mode || 'chat'
  const embeddingModelId = configuredModelIds.find((id) => /embed/i.test(id)) || 'YourEmbeddingModel'
  const chatExample = defaultModelMode === 'completion'
    ? `curl ${apiBaseUrl}/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${defaultModelId}","prompt":"Write a short function that adds two numbers."}'`
    : `curl ${apiBaseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${defaultModelId}","messages":[{"role":"user","content":"hi"}]}'`
  const visionExample = `curl ${apiBaseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${defaultModelId}","messages":[{"role":"user","content":[{"type":"text","text":"Describe this image."},{"type":"image_url","image_url":{"url":"https://example.com/image.jpg"}}]}]}'`
  const completionExample = `curl ${apiBaseUrl}/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"YourCompletionModel","prompt":"Complete this code:\\nfunction add(a, b) {"}'`
  const embeddingsExample = `curl ${apiBaseUrl}/embeddings \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${embeddingModelId}","input":"Local AI is useful for private workflows."}'`
  const statusExample = `curl ${adminBaseUrl}/status`
  const settingsExample = `curl ${adminBaseUrl}/settings`
  const configExample = `curl ${adminBaseUrl}/config`
  const updatesExample = `curl ${adminBaseUrl}/updates?refresh=true`
  const runtimeModelsExample = `curl ${adminBaseUrl}/runtime/models`
  const startRuntimeExample = `curl -X POST ${adminBaseUrl}/service/start`
  const stopRuntimeExample = `curl -X POST ${adminBaseUrl}/service/stop`
  const testExample = `curl -X POST ${adminBaseUrl}/test \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${defaultModelId}","prompt":"Reply with exactly: ok"}'`
  const dockerLogsExample = `curl ${adminBaseUrl}/logs/docker/runtime`
  const healthExample = `curl ${healthUrl}`

  const fields = [
    { key: 'gguf_directory', label: 'GGUF Model Directory', type: 'text', description: 'Where .gguf model files are stored' },
    { key: 'llama_swap_dir', label: 'llama-swap Directory', type: 'text', description: 'llama-swap installation directory' },
    { key: 'llama_swap_config', label: 'llama-swap Config File', type: 'text', description: 'Path to llama-swap config.yaml' },
    { key: 'llama_swap_port', label: 'llama-swap Port', type: 'number', description: 'Port llama-swap listens on' },
    { key: 'backend_port', label: 'Backend Port', type: 'number', description: 'Port this control panel runs on (requires restart)' },
  ]

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <button onClick={handleSave} disabled={saving} className="btn btn-primary">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      {meta?.managed_runtime && (
        <div className="card mb-6">
          <h3 className="text-lg font-semibold mb-2">Docker Mode</h3>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Runtime paths and ports come from Docker Compose and container environment values in this mode.
            Those fields stay read-only here, but UI-only settings can still be saved below.
          </p>
        </div>
      )}

      <div className="card mb-6">
        <h3 className="text-lg font-semibold mb-3">Advanced UI</h3>
        <label className="flex items-start justify-between gap-4 rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
          <div>
            <div className="font-medium">Advanced GPU Mode</div>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              Show per-model GPU assignment controls in Config. This is for machines with multiple GPUs or manual llama.cpp GPU pinning needs.
            </p>
          </div>
          <input
            type="checkbox"
            checked={Boolean(settings.advanced_gpu_mode)}
            onChange={(e) => handleChange('advanced_gpu_mode', e.target.checked)}
          />
        </label>

        {meta?.managed_runtime && (
          <label className="mt-4 flex items-start justify-between gap-4 rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
            <div>
              <div className="font-medium">Start Ignite Automatically After Reboot</div>
              <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                Applies Docker restart policy to the Ignite containers. When enabled, Docker will bring Ignite back automatically unless you explicitly stop it.
              </p>
              {meta?.docker_restart_policy && (
                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                  Current Docker restart policy: {meta.docker_restart_policy}
                </p>
              )}
            </div>
            <input
              type="checkbox"
              checked={Boolean(settings.restart_on_boot)}
              onChange={(e) => handleChange('restart_on_boot', e.target.checked)}
            />
          </label>
        )}

        <div className="mt-4 rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
          <div className="font-medium mb-1">Runtime GPU Detection</div>
          {detectedGpus.length > 0 ? (
            <div className="space-y-2 text-sm" style={{ color: 'var(--text-muted)' }}>
              <p>Ignite can see these GPUs directly, so Advanced GPU Mode can pin models to a specific device.</p>
              {detectedGpus.map((gpu) => (
                <div key={gpu.uuid || gpu.index} className="rounded-lg border p-3 font-mono" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                  GPU {gpu.index}: {gpu.name} · {gpu.memory_total_gb} GiB · {gpu.uuid}
                </div>
              ))}
            </div>
          ) : hasFallbackOnlyGpu ? (
            <div className="text-sm">
              <p style={{ color: '#fde68a' }}>
                Ignite can tell that a GPU exists, but direct GPU enumeration failed. Config will fall back to `Any Visible GPU` until the stack is recreated cleanly.
              </p>
              <p className="mt-2" style={{ color: 'var(--text-muted)' }}>
                This usually means `nvidia-smi` failed inside the Ignite container after a reboot or Docker restart.
              </p>
            </div>
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              No directly detectable GPUs are available to Ignite right now.
            </p>
          )}
        </div>
      </div>

      {meta?.managed_runtime && (
        <div className="card mb-6">
          <h3 className="text-lg font-semibold mb-3">Docker Paths</h3>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
            These are the host folders currently mounted into Ignite. To change them, set the variables below in a repo-root `.env` file or export them before running `./scripts/start.sh`, then restart the stack.
          </p>

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
LLAMA_SWAP_PORT=8090`}
              </div>
            </div>
          </div>
        </div>
      )}

      {meta?.managed_runtime && (
        <div className="card mb-6">
          <h3 className="text-lg font-semibold mb-2">Runtime Updates</h3>
          <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>
            To update llama.cpp and the runtime images, run the repo update script from your terminal. It pulls the latest repo changes, refreshes runtime images, and rebuilds the stack.
          </p>
          <div className="rounded-lg border p-3 font-mono text-sm" style={{ borderColor: 'var(--line-soft)' }}>
            ./scripts/update.sh
          </div>
        </div>
      )}

      {meta?.managed_runtime && (
        <div className="card mb-6">
          <h3 className="text-lg font-semibold mb-3">Endpoint Reference</h3>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
            Use the local OpenAI-compatible endpoint below for curl, scripts, and external apps running on this machine.
          </p>

          <div className="space-y-3">
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Base URL</div>
                  <div className="font-mono text-sm mt-1">{apiBaseUrl}</div>
                </div>
                <button onClick={() => copyText('settings-base-url', apiBaseUrl)} className="btn btn-secondary text-sm">
                  {copiedField === 'settings-base-url' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Available endpoints</div>
              <div className="space-y-2 font-mono" style={{ color: 'var(--text-muted)' }}>
                <div>GET {modelsUrl}</div>
                <div>POST {apiBaseUrl}/chat/completions</div>
                <div>POST {apiBaseUrl}/completions</div>
                <div>POST {apiBaseUrl}/embeddings</div>
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Curl: List Models</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                {`curl ${modelsUrl}`}
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Curl: Chat</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                {chatExample}
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Curl: Vision Chat</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                {visionExample}
              </div>
              <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                Use this only with a vision-capable chat model.
              </p>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Curl: Completion</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                {completionExample}
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Curl: Embeddings</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                {embeddingsExample}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card mb-6">
        <h3 className="text-lg font-semibold mb-3">Ignite Admin API</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
          These endpoints manage Ignite itself: runtime status, config, logs, updates, and test requests. Use them for automation or debugging, not for normal app chat traffic.
        </p>

        <div className="space-y-3">
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Admin Base URL</div>
                <div className="font-mono text-sm mt-1">{adminBaseUrl}</div>
              </div>
              <button onClick={() => copyText('settings-admin-base-url', adminBaseUrl)} className="btn btn-secondary text-sm">
                {copiedField === 'settings-admin-base-url' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
            <div className="font-medium mb-2">Available endpoints</div>
            <div className="space-y-2 font-mono" style={{ color: 'var(--text-muted)' }}>
              <div>GET {adminBaseUrl}/status</div>
              <div>GET {adminBaseUrl}/settings</div>
              <div>PUT {adminBaseUrl}/settings</div>
              <div>GET {adminBaseUrl}/config</div>
              <div>PUT {adminBaseUrl}/config</div>
              <div>GET {adminBaseUrl}/config/raw</div>
              <div>PUT {adminBaseUrl}/config/raw</div>
              <div>GET {adminBaseUrl}/config/guide</div>
              <div>GET {adminBaseUrl}/updates?refresh=true</div>
              <div>GET {adminBaseUrl}/runtime/models</div>
              <div>GET {adminBaseUrl}/runtime/overview</div>
              <div>POST {adminBaseUrl}/runtime/models/load/{'{model_id}'}</div>
              <div>POST {adminBaseUrl}/runtime/models/unload/{'{model_id}'}</div>
              <div>POST {adminBaseUrl}/runtime/models/unload</div>
              <div>POST {adminBaseUrl}/service/start</div>
              <div>POST {adminBaseUrl}/service/stop</div>
              <div>GET {adminBaseUrl}/logs</div>
              <div>GET {adminBaseUrl}/logs/upstream</div>
              <div>GET {adminBaseUrl}/logs/docker/{'{stream_name}'}</div>
              <div>GET {adminBaseUrl}/logs/events</div>
              <div>POST {adminBaseUrl}/test</div>
              <div>GET {healthUrl}</div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Core state</div>
              <div className="space-y-2" style={{ color: 'var(--text-muted)' }}>
                <div><span className="font-mono">GET /api/status</span> returns runtime, GPU, and configured model state.</div>
                <div><span className="font-mono">GET /api/settings</span> returns current Ignite settings.</div>
                <div><span className="font-mono">GET /api/config</span> returns the parsed llama-swap config.</div>
                <div><span className="font-mono">GET /api/config/raw</span> returns the raw YAML config text.</div>
                <div><span className="font-mono">GET /api/updates</span> checks runtime versions and upstream availability.</div>
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Runtime control</div>
              <div className="space-y-2" style={{ color: 'var(--text-muted)' }}>
                <div><span className="font-mono">GET /api/runtime/models</span> lists models seen by the running runtime.</div>
                <div><span className="font-mono">POST /api/service/start</span> starts the managed runtime.</div>
                <div><span className="font-mono">POST /api/service/stop</span> stops the managed runtime.</div>
                <div><span className="font-mono">GET /api/logs/docker/runtime</span> reads Docker runtime logs.</div>
                <div><span className="font-mono">POST /api/test</span> sends a test request through Ignite.</div>
              </div>
            </div>
          </div>

          <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
            <div className="font-medium mb-2">Curl: Status</div>
            <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
              {statusExample}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Curl: Settings</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                {settingsExample}
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Curl: Config</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                {configExample}
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Curl: Updates</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                {updatesExample}
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Curl: Runtime Models</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                {runtimeModelsExample}
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Curl: Start Runtime</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                {startRuntimeExample}
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Curl: Stop Runtime</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                {stopRuntimeExample}
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Curl: Test Request</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                {testExample}
              </div>
            </div>

            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium mb-2">Curl: Runtime Logs</div>
              <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
                {dockerLogsExample}
              </div>
            </div>
          </div>

          <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
            <div className="font-medium mb-2">Curl: Health</div>
            <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
              {healthExample}
            </div>
          </div>
        </div>
      </div>

      {message && (
        <div className={`mb-4 px-4 py-2 rounded-lg text-sm border ${
          message.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
        }`} style={{ borderColor: 'var(--line-soft)' }}>
          {message.text}
        </div>
      )}

      <div className="card">
        <div className="space-y-5">
          {fields.map(({ key, label, type, description }) => (
            <div key={key}>
              <label className="block text-sm font-medium mb-1">{label}</label>
              {meta?.managed_runtime ? (
                <div
                  className="w-full px-3 py-2 rounded-lg border"
                  style={{
                    borderColor: 'var(--line-soft)',
                    background: 'rgba(148, 163, 184, 0.08)',
                    color: 'var(--text-muted)'
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className={type === 'number' ? '' : 'font-mono text-sm'}>
                      {settings[key] ?? ''}
                    </span>
                    <span
                      className="text-xs px-2 py-1 rounded-full"
                      style={{
                        background: 'rgba(148, 163, 184, 0.14)',
                        color: 'var(--text-muted)'
                      }}
                    >
                      Managed by Docker
                    </span>
                  </div>
                </div>
              ) : (
                <input
                  type={type}
                  value={settings[key] ?? ''}
                  onChange={(e) => handleChange(key, type === 'number' ? parseInt(e.target.value) || 0 : e.target.value)}
                  className={inputClass}
                />
              )}
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default SettingsPage
