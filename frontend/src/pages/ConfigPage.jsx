import React, { useEffect, useState } from 'react'

const CONFIG_GUIDE_SECTIONS = [
  {
    title: 'Core Structure',
    items: [
      { key: 'models', note: 'Main dictionary of available models. Every model ID you want to use must live here.' },
      { key: 'healthCheck.model', note: 'Model llama-swap uses for its own readiness checks.' },
      { key: 'globalTTL', note: 'Default unload timer in seconds. Use `0` to keep models loaded.' },
      { key: 'startPort', note: 'Starting value for `${PORT}` auto-assignment when your model commands use that macro.' }
    ]
  },
  {
    title: 'Top-Level Behavior',
    items: [
      { key: 'healthCheckTimeout', note: 'How long llama-swap waits for a model server to become ready.' },
      { key: 'logLevel', note: 'Proxy log verbosity. Usually `info`, `warn`, or `debug` while troubleshooting.' },
      { key: 'logToStdout', note: 'Choose whether stdout shows proxy logs, upstream logs, both, or none.' },
      { key: 'sendLoadingState', note: 'Inject loading progress into reasoning/thinking streams for compatible UIs.' },
      { key: 'includeAliasesInList', note: 'Show aliases as separate entries in `/v1/models`.' },
      { key: 'captureBuffer', note: 'How much memory is reserved for request/response capture.' }
    ]
  },
  {
    title: 'Model Fields',
    items: [
      { key: 'cmd', note: 'The command that starts the inference server for that model.' },
      { key: 'proxy', note: 'Where llama-swap sends requests after the model is running.' },
      { key: 'name', note: 'Display name shown in `/v1/models` and UIs.' },
      { key: 'description', note: 'Optional human-readable explanation of the model.' },
      { key: 'checkEndpoint', note: 'Readiness path checked before traffic is sent. Use `none` to skip.' },
      { key: 'useModelName', note: 'Override the model name sent upstream if the backend expects a different one.' },
      { key: 'ttl', note: 'Per-model unload timer. Overrides `globalTTL`.' },
      { key: 'env', note: 'Extra environment variables passed to the model process.' },
      { key: 'aliases', note: 'Alternative model IDs that reuse the same model definition.' },
      { key: 'metadata', note: 'Extra data returned in `/v1/models` for this model.' }
    ]
  },
  {
    title: 'Filters And Request Shaping',
    items: [
      { key: 'filters.stripParams', note: 'Remove request parameters before they hit the upstream model server.' },
      { key: 'filters.setParams', note: 'Force or default certain request parameters server-side.' },
      { key: 'filters.setParamsByID', note: 'Apply different request params per alias or model variant without reloading the model.' }
    ]
  },
  {
    title: 'Reuse And Automation',
    items: [
      { key: 'macros', note: 'Reusable substitutions for paths, flags, defaults, and environment-driven values.' },
      { key: 'hooks.on_startup.preload', note: 'Models to preload when llama-swap starts.' },
      { key: 'groups', note: 'Control swap behavior, exclusivity, and persistent loaded groups.' },
      { key: 'peers', note: 'Remote providers or other llama-swap instances exposed through the same API surface.' },
      { key: 'apiKeys', note: 'Optional API keys required by llama-swap before serving requests.' }
    ]
  }
]

