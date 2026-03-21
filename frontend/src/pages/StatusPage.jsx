import React, { useState, useEffect } from 'react'
import { useServiceStatus } from '../hooks/useServiceStatus'
import { useGpuStats } from '../hooks/useGpuStats'

function StatusPage() {
  const {
    running,
    pid,
    dockerGpu,
    dockerControlAvailable,
    dockerControlWarning,
    runtimeMode,
    backendPort,
    llamaSwapPort,
    configExists,
    configPath,
    configuredModelCount,
    configuredModelIds,
    defaultModelId,
    defaultModelMode,
    refreshStatus
  } = useServiceStatus(15000)
  const gpuStats = useGpuStats(15000)
  const [proxyLogs, setProxyLogs] = useState([])
  const [upstreamLogs, setUpstreamLogs] = useState([])
  const [logTab, setLogTab] = useState('proxy')
  const [dockerLogTab, setDockerLogTab] = useState('runtime')
  const [dockerLogs, setDockerLogs] = useState([])
  const [dockerLogError, setDockerLogError] = useState('')
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [copiedField, setCopiedField] = useState('')

  useEffect(() => {
    const appendLog = (setter) => (event) => {
      const line = event.data
      if (!line) return
      setter((prev) => [...prev, line].slice(-400))
    }

    const proxySource = new EventSource('/api/logs/stream/proxy')
    const upstreamSource = new EventSource('/api/logs/stream/upstream')

    proxySource.onmessage = appendLog(setProxyLogs)
    upstreamSource.onmessage = appendLog(setUpstreamLogs)

    proxySource.onerror = () => {}
    upstreamSource.onerror = () => {}

    return () => {
      proxySource.close()
      upstreamSource.close()
    }
  }, [])

  useEffect(() => {
    if (runtimeMode !== 'docker') return

    let cancelled = false

    const loadDockerLogs = async () => {
      try {
        const response = await fetch(`/api/logs/docker/${dockerLogTab}?lines=200`)
        const data = await response.json().catch(() => [])
        if (!response.ok) {
          throw new Error(data.detail || 'Failed to load Docker logs')
        }
        if (!cancelled) {
          setDockerLogs(Array.isArray(data) ? data : [])
          setDockerLogError('')
        }
      } catch (error) {
        if (!cancelled) {
          setDockerLogError(error.message || 'Failed to load Docker logs')
        }
      }
    }

    loadDockerLogs()
    const interval = setInterval(loadDockerLogs, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [runtimeMode, dockerLogTab])

  const visibleLogs = logTab === 'proxy'
    ? proxyLogs.filter((line) => !line.includes('GET /v1/models'))
    : upstreamLogs

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

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold tracking-tight">Service Status</h2>
        <div className="flex gap-2">
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="card">
          <h3 className="text-lg font-semibold mb-2">Llama Swap</h3>
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
      </div>

      <div className="card mb-6">
        <h3 className="text-lg font-semibold mb-2">Runtime Config</h3>
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

      {running && (
        <div className="card mb-6">
          <h3 className="text-lg font-semibold mb-2">Connect Other Apps</h3>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
            Use this OpenAI-compatible API endpoint in other apps that support custom providers or local models.
          </p>

          <div className="space-y-3">
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
        </div>
      )}

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

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Recent Logs</h3>
          <div className="flex items-center gap-2 text-sm">
            <button
              onClick={() => setLogTab('proxy')}
              className={`px-3 py-1 rounded ${logTab === 'proxy' ? 'btn-primary text-white' : 'btn-secondary'}`}
            >
              Proxy Logs
            </button>
            <button
              onClick={() => setLogTab('upstream')}
              className={`px-3 py-1 rounded ${logTab === 'upstream' ? 'btn-primary text-white' : 'btn-secondary'}`}
            >
              Upstream Logs
            </button>
          </div>
        </div>
        <div className="p-4 rounded-lg font-mono text-sm overflow-y-auto max-h-96 border" style={{ background: '#0b1220', borderColor: 'var(--line-soft)', color: '#8de4af' }}>
          {visibleLogs.length === 0 ? (
            <div className="whitespace-pre-wrap" style={{ color: '#94a3b8' }}>
              No upstream logs yet. Trigger a model request to populate this stream.
            </div>
          ) : (
            visibleLogs.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap">{line}</div>
            ))
          )}
        </div>
      </div>

      {runtimeMode === 'docker' && (
        <div className="card mt-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Docker Container Logs</h3>
            <div className="flex items-center gap-2 text-sm">
              <button
                onClick={() => setDockerLogTab('runtime')}
                className={`px-3 py-1 rounded ${dockerLogTab === 'runtime' ? 'btn-primary text-white' : 'btn-secondary'}`}
              >
                Runtime
              </button>
              <button
                onClick={() => setDockerLogTab('ignite')}
                className={`px-3 py-1 rounded ${dockerLogTab === 'ignite' ? 'btn-primary text-white' : 'btn-secondary'}`}
              >
                Ignite
              </button>
              <button
                onClick={() => setDockerLogTab('llmfit')}
                className={`px-3 py-1 rounded ${dockerLogTab === 'llmfit' ? 'btn-primary text-white' : 'btn-secondary'}`}
              >
                llmfit
              </button>
            </div>
          </div>
          <div className="p-4 rounded-lg font-mono text-sm overflow-y-auto max-h-96 border" style={{ background: '#0b1220', borderColor: 'var(--line-soft)', color: '#8de4af' }}>
            {dockerLogError ? (
              <div className="whitespace-pre-wrap" style={{ color: '#fda4af' }}>
                {dockerLogError}
              </div>
            ) : dockerLogs.length === 0 ? (
              <div className="whitespace-pre-wrap" style={{ color: '#94a3b8' }}>
                No Docker logs yet for this container.
              </div>
            ) : (
              dockerLogs.map((line, index) => (
                <div key={index} className="whitespace-pre-wrap">{line}</div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default StatusPage
