import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useServiceStatus } from '../hooks/useServiceStatus'
import { useGpuStats } from '../hooks/useGpuStats'

function StatusPage() {
  const navigate = useNavigate()
  const {
    running,
    pid,
    dockerGpu,
    dockerControlAvailable,
    dockerControlWarning,
    runtimeMode,
    llamaSwapPort,
    configExists,
    configPath,
    configuredModelCount,
    configuredModelIds,
    defaultModelId,
    defaultModelMode,
    activeRuntimeModel,
    refreshStatus
  } = useServiceStatus(15000)
  const gpuStats = useGpuStats(15000)

  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [copiedField, setCopiedField] = useState('')
  const [showConnectApps, setShowConnectApps] = useState(false)

  useEffect(() => {
    if (running) {
      setShowConnectApps(true)
    }
  }, [running])

  const dockerGpuTone = dockerGpu?.state === 'ready'
    ? {
        badge: 'bg-green-500',
        border: 'rgba(34, 197, 94, 0.35)',
        background: 'rgba(40, 167, 69, 0.10)'
      }
    : {
        badge: 'bg-amber-500',
        border: 'rgba(245, 158, 11, 0.35)',
        background: 'rgba(245, 158, 11, 0.10)'
      }

  const startDisabled = (runtimeMode === 'docker' && !dockerControlAvailable) || running || starting
  const stopDisabled = (runtimeMode === 'docker' && !dockerControlAvailable) || !running || stopping

  const handleStart = async () => {
    try {
      setStarting(true)
      const response = await fetch('/api/service/start', { method: 'POST' })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.detail || 'Failed to start service')
      }
      refreshStatus()
    } catch (error) {
      alert(error.message || 'Failed to start service')
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    try {
      setStopping(true)
      const response = await fetch('/api/service/stop', { method: 'POST' })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.detail || 'Failed to stop service')
      }
      refreshStatus()
    } catch (error) {
      alert(error.message || 'Failed to stop service')
    } finally {
      setStopping(false)
    }
  }

  const copyText = async (label, value) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(label)
      setTimeout(() => setCopiedField(''), 1600)
    } catch {
      alert(`Copy failed. Value: ${value}`)
    }
  }

  const apiBaseUrl = `${window.location.protocol}//${window.location.hostname}:${llamaSwapPort}/v1`
  const modelsUrl = `${apiBaseUrl}/models`
  const hasConfiguredModels = configuredModelCount > 0
  const sampleModelId = defaultModelId || configuredModelIds[0] || 'YourModel'
  const sampleRequest = defaultModelMode === 'completion'
    ? `curl ${apiBaseUrl}/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${sampleModelId}","prompt":"Write a short function that adds two numbers."}'`
    : `curl ${apiBaseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${sampleModelId}","messages":[{"role":"user","content":"hi"}]}'`

  const activeModelState = activeRuntimeModel?.state || 'unknown'
  const activeModelDisplay = activeRuntimeModel?.display_name || activeRuntimeModel?.model_id || ''
  const activeModelSource = activeRuntimeModel?.derived ? 'Derived from runtime events' : 'Reported by runtime'

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6 gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Service Status</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Runtime health, GPU usage, active model, and connection details.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => navigate('/logs')}
            className="btn btn-secondary"
          >
            Open Logs
          </button>
          <button
            onClick={handleStart}
            disabled={startDisabled}
            className={`btn ${startDisabled ? 'btn-secondary opacity-60 cursor-not-allowed' : 'btn-primary'}`}
          >
            {runtimeMode === 'docker'
              ? starting ? 'Starting Runtime...' : 'Start Runtime'
              : starting ? 'Starting...' : 'Start'}
          </button>
          <button
            onClick={handleStop}
            disabled={stopDisabled}
            className={`btn ${stopDisabled ? 'btn-secondary opacity-60 cursor-not-allowed' : 'btn-danger'}`}
          >
            {runtimeMode === 'docker'
              ? stopping ? 'Stopping Runtime...' : 'Stop Runtime'
              : stopping ? 'Stopping...' : 'Stop'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="card">
          <h3 className="text-lg font-semibold mb-2">Runtime</h3>
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${running ? 'bg-green-500' : 'bg-red-500'}`}></span>
            <span className="text-xl font-semibold">{running ? 'Running' : 'Stopped'}</span>
          </div>
          {pid && <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>PID: {pid}</p>}
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Mode: {runtimeMode === 'docker' ? 'Docker-managed runtime' : 'Local process'}
          </p>
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold mb-2">GPU Status</h3>
          <p className="text-xl font-semibold">
            {gpuStats.memoryUsedGb} / {gpuStats.memoryTotalGb} GiB
          </p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Temperature: {gpuStats.temperatureC}°C
          </p>
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold mb-2">Current Active Model</h3>
          {activeModelState === 'active' ? (
            <>
              <p className="text-xl font-semibold">{activeModelDisplay}</p>
              <p className="text-sm mt-1 font-mono" style={{ color: 'var(--text-muted)' }}>
                {activeRuntimeModel?.model_id}
              </p>
            </>
          ) : (
            <p className="text-xl font-semibold">
              {running ? 'No active model detected' : 'Runtime offline'}
            </p>
          )}
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            {activeModelSource}
          </p>
        </div>
      </div>

      <div
        className="card mb-6"
        style={{
          borderColor: dockerGpuTone.border,
          background: dockerGpuTone.background
        }}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className={`w-3 h-3 rounded-full ${dockerGpuTone.badge}`}></span>
          <h3 className="text-lg font-semibold">Docker GPU Preflight</h3>
        </div>
        <p className="font-medium">
          {dockerGpu?.message || 'Checking Docker GPU runtime...'}
        </p>
        {dockerGpu?.state !== 'ready' && (
          <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
            Ignite runs in Docker, but GPU-backed llama.cpp containers need host-level NVIDIA Container Toolkit support.
          </p>
        )}
        {dockerGpu?.details?.length > 0 && (
          <div className="mt-3 space-y-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            {dockerGpu.details.map((detail, index) => (
              <div key={index}>- {detail}</div>
            ))}
          </div>
        )}
      </div>

      {running && (
        <div className="card mb-6">
          <button
            onClick={() => setShowConnectApps((prev) => !prev)}
            className="w-full flex items-center justify-between text-left"
          >
            <div>
              <h3 className="text-lg font-semibold">Connect Other Apps</h3>
              <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                Copy the exact API endpoint and example request for external apps.
              </p>
            </div>
            <span className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
              {showConnectApps ? 'Hide' : 'Show'}
            </span>
          </button>

          {showConnectApps && (
            <div className="space-y-3 mt-4">
              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">Base URL</div>
                    <div className="font-mono text-sm mt-1">{apiBaseUrl}</div>
                  </div>
                  <button onClick={() => copyText('base', apiBaseUrl)} className="btn btn-secondary text-sm">
                    {copiedField === 'base' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">Models URL</div>
                    <div className="font-mono text-sm mt-1">{modelsUrl}</div>
                  </div>
                  <button onClick={() => copyText('models', modelsUrl)} className="btn btn-secondary text-sm">
                    {copiedField === 'models' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
                <div className="font-medium mb-2">Quick checks</div>
                <div className="font-mono whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>
{hasConfiguredModels
  ? `curl ${modelsUrl}

${sampleRequest}`
  : `curl ${modelsUrl}`}
                </div>
              </div>

              {!hasConfiguredModels && (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Runtime is up, but you still need at least one configured model before other apps can send useful requests.
                </p>
              )}
              {hasConfiguredModels && (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Default example model: <span className="font-mono">{sampleModelId}</span>
                  {defaultModelMode === 'completion'
                    ? ' using the completions endpoint.'
                    : ' using the chat completions endpoint.'}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div
        className="card"
        style={{
          borderLeft: '6px solid rgba(245, 158, 11, 0.65)',
          background: 'linear-gradient(180deg, rgba(245, 158, 11, 0.06) 0%, rgba(15, 23, 42, 0) 100%)'
        }}
      >
        <div className="flex items-center justify-between gap-4 mb-2">
          <div>
            <div className="text-xs uppercase tracking-[0.18em]" style={{ color: 'var(--text-muted)' }}>
              Advanced
            </div>
            <h3 className="text-lg font-semibold">Runtime Config</h3>
          </div>
        </div>
        <p className="font-medium">
          {configExists ? 'Config file present' : 'Config file missing'}
        </p>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          {configPath || '-'}
        </p>
        {runtimeMode === 'docker' && !dockerControlAvailable && (
          <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
            Runtime start/stop buttons need Docker socket access inside the Ignite container.
          </p>
        )}
        {dockerControlWarning && (
          <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
            {dockerControlWarning}
          </p>
        )}
        {!configExists && (
          <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
            Create or save a config before starting the runtime stack.
          </p>
        )}
      </div>
    </div>
  )
}

export default StatusPage
