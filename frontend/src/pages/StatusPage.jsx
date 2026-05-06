import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useServiceStatus } from '../hooks/useServiceStatus'
import { useGpuStats } from '../hooks/useGpuStats'
import { getGpuSetupUi, getLinuxGpuSetupCommands } from '../utils/gpuSetup'

function StatusPage() {
  const navigate = useNavigate()
  const {
    running,
    pid,
    dockerGpu,
    runtimeGpuWarning,
    dockerControlAvailable,
    dockerControlWarning,
    runtimeMode,
    llamaSwapPort,
    speachesPort,
    configExists,
    configPath,
    configuredModelCount,
    configuredModelIds,
    defaultModelId,
    defaultModelMode,
    speech,
    refreshStatus
  } = useServiceStatus(15000)
  const gpuStats = useGpuStats(15000)

  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [runtimeModels, setRuntimeModels] = useState([])
  const [runtimeModelsError, setRuntimeModelsError] = useState('')
  const [copiedField, setCopiedField] = useState('')
  const [showConnectApps, setShowConnectApps] = useState(false)
  const [showGpuGuide, setShowGpuGuide] = useState(false)

  useEffect(() => {
    let cancelled = false

    const loadRuntimeModels = async () => {
      if (!running) {
        if (!cancelled) {
          setRuntimeModels([])
          setRuntimeModelsError('')
        }
        return
      }

      try {
        const response = await fetch('/api/runtime/models')
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(data.detail || 'Failed to load runtime models')
        }
        if (!cancelled) {
          setRuntimeModels(Array.isArray(data.models) ? data.models : [])
          setRuntimeModelsError('')
        }
      } catch (error) {
        if (!cancelled) {
          setRuntimeModelsError(error.message || 'Failed to load runtime models')
        }
      }
    }

    loadRuntimeModels()
    const interval = setInterval(loadRuntimeModels, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
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

  const localApiBaseUrl = `${window.location.protocol}//127.0.0.1:${llamaSwapPort}/v1`
  const currentHostApiBaseUrl = `${window.location.protocol}//${window.location.hostname}:${llamaSwapPort}/v1`
  const speechApiBaseUrl = `${window.location.protocol}//127.0.0.1:${speachesPort}/v1`
  const modelsUrl = `${localApiBaseUrl}/models`
  const speechModelsUrl = `${speechApiBaseUrl}/models`
  const hasConfiguredModels = configuredModelCount > 0
  const sampleModelId = defaultModelId || configuredModelIds[0] || 'YourModel'
  const sampleEmbeddingModelId = configuredModelIds.find((id) => /embed/i.test(id)) || 'YourEmbeddingModel'
  const sampleRequest = defaultModelMode === 'completion'
    ? `curl ${localApiBaseUrl}/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${sampleModelId}","prompt":"Write a short function that adds two numbers."}'`
    : `curl ${localApiBaseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${sampleModelId}","messages":[{"role":"user","content":"hi"}]}'`
  const sampleVisionRequest = `curl ${localApiBaseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${sampleModelId}","messages":[{"role":"user","content":[{"type":"text","text":"Describe this image."},{"type":"image_url","image_url":{"url":"https://example.com/image.jpg"}}]}]}'`
  const sampleCompletionRequest = `curl ${localApiBaseUrl}/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"YourCompletionModel","prompt":"Complete this code:\\nfunction add(a, b) {"}'`
  const sampleEmbeddingsRequest = `curl ${localApiBaseUrl}/embeddings \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${sampleEmbeddingModelId}","input":"Local AI is useful for private workflows."}'`
  const sampleSpeechRequest = `curl ${speechApiBaseUrl}/audio/speech \\
  -H "Content-Type: application/json" \\
  -d '{"model":"speaches-ai/Kokoro-82M-v1.0-ONNX","voice":"af_heart","input":"Hello from Ignite."}' \\
  --output speech.mp3`
  const sampleTranscriptionRequest = `curl ${speechApiBaseUrl}/audio/transcriptions \\
  -F "model=Systran/faster-distil-whisper-small.en" \\
  -F "file=@sample.wav"`

  const formatGiB = (value) => Number(value || 0).toFixed(1).replace(/\.0$/, '')
  const activeModels = runtimeModels.filter((model) => model.state && model.state !== 'stopped')
  const gpuSetup = getGpuSetupUi(dockerGpu, gpuStats)
  const gpuSetupCommands = getLinuxGpuSetupCommands()

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6 gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Service Status</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Runtime health, GPU usage, model controls, and connection details.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => navigate('/runtime')}
            className="btn btn-secondary"
          >
            Open Runtime
          </button>
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

      <div className="card mb-6" style={{ padding: '1rem' }}>
        <div className="flex items-center justify-between gap-4 mb-3">
          <div>
            <h3 className="text-base font-semibold">Active Models</h3>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              Current non-stopped models. Open Runtime for load, unload, and request activity.
            </p>
          </div>
          <button onClick={() => navigate('/runtime')} className="btn btn-secondary text-sm">
            Manage
          </button>
        </div>
        {!running ? (
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Runtime is stopped.
          </div>
        ) : runtimeModelsError ? (
          <div className="text-sm" style={{ color: '#fda4af' }}>
            {runtimeModelsError}
          </div>
        ) : activeModels.length === 0 ? (
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No active models.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {activeModels.map((model) => (
              <div
                key={model.id}
                className="rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}
              >
                <div className="font-medium">{model.id}</div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  {model.state}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {runtimeGpuWarning && (
        <div
          className="card mb-6"
          style={{
            padding: '1rem',
            borderColor: 'rgba(245, 158, 11, 0.35)',
            background: 'rgba(245, 158, 11, 0.10)'
          }}
        >
          <h3 className="text-base font-semibold mb-2">Runtime GPU Warning</h3>
          <p className="text-sm" style={{ color: '#fde68a' }}>
            {runtimeGpuWarning.message}
          </p>
          {runtimeGpuWarning.next_step && (
            <p className="text-xs mt-2" style={{ color: '#fde68a' }}>
              {runtimeGpuWarning.next_step}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="card" style={{ padding: '1rem' }}>
          <h3 className="text-base font-semibold mb-2">Runtime</h3>
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${running ? 'bg-green-500' : 'bg-red-500'}`}></span>
            <span className="text-lg font-semibold">{running ? 'Running' : 'Stopped'}</span>
          </div>
          {pid && <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>PID: {pid}</p>}
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Mode: {runtimeMode === 'docker' ? 'Docker-managed runtime' : 'Local process'}
          </p>
        </div>

        <div className="card" style={{ padding: '1rem' }}>
          <h3 className="text-base font-semibold mb-2">Speech Service</h3>
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${speech?.reachable ? 'bg-green-500' : 'bg-amber-500'}`}></span>
            <span className="text-lg font-semibold">{speech?.reachable ? 'Ready' : 'Offline'}</span>
          </div>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            {speech?.reachable
              ? `Speaches is reachable at ${speechApiBaseUrl}.`
              : (speech?.error || 'Speaches is not reachable right now.')}
          </p>
          {speech?.details?.sample_rate && (
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              Sample rate: {speech.details.sample_rate} Hz
            </p>
          )}
          {speech?.reachable && typeof speech?.details?.model_count === 'number' && (
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              Installed speech models: {speech.details.model_count}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
          {gpuStats.gpus.map((gpu) => (
            <div
              key={gpu.index}
              className="card"
              style={{ padding: '1rem' }}
            >
              <div className="font-medium">GPU {gpu.index}: {gpu.name}</div>
              <div className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                {formatGiB(gpu.memory_used_gb)} / {formatGiB(gpu.memory_total_gb)} GiB • {gpu.temperature_c}°C
              </div>
            </div>
          ))}
        </div>
      </div>

      {running && (
        <div className="card mb-6" style={{ padding: '1rem' }}>
          <button
            onClick={() => setShowConnectApps((prev) => !prev)}
            className="w-full flex items-center justify-between text-left"
          >
            <div>
              <h3 className="text-base font-semibold">Connect Other Apps</h3>
              <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                Copy the exact API endpoint and example request for external apps.
              </p>
            </div>
            <span className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
              {showConnectApps ? 'Hide' : 'Show'}
            </span>
          </button>

          {showConnectApps && (
            <div className="space-y-2 mt-3">
              <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">Base URL</div>
                    <div className="font-mono text-sm mt-1">{localApiBaseUrl}</div>
                  </div>
                  <button onClick={() => copyText('base', localApiBaseUrl)} className="btn btn-secondary text-sm">
                    {copiedField === 'base' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              {speech?.enabled && (
                <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">Speech Base URL</div>
                      <div className="font-mono text-sm mt-1">{speechApiBaseUrl}</div>
                    </div>
                    <button onClick={() => copyText('speech-base', speechApiBaseUrl)} className="btn btn-secondary text-sm">
                      {copiedField === 'speech-base' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              {currentHostApiBaseUrl !== localApiBaseUrl && (
                <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">Current Host URL</div>
                      <div className="font-mono text-sm mt-1">{currentHostApiBaseUrl}</div>
                    </div>
                    <button onClick={() => copyText('base-current-host', currentHostApiBaseUrl)} className="btn btn-secondary text-sm">
                      {copiedField === 'base-current-host' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
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

              {speech?.enabled && (
                <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">Speech Models URL</div>
                      <div className="font-mono text-sm mt-1">{speechModelsUrl}</div>
                    </div>
                    <button onClick={() => copyText('speech-models', speechModelsUrl)} className="btn btn-secondary text-sm">
                      {copiedField === 'speech-models' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              <div className="rounded-lg border p-2.5 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
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

              <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
                <div className="font-medium mb-3">API Examples</div>
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <div className="text-sm font-medium">List Models</div>
                      <button onClick={() => copyText('curl-models', `curl ${modelsUrl}`)} className="btn btn-secondary text-sm">
                        {copiedField === 'curl-models' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <div className="font-mono whitespace-pre-wrap text-sm" style={{ color: 'var(--text-muted)' }}>
                      {`curl ${modelsUrl}`}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <div className="text-sm font-medium">Chat</div>
                      <button onClick={() => copyText('curl-chat', sampleRequest)} className="btn btn-secondary text-sm">
                        {copiedField === 'curl-chat' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <div className="font-mono whitespace-pre-wrap text-sm" style={{ color: 'var(--text-muted)' }}>
                      {sampleRequest}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <div className="text-sm font-medium">Vision Chat</div>
                      <button onClick={() => copyText('curl-vision', sampleVisionRequest)} className="btn btn-secondary text-sm">
                        {copiedField === 'curl-vision' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <div className="font-mono whitespace-pre-wrap text-sm" style={{ color: 'var(--text-muted)' }}>
                      {sampleVisionRequest}
                    </div>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      Use this only with a vision-capable chat model.
                    </p>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <div className="text-sm font-medium">Completion</div>
                      <button onClick={() => copyText('curl-completion', sampleCompletionRequest)} className="btn btn-secondary text-sm">
                        {copiedField === 'curl-completion' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <div className="font-mono whitespace-pre-wrap text-sm" style={{ color: 'var(--text-muted)' }}>
                      {sampleCompletionRequest}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <div className="text-sm font-medium">Embeddings</div>
                      <button onClick={() => copyText('curl-embeddings', sampleEmbeddingsRequest)} className="btn btn-secondary text-sm">
                        {copiedField === 'curl-embeddings' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <div className="font-mono whitespace-pre-wrap text-sm" style={{ color: 'var(--text-muted)' }}>
                      {sampleEmbeddingsRequest}
                    </div>
                  </div>

                  {speech?.enabled && (
                    <>
                      <div>
                        <div className="flex items-center justify-between gap-3 mb-1">
                          <div className="text-sm font-medium">Speech Voices / Models</div>
                          <button onClick={() => copyText('curl-speech-models', `curl ${speechModelsUrl}`)} className="btn btn-secondary text-sm">
                            {copiedField === 'curl-speech-models' ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                        <div className="font-mono whitespace-pre-wrap text-sm" style={{ color: 'var(--text-muted)' }}>
                          {`curl ${speechModelsUrl}`}
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-3 mb-1">
                          <div className="text-sm font-medium">Text To Speech</div>
                          <button onClick={() => copyText('curl-speech', sampleSpeechRequest)} className="btn btn-secondary text-sm">
                            {copiedField === 'curl-speech' ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                        <div className="font-mono whitespace-pre-wrap text-sm" style={{ color: 'var(--text-muted)' }}>
                          {sampleSpeechRequest}
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-3 mb-1">
                          <div className="text-sm font-medium">Speech To Text</div>
                          <button onClick={() => copyText('curl-transcription', sampleTranscriptionRequest)} className="btn btn-secondary text-sm">
                            {copiedField === 'curl-transcription' ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                        <div className="font-mono whitespace-pre-wrap text-sm" style={{ color: 'var(--text-muted)' }}>
                          {sampleTranscriptionRequest}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div
        className="card mb-4"
        style={{
          padding: '1rem',
          borderColor: dockerGpuTone.border,
          background: dockerGpuTone.background
        }}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className={`w-3 h-3 rounded-full ${dockerGpuTone.badge}`}></span>
          <h3 className="text-base font-semibold">{gpuSetup.title}</h3>
        </div>
        <p className="font-medium">
          {gpuSetup.message}
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
          {gpuSetup.nextStep}
        </p>
        {gpuSetup.state !== 'ready' && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => setShowGpuGuide((prev) => !prev)}
              className="btn btn-secondary text-sm"
            >
              {showGpuGuide ? 'Hide GPU Setup Guide' : 'Open GPU Setup Guide'}
            </button>
          </div>
        )}
        {gpuSetup.state !== 'ready' && showGpuGuide && (
          <div className="mt-4 rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
            <div className="font-medium mb-2">Linux GPU Setup Guide</div>
            <div className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>
              Run these commands on the host, not inside a container. This is the usual setup path for Ubuntu or Debian.
            </div>
            <div className="space-y-2">
              {gpuSetupCommands.map((line, index) => (
                <div
                  key={index}
                  className="font-mono text-sm rounded-lg border p-3 break-all"
                  style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.04)' }}
                >
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}
        {dockerGpu?.details?.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
              Advanced Details
            </summary>
            <div className="mt-3 space-y-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              {dockerGpu.details.map((detail, index) => (
                <div key={index}>- {detail}</div>
              ))}
            </div>
          </details>
        )}
      </div>

      <div
        className="card"
        style={{
          padding: '1rem',
          borderLeft: '6px solid rgba(245, 158, 11, 0.65)',
          background: 'linear-gradient(180deg, rgba(245, 158, 11, 0.06) 0%, rgba(15, 23, 42, 0) 100%)'
        }}
      >
        <div className="flex items-center justify-between gap-4 mb-2">
          <div>
            <div className="text-xs uppercase tracking-[0.18em]" style={{ color: 'var(--text-muted)' }}>
              Advanced
            </div>
            <h3 className="text-base font-semibold">Runtime Config</h3>
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