function ConfigPage() {
  const [config, setConfig] = useState(null)
  const [rawConfig, setRawConfig] = useState('')
  const [guideOpen, setGuideOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [expandedModels, setExpandedModels] = useState({})
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [message, setMessage] = useState(null)
  const [editorMode, setEditorMode] = useState('structured')

  useEffect(() => {
    fetchConfig()
  }, [])

  const fetchConfig = async () => {
    try {
      const [configResponse, rawResponse] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/config/raw')
      ])

      if (!configResponse.ok || !rawResponse.ok) throw new Error('API error')

      const configData = await configResponse.json()
      const rawData = await rawResponse.json()

      setConfig(configData)
      setRawConfig(rawData.content || '')
      setMessage(null)
    } catch (error) {
      setConfig(null)
    } finally {
      setLoading(false)
    }
  }

  const saveStructuredConfig = async (nextConfig, successText = 'Config saved') => {
    setSaving(true)
    setMessage(null)

    const response = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextConfig)
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => null)
      throw new Error(errorData?.detail || 'Save failed')
    }

    setConfig(nextConfig)
    await fetchConfig()
    setMessage({ type: 'success', text: successText })
  }

  const handleSave = async () => {
    try {
      if (editorMode === 'raw') {
        setSaving(true)
        setMessage(null)

        const response = await fetch('/api/config/raw', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: rawConfig })
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => null)
          throw new Error(errorData?.detail || 'Save failed')
        }

        await fetchConfig()
        setMessage({ type: 'success', text: 'Raw YAML saved' })
      } else {
        await saveStructuredConfig(config, 'Config saved')
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Failed to save config' })
    } finally {
      setSaving(false)
    }
  }

  const openGuide = async () => {
    setGuideOpen(true)
  }

  const toggleModel = (key) => {
    setExpandedModels(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleModelChange = (modelKey, field, value) => {
    setConfig(prev => ({
      ...prev,
      models: {
        ...prev.models,
        [modelKey]: {
          ...prev.models[modelKey],
          [field]: value
        }
      }
    }))
  }

  const handleFilterChange = (modelKey, value) => {
    setConfig(prev => ({
      ...prev,
      models: {
        ...prev.models,
        [modelKey]: {
          ...prev.models[modelKey],
          filters: {
            ...(prev.models[modelKey].filters || {}),
            stripParams: value
          }
        }
      }
    }))
  }

  const removeFilters = (modelKey) => {
    setConfig(prev => {
      const model = { ...prev.models[modelKey] }
      delete model.filters
      return { ...prev, models: { ...prev.models, [modelKey]: model } }
    })
  }

  const handleAliasesChange = (modelKey, value) => {
    const aliases = value.split(',').map(a => a.trim()).filter(Boolean)
    handleModelChange(modelKey, 'aliases', aliases.length > 0 ? aliases : undefined)
  }

  const removeAliases = (modelKey) => {
    setConfig(prev => {
      const model = { ...prev.models[modelKey] }
      delete model.aliases
      return { ...prev, models: { ...prev.models, [modelKey]: model } }
    })
  }

  const deleteModel = async (modelKey) => {
    try {
      const models = { ...config.models }
      delete models[modelKey]
      const nextConfig = { ...config, models }
      if (nextConfig.healthCheck?.model === modelKey) {
        nextConfig.healthCheck = { ...nextConfig.healthCheck, model: '' }
      }
      await saveStructuredConfig(nextConfig, `Removed ${modelKey} from config`)
      setDeleteConfirm(null)
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Failed to delete model from config' })
    } finally {
      setSaving(false)
    }
  }

  const addModel = () => {
    const key = `NewModel_${Date.now()}`
    setConfig(prev => ({
      ...prev,
      models: {
        ...prev.models,
        [key]: {
          name: 'New Model',
          cmd: '/path/to/llama-server\n-m /path/to/model.gguf\n-ngl 99\n--host 127.0.0.1\n--port ${PORT}\n',
          proxy: 'http://127.0.0.1:${PORT}'
        }
      }
    }))
    setExpandedModels(prev => ({ ...prev, [key]: true }))
  }

  const renameModelKey = (oldKey, newKey) => {
    if (newKey === oldKey || !newKey.trim()) return
    if (config.models[newKey]) {
      alert(`Model key "${newKey}" already exists`)
      return
    }
    setConfig(prev => {
      const entries = Object.entries(prev.models)
      const newModels = {}
      for (const [k, v] of entries) {
        newModels[k === oldKey ? newKey : k] = v
      }
      const newConfig = { ...prev, models: newModels }
      if (prev.healthCheck?.model === oldKey) {
        newConfig.healthCheck = { ...prev.healthCheck, model: newKey }
      }
      return newConfig
    })
    setExpandedModels(prev => {
      const next = { ...prev }
      next[newKey] = next[oldKey]
      delete next[oldKey]
      return next
    })
  }

  if (loading) return <p className="p-6">Loading...</p>
  if (!config) return <p className="p-6 text-red-500">Config file not found</p>

  const inputClass = 'w-full px-3 py-2 rounded-lg border bg-transparent'

  return (
    <div className="p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Configuration</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Structured mode covers common fields. Raw YAML mode supports the full llama-swap schema.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={openGuide} className="btn text-sm">
            Config Guide
          </button>
          <div className="inline-flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--line-soft)' }}>
            <button
              onClick={() => setEditorMode('structured')}
              className="px-3 py-2 text-sm"
              style={{
                background: editorMode === 'structured' ? 'var(--line-soft)' : 'transparent'
              }}
            >
              Structured
            </button>
            <button
              onClick={() => setEditorMode('raw')}
              className="px-3 py-2 text-sm"
              style={{
                background: editorMode === 'raw' ? 'var(--line-soft)' : 'transparent'
              }}
            >
              Raw YAML
            </button>
          </div>
          <button onClick={handleSave} disabled={saving} className="btn btn-primary">
            {saving ? 'Saving...' : editorMode === 'raw' ? 'Save YAML' : 'Save Changes'}
          </button>
        </div>
      </div>

      {message && (
        <div
          className={`mb-4 px-4 py-2 rounded-lg text-sm border ${
            message.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
          }`}
          style={{ borderColor: 'var(--line-soft)' }}
        >
          {message.text}
        </div>
      )}

      {guideOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(8, 10, 14, 0.7)' }}
          onClick={() => setGuideOpen(false)}
        >
          <div
            className="card w-full max-w-5xl max-h-[85vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h3 className="text-xl font-semibold">Config Guide</h3>
                <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                  Glossary for the main llama-swap settings. Use Raw YAML for advanced editing and this popup to understand what each section is for.
                </p>
              </div>
              <button
                onClick={() => setGuideOpen(false)}
                className="px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--line-soft)' }}
              >
                Close
              </button>
            </div>
            <div className="overflow-auto max-h-[68vh] rounded-lg border p-4 space-y-5" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="rounded-lg p-4" style={{ background: 'var(--line-soft)' }}>
                <p className="text-sm">
                  Start with Structured mode if you only need to edit model names, commands, proxy URLs, aliases, or simple strip filters.
                  Use Raw YAML when you need advanced fields like macros, hooks, peers, groups, `setParams`, `setParamsByID`, or API keys.
                </p>
              </div>

              {CONFIG_GUIDE_SECTIONS.map((section) => (
                <div key={section.title}>
                  <h4 className="text-base font-semibold mb-3">{section.title}</h4>
                  <div className="space-y-3">
                    {section.items.map((item) => (
                      <div key={item.key} className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)' }}>
                        <div className="font-mono text-sm mb-1">{item.key}</div>
                        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{item.note}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                <h4 className="text-base font-semibold mb-2">Quick Example</h4>
                <pre className="text-sm whitespace-pre-wrap break-words font-mono" style={{ color: 'var(--text-muted)' }}>
{`models:
  MyModel:
    cmd: /path/to/llama-server -m /path/to/model.gguf --port \${PORT}
    proxy: http://127.0.0.1:\${PORT}
    name: My Model
    aliases:
      - my-model-fast
    filters:
      stripParams: "temperature, top_p"`}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {editorMode === 'raw' ? (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Raw YAML</h3>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Full llama-swap config support
            </span>
          </div>
          <textarea
            value={rawConfig}
            onChange={(e) => setRawConfig(e.target.value)}
            rows={32}
            spellCheck={false}
            className={`${inputClass} font-mono text-sm`}
          />
        </div>
      ) : (
        <>
          <div className="card">
            <h3 className="text-lg font-semibold mb-4">Global Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Global TTL (seconds)</label>
                <input
                  type="number"
                  value={config.globalTTL ?? config.ttl ?? 0}
                  onChange={(e) => setConfig(prev => ({
                    ...prev,
                    globalTTL: parseInt(e.target.value, 10) || 0
                  }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Health Check Model</label>
                <select
                  value={config.healthCheck?.model || ''}
                  onChange={(e) => setConfig(prev => ({
                    ...prev,
                    healthCheck: { ...prev.healthCheck, model: e.target.value }
                  }))}
                  className={inputClass}
                >
                  <option value="">— none —</option>
                  {Object.keys(config.models || {}).map(key => (
                    <option key={key} value={key}>{key}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="mt-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Models ({Object.keys(config.models || {}).length})</h3>
              <button onClick={addModel} className="btn btn-primary text-sm">+ Add Model</button>
            </div>

            <div className="space-y-3">
              {Object.entries(config.models || {}).map(([key, model]) => {
                const stripParamsValue = model.filters?.stripParams ?? model.filters?.strip_params ?? ''

                return (
                  <div key={key} className="card">
                    <button
                      onClick={() => toggleModel(key)}
                      className="w-full flex items-center justify-between text-left"
                    >
                      <div>
                        <span className="font-semibold text-lg">{key}</span>
                        <span className="ml-3 text-sm" style={{ color: 'var(--text-muted)' }}>
                          {model.name}
                        </span>
                      </div>
                      <span className="text-xl" style={{ color: 'var(--text-muted)' }}>
                        {expandedModels[key] ? '▼' : '▶'}
                      </span>
                    </button>

                    {expandedModels[key] && (
                      <div className="mt-4 space-y-4 border-t pt-4" style={{ borderColor: 'var(--line-soft)' }}>
                        <div>
                          <label className="block text-sm font-medium mb-1">Model Key</label>
                          <input
                            type="text"
                            defaultValue={key}
                            onBlur={(e) => renameModelKey(key, e.target.value.trim())}
                            className={inputClass}
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium mb-1">Name</label>
                          <input
                            type="text"
                            value={model.name || ''}
                            onChange={(e) => handleModelChange(key, 'name', e.target.value)}
                            className={inputClass}
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium mb-1">Command</label>
                          <textarea
                            value={model.cmd || ''}
                            onChange={(e) => handleModelChange(key, 'cmd', e.target.value)}
                            rows={8}
                            className={`${inputClass} font-mono text-sm`}
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium mb-1">Proxy</label>
                          <input
                            type="text"
                            value={model.proxy || ''}
                            onChange={(e) => handleModelChange(key, 'proxy', e.target.value)}
                            className={`${inputClass} font-mono text-sm`}
                          />
                        </div>

                        {model.filters ? (
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <label className="block text-sm font-medium">Filters (stripParams)</label>
                              <button
                                onClick={() => removeFilters(key)}
                                className="text-xs text-red-500 hover:text-red-700"
                              >
                                Remove filters
                              </button>
                            </div>
                            <input
                              type="text"
                              value={stripParamsValue}
                              onChange={(e) => handleFilterChange(key, e.target.value)}
                              placeholder="temperature, top_k, top_p"
                              className={`${inputClass} text-sm`}
                            />
                          </div>
                        ) : (
                          <button
                            onClick={() => handleFilterChange(key, '')}
                            className="text-sm text-blue-500 hover:text-blue-700"
                          >
                            + Add filters
                          </button>
                        )}

                        {model.aliases ? (
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <label className="block text-sm font-medium">Aliases (comma-separated)</label>
                              <button
                                onClick={() => removeAliases(key)}
                                className="text-xs text-red-500 hover:text-red-700"
                              >
                                Remove aliases
                              </button>
                            </div>
                            <input
                              type="text"
                              value={(model.aliases || []).join(', ')}
                              onChange={(e) => handleAliasesChange(key, e.target.value)}
                              placeholder="alias-1, alias-2"
                              className={`${inputClass} text-sm`}
                            />
                          </div>
                        ) : (
                          <button
                            onClick={() => handleModelChange(key, 'aliases', [''])}
                            className="text-sm text-blue-500 hover:text-blue-700"
                          >
                            + Add aliases
                          </button>
                        )}

                        <div className="pt-2 border-t" style={{ borderColor: 'var(--line-soft)' }}>
                          {deleteConfirm === key ? (
                            <div className="flex items-center gap-3">
                              <span className="text-sm text-red-500">Delete this model?</span>
                              <button
                                onClick={() => deleteModel(key)}
                                className="text-sm px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setDeleteConfirm(null)}
                                className="text-sm px-3 py-1 rounded"
                                style={{ background: 'var(--line-soft)' }}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setDeleteConfirm(key)}
                              className="text-sm text-red-500 hover:text-red-700"
                            >
                              Delete model
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default ConfigPage
