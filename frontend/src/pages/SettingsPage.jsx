import React, { useState, useEffect } from 'react'

function SettingsPage() {
  const [settings, setSettings] = useState(null)
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [copiedField, setCopiedField] = useState('')

  useEffect(() => {
    fetchSettings()
  }, [])

  const fetchSettings = async () => {
    try {
      const response = await fetch('/api/settings')
      if (!response.ok) throw new Error('API error')
      const data = await response.json()
      setMeta(data._meta || null)
      delete data._meta
      setSettings(data)
    } catch (error) {
      setSettings(null)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (meta?.managed_runtime) {
      setMessage({ type: 'error', text: 'Docker mode uses container environment values for runtime paths and ports.' })
      return
    }
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
        <button onClick={handleSave} disabled={saving || meta?.managed_runtime} className="btn btn-primary">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      {meta?.managed_runtime && (
        <div className="card mb-6">
          <h3 className="text-lg font-semibold mb-2">Docker Mode</h3>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Runtime paths and ports come from Docker Compose and container environment values in this mode.
            Edit the repo config and compose files instead of changing these fields here.
          </p>
        </div>
      )}

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
{`SWAPDECK_MODELS_DIR=/home/your-user/models
SWAPDECK_CONFIG_DIR=/home/your-user/ignite-config`}
              </div>
            </div>
          </div>
        </div>
      )}

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
