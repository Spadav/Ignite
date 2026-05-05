import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const DISCOVER_MODES = [
  { key: 'llm', label: 'LLM' },
  { key: 'speech', label: 'Speech' },
]

const USE_CASES = [
  { key: 'chat', label: 'Chat' },
  { key: 'coding', label: 'Coding' },
]

function formatScore(value) {
  if (value === null || value === undefined) return '-'
  return Number(value).toFixed(1)
}

function extractRepoId(model) {
  const sources = Array.isArray(model?.gguf_sources) ? model.gguf_sources : []

  for (const source of sources) {
    if (typeof source === 'string' && source.includes('/')) return source
    if (source && typeof source === 'object') {
      const candidates = [source.repo_id, source.repo, source.hf_repo, source.model]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.includes('/')) return candidate
      }
      if (typeof source.url === 'string') {
        const match = source.url.match(/huggingface\.co\/([^/?#]+\/[^/?#]+)/i)
        if (match) return match[1]
      }
    }
  }

  if (typeof model?.name === 'string' && model.name.includes('/')) return model.name
  return null
}

function DiscoverPage() {
  const navigate = useNavigate()
  const [mode, setMode] = useState('llm')
  const [useCase, setUseCase] = useState('chat')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [speechRegistry, setSpeechRegistry] = useState([])
  const [speechTasks, setSpeechTasks] = useState([])
  const [speechTaskFilter, setSpeechTaskFilter] = useState('all')
  const [speechSearch, setSpeechSearch] = useState('')
  const [speechLoading, setSpeechLoading] = useState(false)
  const [installingSpeechModelId, setInstallingSpeechModelId] = useState('')
  const [installedSpeechIds, setInstalledSpeechIds] = useState([])

  const loadSpeechInstalled = async () => {
    const response = await fetch('/api/speech/models')
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.detail || 'Failed to load installed speech models')
    const ids = Array.isArray(payload.data) ? payload.data.map((model) => String(model.id || '')) : []
    setInstalledSpeechIds(ids)
  }

  const loadSpeechRegistry = async (nextTask = speechTaskFilter, nextSearch = speechSearch) => {
    setSpeechLoading(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (nextTask && nextTask !== 'all') params.set('task', nextTask)
      if (nextSearch.trim()) params.set('search', nextSearch.trim())
      const response = await fetch(`/api/speech/registry?${params.toString()}`)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.detail || 'Failed to load speech registry')
      setSpeechRegistry(Array.isArray(payload.data) ? payload.data : [])
      setSpeechTasks(Array.isArray(payload.available_tasks) ? payload.available_tasks : [])
    } catch (err) {
      setSpeechRegistry([])
      setError(err.message || 'Failed to load speech registry')
    } finally {
      setSpeechLoading(false)
    }
  }

  useEffect(() => {
    const fetchRecommendations = async () => {
      if (mode !== 'llm') return
      try {
        setLoading(true)
        setError('')
        const response = await fetch(`/api/discover/recommendations?use_case=${encodeURIComponent(useCase)}&limit=6`)
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.detail || 'Failed to load recommendations')
        setData(payload)
      } catch (err) {
        setData(null)
        setError(err.message || 'Failed to load recommendations')
      } finally {
        setLoading(false)
      }
    }

    fetchRecommendations()
  }, [mode, useCase])

  useEffect(() => {
    if (mode !== 'speech') return
    loadSpeechInstalled().catch((err) => setError(err.message || 'Failed to load installed speech models'))
    loadSpeechRegistry('all', '').catch((err) => setError(err.message || 'Failed to load speech registry'))
  }, [mode])

  const handleInstallSpeechModel = async (modelId) => {
    try {
      setInstallingSpeechModelId(modelId)
      setError('')
      const response = await fetch(`/api/speech/models/install/${encodeURIComponent(modelId)}`, { method: 'POST' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.detail || 'Failed to install speech model')
      await loadSpeechInstalled()
    } catch (err) {
      setError(err.message || 'Failed to install speech model')
    } finally {
      setInstallingSpeechModelId('')
    }
  }

  const system = data?.system
  const models = data?.models || []
  const installedSpeechSet = useMemo(() => new Set(installedSpeechIds), [installedSpeechIds])
  const visibleSpeechRegistry = speechRegistry.slice(0, 60)

  return (
    <div className="p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Discover</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Install LLMs and speech models from one place.
          </p>
        </div>
        <div className="inline-flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--line-soft)' }}>
          {DISCOVER_MODES.map((item) => (
            <button
              key={item.key}
              onClick={() => setMode(item.key)}
              className="px-3 py-2 text-sm"
              style={{ background: mode === item.key ? 'var(--line-soft)' : 'transparent' }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="card mb-6">
          <p className="text-sm text-red-500">{error}</p>
        </div>
      )}

      {mode === 'llm' && (
        <>
          <div className="flex justify-end mb-6">
            <div className="inline-flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--line-soft)' }}>
              {USE_CASES.map((item) => (
                <button
                  key={item.key}
                  onClick={() => setUseCase(item.key)}
                  className="px-3 py-2 text-sm"
                  style={{ background: useCase === item.key ? 'var(--line-soft)' : 'transparent' }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {loading && <p style={{ color: 'var(--text-muted)' }}>Loading recommendations...</p>}

          {system && (
            <div className="card mb-6">
              <h3 className="text-lg font-semibold mb-3">Detected Hardware</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div><span style={{ color: 'var(--text-muted)' }}>CPU:</span> {system.cpu_name || '-'} ({system.cpu_cores || '-'} threads)</div>
                <div><span style={{ color: 'var(--text-muted)' }}>GPU:</span> {system.has_gpu ? `${system.gpu_name} (${system.gpu_vram_gb} GiB)` : 'No GPU detected'}</div>
                <div><span style={{ color: 'var(--text-muted)' }}>RAM:</span> {system.available_ram_gb} / {system.total_ram_gb} GiB free</div>
                <div><span style={{ color: 'var(--text-muted)' }}>Backend:</span> {system.backend || '-'}</div>
              </div>
            </div>
          )}

          {!loading && (
            <div className="space-y-4">
              {models.length === 0 ? (
                <div className="card">
                  <p style={{ color: 'var(--text-muted)' }}>No recommendations returned.</p>
                </div>
              ) : (
                models.map((model) => {
                  const repoId = extractRepoId(model)
                  return (
                    <div key={`${model.name}-${model.runtime}`} className="card">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                          <h3 className="text-lg font-semibold">{model.name}</h3>
                          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                            {model.runtime_label} • {model.run_mode_label} • {model.parameter_count} • {model.best_quant}
                          </p>
                          <p className="text-sm mt-2">{model.use_case}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                          <div><span style={{ color: 'var(--text-muted)' }}>Score:</span> {formatScore(model.score)}</div>
                          <div><span style={{ color: 'var(--text-muted)' }}>Fit:</span> {model.fit_label || model.fit_level}</div>
                          <div><span style={{ color: 'var(--text-muted)' }}>Est. tok/s:</span> {formatScore(model.estimated_tps)}</div>
                          <div><span style={{ color: 'var(--text-muted)' }}>VRAM need:</span> {formatScore(model.memory_required_gb)} GiB</div>
                          <div><span style={{ color: 'var(--text-muted)' }}>Context:</span> {model.context_length || '-'}</div>
                          <div><span style={{ color: 'var(--text-muted)' }}>Provider:</span> {model.provider || '-'}</div>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          onClick={() => repoId && navigate(`/models?repo=${encodeURIComponent(repoId)}`)}
                          disabled={!repoId}
                          className="btn btn-primary text-sm"
                        >
                          {repoId ? 'Find GGUF' : 'No GGUF Source'}
                        </button>
                        {repoId && (
                          <button
                            onClick={() => window.open(`https://huggingface.co/${repoId}`, '_blank', 'noopener,noreferrer')}
                            className="btn btn-secondary text-sm"
                          >
                            Open Repo
                          </button>
                        )}
                      </div>
                      {Array.isArray(model.notes) && model.notes.length > 0 && (
                        <div className="mt-4 space-y-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                          {model.notes.map((note, index) => (
                            <div key={index}>- {note}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          )}
        </>
      )}

      {mode === 'speech' && (
        <div className="card">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h3 className="text-lg font-semibold">Speech Registry</h3>
              <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                Showing the first 60 matches. Install speech models here, then use them in Playground.
              </p>
            </div>
            <button
              onClick={() => {
                loadSpeechInstalled().catch((err) => setError(err.message || 'Failed to load installed speech models'))
                loadSpeechRegistry(speechTaskFilter, speechSearch).catch((err) => setError(err.message || 'Failed to load speech registry'))
              }}
              className="btn btn-secondary text-sm"
              disabled={speechLoading}
            >
              {speechLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          <div className="flex flex-col lg:flex-row gap-3 mb-4">
            <div className="flex flex-wrap gap-2">
              {['all', ...speechTasks].map((task) => (
                <button
                  key={task}
                  type="button"
                  onClick={() => {
                    setSpeechTaskFilter(task)
                    loadSpeechRegistry(task, speechSearch).catch((err) => setError(err.message || 'Failed to load speech registry'))
                  }}
                  className={`px-3 py-1 rounded ${speechTaskFilter === task ? 'btn-primary text-white' : 'btn-secondary'}`}
                >
                  {task === 'all' ? 'All' : task}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                loadSpeechRegistry(speechTaskFilter, speechSearch).catch((err) => setError(err.message || 'Failed to load speech registry'))
              }}
              className="flex gap-2 flex-1"
            >
              <input
                value={speechSearch}
                onChange={(e) => setSpeechSearch(e.target.value)}
                placeholder="Search by model id"
                className="w-full px-3 py-2 rounded-lg border bg-transparent"
              />
              <button type="submit" className="btn btn-secondary">Search</button>
            </form>
          </div>

          {speechLoading ? (
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading speech registry...</div>
          ) : visibleSpeechRegistry.length === 0 ? (
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>No matching speech models found.</div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {visibleSpeechRegistry.map((model) => {
                const modelId = String(model.id || '')
                const isInstalled = installedSpeechSet.has(modelId)
                const isInstalling = installingSpeechModelId === modelId
                return (
                  <div key={modelId} className="rounded-xl border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="font-semibold break-all">{modelId}</div>
                        <div className="text-sm mt-2 space-y-1" style={{ color: 'var(--text-muted)' }}>
                          {model.task && <div>Task: {model.task}</div>}
                          {model.sample_rate && <div>Sample rate: {model.sample_rate} Hz</div>}
                          {Array.isArray(model.language) && model.language.length > 0 && (
                            <div>Languages: {model.language.slice(0, 4).join(', ')}{model.language.length > 4 ? '…' : ''}</div>
                          )}
                          {Array.isArray(model.voices) && model.voices.length > 0 && <div>Voices: {model.voices.length}</div>}
                        </div>
                      </div>
                      <button
                        onClick={() => handleInstallSpeechModel(modelId)}
                        disabled={isInstalled || isInstalling}
                        className={`btn text-sm ${isInstalled || isInstalling ? 'btn-secondary opacity-60 cursor-not-allowed' : 'btn-primary'}`}
                      >
                        {isInstalled ? 'Installed' : isInstalling ? 'Installing...' : 'Install'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default DiscoverPage
