import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const USE_CASES = [
  { key: 'chat', label: 'Chat' },
  { key: 'coding', label: 'Coding' },
]

const SETUP_STATE_KEY = 'ignite_onboarding_complete_v1'
const TEST_STATE_KEY = 'ignite_test_state_v1'

function getLastTestState() {
  try {
    const raw = sessionStorage.getItem(TEST_STATE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function getModelKindLabel(model) {
  const name = String(model?.name || '').toLowerCase()
  const useCase = String(model?.use_case || '').toLowerCase()

  if (name.includes('coder') || useCase.includes('code')) return 'Coding'
  if (name.includes('instruct') || name.includes('chat')) return 'Chat'
  return 'General'
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

  if (typeof model?.name === 'string' && model.name.includes('/')) {
    return model.name
  }

  return null
}

function SetupPage() {
  const navigate = useNavigate()
  const [useCase, setUseCase] = useState('chat')
  const [status, setStatus] = useState(null)
  const [discover, setDiscover] = useState(null)
  const [config, setConfig] = useState(null)
  const [installedModels, setInstalledModels] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [completed, setCompleted] = useState(() => localStorage.getItem(SETUP_STATE_KEY) === '1')
  const [lastTestState, setLastTestState] = useState(() => getLastTestState())
  const [startingRuntime, setStartingRuntime] = useState(false)
  const [stoppingRuntime, setStoppingRuntime] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true)
        setError('')
        const [statusRes, discoverRes, configRes, modelsRes] = await Promise.all([
          fetch('/api/status'),
          fetch(`/api/discover/recommendations?use_case=${encodeURIComponent(useCase)}&limit=3`),
          fetch('/api/config'),
          fetch('/api/models'),
        ])

        const statusData = await statusRes.json().catch(() => ({}))
        const discoverData = await discoverRes.json().catch(() => ({}))
        const configData = await configRes.json().catch(() => ({}))
        const modelsData = await modelsRes.json().catch(() => ([]))

        if (!statusRes.ok) throw new Error(statusData.detail || 'Failed to load runtime status')
        if (!discoverRes.ok) throw new Error(discoverData.detail || 'Failed to load recommendations')
        if (!configRes.ok) throw new Error(configData.detail || 'Failed to load config')
        if (!modelsRes.ok) throw new Error('Failed to load installed models')

        setStatus(statusData)
        setDiscover(discoverData)
        setConfig(configData)
        setInstalledModels(Array.isArray(modelsData) ? modelsData : [])
        setLastTestState(getLastTestState())
      } catch (err) {
        setError(err.message || 'Failed to load setup data')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [useCase])

  const configuredModelCount = Object.keys(config?.models || {}).length
  const installedModelCount = installedModels.length
  const topModel = useMemo(() => (discover?.models || [])[0] || null, [discover])
  const topRepoId = extractRepoId(topModel)
  const dockerReady = status?.docker_gpu?.state === 'ready' || status?.docker_gpu?.state === 'containerized'
  const lastTestPassed = Boolean(
    lastTestState && !lastTestState.error && (lastTestState.response || lastTestState.reasoning)
  )
  const dockerControlAvailable = Boolean(status?.docker_control_available)

  const steps = [
    {
      title: 'Check runtime',
      done: Boolean(status?.running),
      description: status?.running ? 'Ignite can reach llama-swap.' : 'The runtime is not responding yet.',
      action: () => navigate('/status'),
      actionLabel: 'Open Status',
    },
    {
      title: 'Confirm GPU support',
      done: Boolean(dockerReady),
      description: status?.docker_gpu?.message || 'Checking Docker GPU support...',
      action: () => navigate('/status'),
      actionLabel: 'Review GPU Status',
    },
    {
      title: 'Pick a model',
      done: Boolean(topRepoId) || installedModelCount > 0,
      description: installedModelCount > 0
        ? `${installedModelCount} model file(s) already downloaded.`
        : topModel
          ? `Top ${useCase} suggestion: ${topModel.name}`
          : 'Choose a recommendation for your hardware.',
      action: () => topRepoId && navigate(`/models?repo=${encodeURIComponent(topRepoId)}`),
      actionLabel: topRepoId ? 'Find GGUF' : 'Open Discover',
    },
    {
      title: 'Create config entry',
      done: configuredModelCount > 0,
      description: configuredModelCount > 0 ? `${configuredModelCount} model(s) are already configured.` : 'Download a model and add it to config with a launch preset.',
      action: () => navigate('/models'),
      actionLabel: 'Open Models',
    },
    {
      title: 'Run a test',
      done: lastTestPassed,
      description: lastTestPassed
        ? `Last successful test used ${lastTestState.model || 'a configured model'}.`
        : 'Use Test after adding a model to confirm the runtime and prompt mode behave as expected.',
      action: () => navigate('/test'),
      actionLabel: 'Open Test',
    },
  ]

  const completedSteps = steps.filter((step) => step.done).length

  const refreshSetup = async () => {
    setLoading(true)
    try {
      const [statusRes, discoverRes, configRes, modelsRes] = await Promise.all([
        fetch('/api/status'),
        fetch(`/api/discover/recommendations?use_case=${encodeURIComponent(useCase)}&limit=3`),
        fetch('/api/config'),
        fetch('/api/models'),
      ])

      const statusData = await statusRes.json().catch(() => ({}))
      const discoverData = await discoverRes.json().catch(() => ({}))
      const configData = await configRes.json().catch(() => ({}))
      const modelsData = await modelsRes.json().catch(() => ([]))

      if (!statusRes.ok) throw new Error(statusData.detail || 'Failed to load runtime status')
      if (!discoverRes.ok) throw new Error(discoverData.detail || 'Failed to load recommendations')
      if (!configRes.ok) throw new Error(configData.detail || 'Failed to load config')
      if (!modelsRes.ok) throw new Error('Failed to load installed models')

      setStatus(statusData)
      setDiscover(discoverData)
      setConfig(configData)
      setInstalledModels(Array.isArray(modelsData) ? modelsData : [])
      setLastTestState(getLastTestState())
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to refresh setup data')
    } finally {
      setLoading(false)
    }
  }

  const handleRuntimeStart = async () => {
    try {
      setStartingRuntime(true)
      const response = await fetch('/api/service/start', { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.detail || 'Failed to start runtime')
      await refreshSetup()
    } catch (err) {
      setError(err.message || 'Failed to start runtime')
    } finally {
      setStartingRuntime(false)
    }
  }

  const handleRuntimeStop = async () => {
    try {
      setStoppingRuntime(true)
      const response = await fetch('/api/service/stop', { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.detail || 'Failed to stop runtime')
      await refreshSetup()
    } catch (err) {
      setError(err.message || 'Failed to stop runtime')
    } finally {
      setStoppingRuntime(false)
    }
  }

  let nextAction = {
    title: 'Open Status',
    description: 'Review runtime state and logs.',
    label: 'Open Status',
    onClick: () => navigate('/status'),
  }

  if (!status?.running) {
    nextAction = {
      title: 'Start Runtime',
      description: 'Start the llama-runtime container before downloading or testing models.',
      label: startingRuntime ? 'Starting Runtime...' : 'Start Runtime',
      onClick: handleRuntimeStart,
      disabled: !dockerControlAvailable || startingRuntime,
    }
  } else if (installedModelCount === 0 && topRepoId) {
    nextAction = {
      title: 'Download Recommended Model',
      description: 'Jump straight to the GGUF list for the top recommendation.',
      label: 'Find GGUF',
      onClick: () => navigate(`/models?repo=${encodeURIComponent(topRepoId)}`),
    }
  } else if (configuredModelCount === 0) {
    nextAction = {
      title: 'Create Config Entry',
      description: 'Choose a launch profile and add your downloaded model to config.',
      label: 'Open Models',
      onClick: () => navigate('/models'),
    }
  } else if (!lastTestPassed) {
    nextAction = {
      title: 'Run First Test',
      description: 'Verify the configured model responds correctly before connecting other apps.',
      label: 'Open Test',
      onClick: () => navigate('/test'),
    }
  }

  const markComplete = () => {
    localStorage.setItem(SETUP_STATE_KEY, '1')
    setCompleted(true)
  }

  const resetComplete = () => {
    localStorage.removeItem(SETUP_STATE_KEY)
    setCompleted(false)
  }

  return (
    <div className="p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Setup</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Guided first-run flow for Docker, recommendations, download, config, and test.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          <button onClick={completed ? resetComplete : markComplete} className="btn btn-secondary text-sm">
            {completed ? 'Reset Setup State' : 'Mark Setup Complete'}
          </button>
        </div>
      </div>

      {completed && (
        <div className="card mb-6">
          <p className="text-sm">Setup marked complete on this browser. You can still use this page as a checklist.</p>
        </div>
      )}

      {loading && <p style={{ color: 'var(--text-muted)' }}>Loading setup state...</p>}

      {error && (
        <div className="card mb-6">
          <p className="text-sm text-red-500">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <div className="card lg:col-span-2">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h3 className="text-lg font-semibold">Progress</h3>
                  <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                    {completedSteps} of {steps.length} setup steps complete on this browser.
                  </p>
                </div>
                <div className="w-full md:w-72 rounded-full h-2" style={{ background: 'var(--line-soft)' }}>
                  <div
                    className="h-2 rounded-full transition-all"
                    style={{ width: `${(completedSteps / steps.length) * 100}%`, background: 'var(--brand)' }}
                  />
                </div>
              </div>
            </div>

            <div className="card lg:col-span-2">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <h3 className="text-lg font-semibold">{nextAction.title}</h3>
                  <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                    {nextAction.description}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={nextAction.onClick}
                    disabled={Boolean(nextAction.disabled)}
                    className={`btn ${nextAction.disabled ? 'btn-secondary opacity-60 cursor-not-allowed' : 'btn-primary'}`}
                  >
                    {nextAction.label}
                  </button>
                  {status?.running && (
                    <button
                      onClick={handleRuntimeStop}
                      disabled={!dockerControlAvailable || stoppingRuntime}
                      className={`btn ${!dockerControlAvailable || stoppingRuntime ? 'btn-secondary opacity-60 cursor-not-allowed' : 'btn-danger'}`}
                    >
                      {stoppingRuntime ? 'Stopping Runtime...' : 'Stop Runtime'}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="card">
              <h3 className="text-lg font-semibold mb-3">Detected Hardware</h3>
              <div className="space-y-2 text-sm">
                <div><span style={{ color: 'var(--text-muted)' }}>GPU:</span> {discover?.system?.has_gpu ? `${discover.system.gpu_name} (${discover.system.gpu_vram_gb} GiB)` : 'No GPU detected'}</div>
                <div><span style={{ color: 'var(--text-muted)' }}>RAM:</span> {discover?.system?.available_ram_gb} / {discover?.system?.total_ram_gb} GiB free</div>
                <div><span style={{ color: 'var(--text-muted)' }}>Backend:</span> {discover?.system?.backend || '-'}</div>
                <div><span style={{ color: 'var(--text-muted)' }}>Runtime:</span> {status?.runtime_mode || '-'}</div>
              </div>
            </div>

            <div className="card">
              <h3 className="text-lg font-semibold mb-3">Recommended Next Model</h3>
              {topModel ? (
                <div className="space-y-3">
                  <div>
                    <p className="font-medium">{topModel.name}</p>
                    <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                      {getModelKindLabel(topModel)} • {topModel.runtime_label} • {topModel.fit_label || topModel.fit_level} • {topModel.best_quant}
                    </p>
                  </div>
                  <div className="text-sm">
                    <div><span style={{ color: 'var(--text-muted)' }}>Est. tok/s:</span> {topModel.estimated_tps ?? '-'}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>VRAM need:</span> {topModel.memory_required_gb ?? '-'} GiB</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => topRepoId ? navigate(`/models?repo=${encodeURIComponent(topRepoId)}`) : navigate('/discover')}
                      className="btn btn-primary text-sm"
                    >
                      {topRepoId ? 'Find GGUF' : 'Open Discover'}
                    </button>
                    {topRepoId && (
                      <button
                        onClick={() => window.open(`https://huggingface.co/${topRepoId}`, '_blank', 'noopener,noreferrer')}
                        className="btn btn-secondary text-sm"
                      >
                        Open Repo
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No recommendation available.</p>
              )}
            </div>
          </div>

          <div className="space-y-3">
            {steps.map((step, index) => (
              <div key={step.title} className="card">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="flex items-center gap-3">
                      <span
                        className={`w-3 h-3 rounded-full ${step.done ? 'bg-green-500' : 'bg-amber-500'}`}
                      ></span>
                      <h3 className="text-lg font-semibold">{index + 1}. {step.title}</h3>
                    </div>
                    <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
                      {step.description}
                    </p>
                  </div>
                  <button onClick={step.action} className="btn btn-secondary text-sm">
                    {step.actionLabel}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default SetupPage
