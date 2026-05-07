import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useServiceStatus } from '../hooks/useServiceStatus'

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function decodeBase64Utf8(value) {
  if (!value || typeof value !== 'string') return ''
  try {
    const binary = window.atob(value)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

function tryParseJson(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function decodeCapturePayload(capture) {
  if (!capture || typeof capture !== 'object') {
    return {
      requestText: '',
      requestJson: null,
      responseText: '',
      responseJson: null,
      requestMessages: [],
      responseMessage: '',
    }
  }

  const requestText = decodeBase64Utf8(capture.req_body)
  const responseText = decodeBase64Utf8(capture.resp_body)
  const requestJson = tryParseJson(requestText)
  const responseJson = tryParseJson(responseText)
  const requestMessages = Array.isArray(requestJson?.messages) ? requestJson.messages : []
  const responseMessage =
    responseJson?.choices?.[0]?.message?.content ||
    responseJson?.choices?.[0]?.text ||
    ''

  return {
    requestText,
    requestJson,
    responseText,
    responseJson,
    requestMessages,
    responseMessage,
  }
}

function RuntimePage() {
  const navigate = useNavigate()
  const { running } = useServiceStatus(15000)
  const [overview, setOverview] = useState({ models: [], metrics: [], inflight_total: 0 })
  const [runtimeError, setRuntimeError] = useState('')
  const [loadingModelId, setLoadingModelId] = useState('')
  const [unloadingModelId, setUnloadingModelId] = useState('')
  const [unloadingAll, setUnloadingAll] = useState(false)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [captureLoading, setCaptureLoading] = useState(false)
  const [captureError, setCaptureError] = useState('')
  const [captureData, setCaptureData] = useState(null)
  const [captureId, setCaptureId] = useState(null)
  const [captureView, setCaptureView] = useState('decoded')

  useEffect(() => {
    let cancelled = false

    const loadOverview = async () => {
      if (!running) {
        if (!cancelled) {
          setOverview({ models: [], metrics: [], inflight_total: 0 })
          setRuntimeError('')
        }
        return
      }

      try {
        const response = await fetch('/api/runtime/overview')
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(data.detail || 'Failed to load runtime overview')
        }
        if (!cancelled) {
          setOverview({
            models: Array.isArray(data.models) ? data.models : [],
            metrics: Array.isArray(data.metrics) ? data.metrics : [],
            inflight_total: Number(data.inflight_total || 0),
          })
          setRuntimeError('')
        }
      } catch (error) {
        if (!cancelled) {
          setRuntimeError(error.message || 'Failed to load runtime overview')
        }
      }
    }

    loadOverview()
    const interval = setInterval(loadOverview, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [running])

  const refreshOverview = async () => {
    const response = await fetch('/api/runtime/overview')
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(data.detail || 'Failed to refresh runtime overview')
    }
    setOverview({
      models: Array.isArray(data.models) ? data.models : [],
      metrics: Array.isArray(data.metrics) ? data.metrics : [],
      inflight_total: Number(data.inflight_total || 0),
    })
    setRuntimeError('')
  }

  const handleModelLoad = async (modelId) => {
    try {
      setLoadingModelId(modelId)
      const response = await fetch(`/api/runtime/models/load/${encodeURIComponent(modelId)}`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.detail || 'Failed to load model')
      await refreshOverview()
    } catch (error) {
      alert(error.message || 'Failed to load model')
    } finally {
      setLoadingModelId('')
    }
  }

  const handleModelUnload = async (modelId) => {
    try {
      setUnloadingModelId(modelId)
      const response = await fetch(`/api/runtime/models/unload/${encodeURIComponent(modelId)}`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.detail || 'Failed to unload model')
      await refreshOverview()
    } catch (error) {
      alert(error.message || 'Failed to unload model')
    } finally {
      setUnloadingModelId('')
    }
  }

  const handleUnloadAll = async () => {
    try {
      setUnloadingAll(true)
      const response = await fetch('/api/runtime/models/unload', { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.detail || 'Failed to unload all models')
      await refreshOverview()
    } catch (error) {
      alert(error.message || 'Failed to unload all models')
    } finally {
      setUnloadingAll(false)
    }
  }

  const openCapture = async (id) => {
    try {
      setCaptureId(id)
      setCaptureOpen(true)
      setCaptureLoading(true)
      setCaptureError('')
      setCaptureData(null)
      setCaptureView('decoded')
      const response = await fetch(`/api/runtime/captures/${id}`)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.detail || 'Failed to load capture')
      setCaptureData(data)
    } catch (error) {
      setCaptureError(error.message || 'Failed to load capture')
    } finally {
      setCaptureLoading(false)
    }
  }

  const formatNumber = (value) => Number(value || 0).toLocaleString()
  const formatSpeed = (value) => (value == null ? '-' : `${Number(value).toFixed(2)}`.replace(/\.00$/, '') + ' t/s')
  const formatDuration = (value) => `${(Number(value || 0) / 1000).toFixed(2)}s`
  const formatTimeAgo = (value) => {
    if (!value) return '-'
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
    if (seconds < 10) return 'now'
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    return new Date(value).toLocaleString()
  }

  const metrics = overview.metrics || []
  const models = overview.models || []
  const activeModels = useMemo(
    () => models.filter((model) => model.state && model.state !== 'stopped'),
    [models]
  )
  const completedCount = metrics.length
  const processedTokens = metrics.reduce((sum, item) => sum + Math.max(0, Number(item.input_tokens || 0)), 0)
  const generatedTokens = metrics.reduce((sum, item) => sum + Math.max(0, Number(item.output_tokens || 0)), 0)
  const tokenSpeeds = metrics
    .map((item) => Number(item.tokens_per_second))
    .filter((value) => Number.isFinite(value) && value > 0)
  const p50 = percentile(tokenSpeeds, 50)
  const p95 = percentile(tokenSpeeds, 95)
  const p99 = percentile(tokenSpeeds, 99)
  const activity = [...metrics].sort((a, b) => Number(b.id || 0) - Number(a.id || 0)).slice(0, 15)
  const decodedCapture = useMemo(() => decodeCapturePayload(captureData), [captureData])

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6 gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Runtime</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Live model controls, request activity, and token metrics from the running runtime.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => navigate('/status')} className="btn btn-secondary">
            Back to Status
          </button>
          <button
            onClick={handleUnloadAll}
            disabled={!running || unloadingAll}
            className={`btn ${!running || unloadingAll ? 'btn-secondary opacity-60 cursor-not-allowed' : 'btn-secondary'}`}
          >
            {unloadingAll ? 'Unloading All...' : 'Unload All'}
          </button>
        </div>
      </div>

      {!running ? (
        <div className="card">
          <div className="rounded-lg border p-4 text-sm" style={{ borderColor: 'var(--line-soft)', color: 'var(--text-muted)' }}>
            Start the runtime before using model controls or activity monitoring.
          </div>
        </div>
      ) : runtimeError ? (
        <div className="card">
          <div className="rounded-lg border p-4 text-sm" style={{ borderColor: 'var(--line-soft)', color: '#fda4af' }}>
            {runtimeError}
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
            <div className="card" style={{ padding: '1rem' }}>
              <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>Requests</div>
              <div className="text-2xl font-semibold mt-2">{formatNumber(completedCount)}</div>
              <div className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
                Waiting: {formatNumber(overview.inflight_total)}
              </div>
            </div>
            <div className="card" style={{ padding: '1rem' }}>
              <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>Processed</div>
              <div className="text-2xl font-semibold mt-2">{formatNumber(processedTokens)}</div>
              <div className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
                Prompt tokens
              </div>
            </div>
            <div className="card" style={{ padding: '1rem' }}>
              <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>Generated</div>
              <div className="text-2xl font-semibold mt-2">{formatNumber(generatedTokens)}</div>
              <div className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
                Completion tokens
              </div>
            </div>
            <div className="card" style={{ padding: '1rem' }}>
              <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>Token Stats</div>
              <div className="grid grid-cols-3 gap-2 mt-2 text-sm">
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>P50</div>
                  <div className="font-semibold mt-1">{formatSpeed(p50)}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>P95</div>
                  <div className="font-semibold mt-1">{formatSpeed(p95)}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>P99</div>
                  <div className="font-semibold mt-1">{formatSpeed(p99)}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 2xl:grid-cols-[0.95fr_1.35fr] gap-6">
            <div className="card mb-6 2xl:mb-0">
              <div className="flex items-center justify-between gap-4 mb-4">
                <div>
                  <h3 className="text-lg font-semibold">Models</h3>
                  <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                    Load and unload models directly from Ignite instead of opening the llama-swap UI.
                  </p>
                </div>
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Active: {activeModels.length}
                </div>
              </div>

              <div className="space-y-2">
                {models.map((model) => {
                  const isStopped = model.state === 'stopped'
                  const isReady = model.state === 'ready'
                  const stateTone = isReady ? '#34d399' : model.state === 'stopped' ? '#f87171' : '#fbbf24'
                  return (
                    <div
                      key={model.id}
                      className="rounded-lg border p-3 flex items-center justify-between gap-4"
                      style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}
                    >
                      <div className="min-w-0">
                        <div className="font-medium">{model.id}</div>
                        <div className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                          {model.name}
                          {Array.isArray(model.aliases) && model.aliases.length > 0 ? ` • Aliases: ${model.aliases.join(', ')}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className="text-xs uppercase tracking-[0.14em] px-2 py-1 rounded-full border"
                          style={{ color: stateTone, borderColor: 'var(--line-soft)' }}
                        >
                          {model.state}
                        </span>
                        {isStopped ? (
                          <button
                            onClick={() => handleModelLoad(model.id)}
                            disabled={loadingModelId === model.id}
                            className={`btn ${loadingModelId === model.id ? 'btn-secondary opacity-60 cursor-not-allowed' : 'btn-primary'}`}
                          >
                            {loadingModelId === model.id ? 'Loading...' : 'Load'}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleModelUnload(model.id)}
                            disabled={!isReady || unloadingModelId === model.id}
                            className={`btn ${!isReady || unloadingModelId === model.id ? 'btn-secondary opacity-60 cursor-not-allowed' : 'btn-secondary'}`}
                          >
                            {unloadingModelId === model.id ? 'Unloading...' : 'Unload'}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="card">
              <div className="flex items-center justify-between gap-4 mb-4">
                <div>
                  <h3 className="text-lg font-semibold">Activity</h3>
                  <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                    Recent request activity and capture access from the runtime metrics stream.
                  </p>
                </div>
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Showing {activity.length} most recent rows
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--line-soft)' }}>
                      <th className="text-left py-3 pr-3">ID</th>
                      <th className="text-left py-3 pr-3">Time</th>
                      <th className="text-left py-3 pr-3">Model</th>
                      <th className="text-left py-3 pr-3">Cached</th>
                      <th className="text-left py-3 pr-3">Prompt</th>
                      <th className="text-left py-3 pr-3">Generated</th>
                      <th className="text-left py-3 pr-3">Prompt Processing</th>
                      <th className="text-left py-3 pr-3">Generation Speed</th>
                      <th className="text-left py-3 pr-3">Duration</th>
                      <th className="text-left py-3">Capture</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.map((item) => (
                      <tr key={item.id} style={{ borderBottom: '1px solid rgba(148, 163, 184, 0.12)' }}>
                        <td className="py-3 pr-3">{item.id}</td>
                        <td className="py-3 pr-3">{formatTimeAgo(item.timestamp)}</td>
                        <td className="py-3 pr-3">{item.model}</td>
                        <td className="py-3 pr-3">{item.cache_tokens >= 0 ? formatNumber(item.cache_tokens) : '-'}</td>
                        <td className="py-3 pr-3">{formatNumber(item.input_tokens)}</td>
                        <td className="py-3 pr-3">{formatNumber(item.output_tokens)}</td>
                        <td className="py-3 pr-3">{Number(item.prompt_per_second) > 0 ? formatSpeed(item.prompt_per_second) : 'unknown'}</td>
                        <td className="py-3 pr-3">{Number(item.tokens_per_second) > 0 ? formatSpeed(item.tokens_per_second) : 'unknown'}</td>
                        <td className="py-3 pr-3">{formatDuration(item.duration_ms)}</td>
                        <td className="py-3">
                          {item.has_capture ? (
                            <button onClick={() => openCapture(item.id)} className="btn btn-secondary text-sm">
                              View
                            </button>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}

      {captureOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(2, 6, 23, 0.72)' }}
        >
          <div className="card w-full max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <h3 className="text-lg font-semibold">Capture {captureId}</h3>
                <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                  Decoded request and response payloads from the runtime, with raw JSON still available.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCaptureView('decoded')}
                  className={`px-3 py-1 rounded ${captureView === 'decoded' ? 'btn-primary text-white' : 'btn-secondary'}`}
                >
                  Decoded
                </button>
                <button
                  onClick={() => setCaptureView('raw')}
                  className={`px-3 py-1 rounded ${captureView === 'raw' ? 'btn-primary text-white' : 'btn-secondary'}`}
                >
                  Raw
                </button>
                <button onClick={() => setCaptureOpen(false)} className="btn btn-secondary">
                  Close
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)' }}>
              {captureLoading ? (
                <div style={{ color: 'var(--text-muted)' }}>Loading capture...</div>
              ) : captureError ? (
                <div style={{ color: '#fda4af' }}>{captureError}</div>
              ) : captureView === 'raw' ? (
                <pre className="text-sm whitespace-pre-wrap break-words">{JSON.stringify(captureData, null, 2)}</pre>
              ) : (
                <div className="space-y-6 text-sm">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                      <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>Request</div>
                      <div className="mt-3 space-y-2">
                        <div><span style={{ color: 'var(--text-muted)' }}>Path:</span> <span className="font-mono">{captureData?.req_path || '-'}</span></div>
                        <div><span style={{ color: 'var(--text-muted)' }}>Model:</span> <span className="font-mono">{decodedCapture.requestJson?.model || '-'}</span></div>
                        <div><span style={{ color: 'var(--text-muted)' }}>Max Tokens:</span> <span className="font-mono">{decodedCapture.requestJson?.max_tokens ?? '-'}</span></div>
                      </div>
                    </div>
                    <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                      <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>Response</div>
                      <div className="mt-3 space-y-2">
                        <div><span style={{ color: 'var(--text-muted)' }}>Status:</span> <span className="font-mono">{captureData?.resp_headers?.['Content-Type'] ? '200' : '-'}</span></div>
                        <div><span style={{ color: 'var(--text-muted)' }}>Runtime:</span> <span className="font-mono">{captureData?.resp_headers?.Server || '-'}</span></div>
                        <div><span style={{ color: 'var(--text-muted)' }}>Finish:</span> <span className="font-mono">{decodedCapture.responseJson?.choices?.[0]?.finish_reason || '-'}</span></div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                    <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>Input Messages</div>
                    <div className="mt-3 space-y-3">
                      {decodedCapture.requestMessages.length > 0 ? decodedCapture.requestMessages.map((message, index) => (
                        <div key={`${message.role || 'message'}-${index}`} className="rounded-lg border p-3" style={{ borderColor: 'rgba(148, 163, 184, 0.2)' }}>
                          <div className="text-xs uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>
                            {message.role || 'message'}
                          </div>
                          <div className="mt-2 whitespace-pre-wrap break-words">
                            {typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2)}
                          </div>
                        </div>
                      )) : (
                        <div style={{ color: 'var(--text-muted)' }}>No chat history found in the decoded request body.</div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                    <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>Assistant Output</div>
                    <div className="mt-3 whitespace-pre-wrap break-words">
                      {decodedCapture.responseMessage || decodedCapture.responseText || 'No decoded response body.'}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                      <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>Decoded Request JSON</div>
                      <pre className="mt-3 whitespace-pre-wrap break-words">
                        {decodedCapture.requestJson ? JSON.stringify(decodedCapture.requestJson, null, 2) : decodedCapture.requestText || 'Unable to decode request body.'}
                      </pre>
                    </div>
                    <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                      <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>Decoded Response JSON</div>
                      <pre className="mt-3 whitespace-pre-wrap break-words">
                        {decodedCapture.responseJson ? JSON.stringify(decodedCapture.responseJson, null, 2) : decodedCapture.responseText || 'Unable to decode response body.'}
                      </pre>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default RuntimePage
