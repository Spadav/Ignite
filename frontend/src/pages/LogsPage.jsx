import React, { useEffect, useState } from 'react'
import { useServiceStatus } from '../hooks/useServiceStatus'

function LogsPage() {
  const { runtimeMode } = useServiceStatus(15000)
  const [proxyLogs, setProxyLogs] = useState([])
  const [upstreamLogs, setUpstreamLogs] = useState([])
  const [logTab, setLogTab] = useState('proxy')
  const [dockerLogTab, setDockerLogTab] = useState('runtime')
  const [dockerLogs, setDockerLogs] = useState([])
  const [dockerLogError, setDockerLogError] = useState('')

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

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Logs</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Runtime events and container output for troubleshooting.
          </p>
        </div>
      </div>

      <div className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Runtime Streams</h3>
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
              No runtime logs yet. Trigger a model request to populate this stream.
            </div>
          ) : (
            visibleLogs.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap">{line}</div>
            ))
          )}
        </div>
      </div>

      {runtimeMode === 'docker' && (
        <div className="card">
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

export default LogsPage
