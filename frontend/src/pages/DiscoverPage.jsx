import React, { useEffect, useState } from 'react'

const USE_CASES = [
  { key: 'chat', label: 'Chat' },
  { key: 'coding', label: 'Coding' },
]

function formatScore(value) {
  if (value === null || value === undefined) return '-'
  return Number(value).toFixed(1)
}

function DiscoverPage() {
  const [useCase, setUseCase] = useState('chat')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const fetchRecommendations = async () => {
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
  }, [useCase])

  const system = data?.system
  const models = data?.models || []

  return (
    <div className="p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Discover</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Hardware-aware recommendations from llmfit for llama.cpp.
          </p>
        </div>
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

      {error && (
        <div className="card mb-6">
          <p className="text-sm text-red-500">{error}</p>
        </div>
      )}

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

      {!loading && !error && (
        <div className="space-y-4">
          {models.length === 0 ? (
            <div className="card">
              <p style={{ color: 'var(--text-muted)' }}>No recommendations returned.</p>
            </div>
          ) : (
            models.map((model) => (
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
                {Array.isArray(model.notes) && model.notes.length > 0 && (
                  <div className="mt-4 space-y-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                    {model.notes.map((note, index) => (
                      <div key={index}>- {note}</div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export default DiscoverPage
