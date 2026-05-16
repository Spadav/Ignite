import React, { useEffect, useState } from 'react'

function statusTone(status) {
  switch (status) {
    case 'up_to_date':
      return { bg: 'rgba(34, 197, 94, 0.14)', border: 'rgba(34, 197, 94, 0.35)', text: '#bbf7d0', label: 'Up to Date' }
    case 'update_available':
      return { bg: 'rgba(245, 158, 11, 0.14)', border: 'rgba(245, 158, 11, 0.35)', text: '#fde68a', label: 'Update Available' }
    case 'upstream_ahead':
      return { bg: 'rgba(245, 158, 11, 0.14)', border: 'rgba(245, 158, 11, 0.35)', text: '#fde68a', label: 'Upstream Ahead' }
    case 'ahead_or_custom':
      return { bg: 'rgba(59, 130, 246, 0.14)', border: 'rgba(59, 130, 246, 0.35)', text: '#bfdbfe', label: 'Ahead / Custom' }
    case 'floating_image':
      return { bg: 'rgba(148, 163, 184, 0.14)', border: 'rgba(148, 163, 184, 0.35)', text: '#cbd5e1', label: 'Tracks Latest On Pull' }
    case 'local_app':
      return { bg: 'rgba(168, 85, 247, 0.14)', border: 'rgba(168, 85, 247, 0.35)', text: '#e9d5ff', label: 'App Layer' }
    case 'runtime_offline':
      return { bg: 'rgba(148, 163, 184, 0.14)', border: 'rgba(148, 163, 184, 0.35)', text: '#cbd5e1', label: 'Runtime Offline' }
    case 'docker_unavailable':
      return { bg: 'rgba(239, 68, 68, 0.14)', border: 'rgba(239, 68, 68, 0.35)', text: '#fecaca', label: 'Docker Unavailable' }
    case 'probe_failed':
      return { bg: 'rgba(239, 68, 68, 0.14)', border: 'rgba(239, 68, 68, 0.35)', text: '#fecaca', label: 'Version Check Failed' }
    default:
      return { bg: 'rgba(148, 163, 184, 0.14)', border: 'rgba(148, 163, 184, 0.35)', text: '#cbd5e1', label: 'Unknown' }
  }
}

function UpdatesPage() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [actionRunning, setActionRunning] = useState('')
  const [actionResult, setActionResult] = useState(null)

  const loadUpdates = async (refresh = false) => {
    try {
      if (refresh) setChecking(true)
      else setLoading(true)
      setError('')

      const response = await fetch(`/api/updates${refresh ? '?refresh=true' : ''}`)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.detail || 'Failed to load update data')
      setData(payload)
    } catch (err) {
      setError(err.message || 'Failed to load update data')
    } finally {
      setLoading(false)
      setChecking(false)
    }
  }

  useEffect(() => {
    loadUpdates(true)
  }, [])

  const runUpdateAction = async (component) => {
    if (!component?.update_action || component.update_available_in_ui === false) return
    const action = component.update_action
    try {
      setActionRunning(component.id)
      setActionResult(null)
      setError('')
      const response = await fetch(`/api/updates/actions/${encodeURIComponent(action)}`, { method: 'POST' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.detail || `Failed to update ${component.name}`)
      setActionResult(payload)
      await loadUpdates(true)
    } catch (err) {
      setError(err.message || `Failed to update ${component.name}`)
    } finally {
      setActionRunning('')
    }
  }

  if (loading) return <p className="p-6">Loading...</p>

  return (
    <div className="p-6">
      <div className="flex items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Updates</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Check and refresh the services Ignite is using without running terminal commands.
          </p>
        </div>
        <button onClick={() => loadUpdates(true)} disabled={checking} className="btn btn-primary">
          {checking ? 'Checking...' : 'Check For Updates'}
        </button>
      </div>

      {error && (
        <div className="mb-4 px-4 py-2 rounded-lg text-sm border bg-red-100 text-red-800" style={{ borderColor: 'var(--line-soft)' }}>
          {error}
        </div>
      )}

      {actionResult && (
        <div className="mb-4 px-4 py-3 rounded-lg text-sm border" style={{ borderColor: 'rgba(34, 197, 94, 0.35)', background: 'rgba(34, 197, 94, 0.14)', color: '#bbf7d0' }}>
          <div className="font-semibold">{actionResult.title || 'Update complete'}</div>
          <div className="mt-1">{actionResult.message || 'The selected service was refreshed.'}</div>
          {actionResult.versions?.llama_cpp_version && (
            <div className="font-mono mt-2">llama.cpp: {actionResult.versions.llama_cpp_version}</div>
          )}
        </div>
      )}

      {data?.runtime_notice && (
        <div className="mb-4 px-4 py-3 rounded-lg text-sm border" style={{ borderColor: 'var(--line-soft)', background: 'rgba(245, 158, 11, 0.14)', color: '#fde68a' }}>
          <div className="font-medium mb-1">Runtime version check incomplete</div>
          <div>{data.runtime_notice.message}</div>
          <div className="mt-2" style={{ color: 'var(--text-muted)' }}>
            Upstream check still ran. Start the runtime if you want Ignite to read the exact installed `llama-swap` and `llama.cpp` versions.
          </div>
        </div>
      )}

      <div className="card mb-6">
        <h3 className="text-lg font-semibold mb-2">Safe Update Buttons</h3>
        <div className="space-y-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          <div>- Update Runtime refreshes the llama.cpp image currently selected in Settings, rebuilds the runtime wrapper, and restarts only the model runtime.</div>
          <div>- Update Speech refreshes the selected Speaches CPU/CUDA image and restarts the speech service.</div>
          <div>- Update llmfit refreshes the recommendation service image and restarts that service.</div>
          <div>- Your model files and config folders are mounted volumes; these update actions do not delete them.</div>
        </div>
        {data?.checked_at && (
          <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
            Last checked: {new Date(data.checked_at).toLocaleString()}
          </p>
        )}
      </div>

      <div className="space-y-4">
        {(data?.components || []).map((component) => {
          const tone = statusTone(component.status)
          return (
            <div key={component.id} className="card">
              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  <h3 className="text-lg font-semibold">{component.name}</h3>
                  <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                    {component.summary}
                  </p>
                </div>
                <div
                  className="px-3 py-1 rounded-full text-xs font-semibold border"
                  style={{ background: tone.bg, borderColor: tone.border, color: tone.text }}
                >
                  {tone.label}
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                  <div className="text-sm font-medium">Current</div>
                  <div className="font-mono text-sm mt-1 break-all">{component.current || 'Unknown'}</div>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                  <div className="text-sm font-medium">Latest Upstream</div>
                  <div className="font-mono text-sm mt-1 break-all">{component.latest || 'Not available'}</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 mb-4">
                {component.update_available_in_ui !== false && component.update_action ? (
                  <button
                    onClick={() => runUpdateAction(component)}
                    disabled={Boolean(actionRunning)}
                    className="btn btn-primary text-sm"
                  >
                    {actionRunning === component.id ? 'Updating...' : `Update ${component.name}`}
                  </button>
                ) : (
                  <button className="btn btn-secondary text-sm" disabled title={component.update_disabled_reason || 'Not available yet'}>
                    Update Not Automated
                  </button>
                )}
                <a href={component.changelog_url} target="_blank" rel="noreferrer" className="btn btn-secondary text-sm">
                  Open Changelog
                </a>
                <a href={component.release_url} target="_blank" rel="noreferrer" className="btn btn-secondary text-sm">
                  Open Upstream
                </a>
              </div>
              {component.update_available_in_ui === false && component.update_disabled_reason && (
                <div className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
                  {component.update_disabled_reason}
                </div>
              )}

              {(component.update_script || (component.manual_update || []).length > 0) && (
                <details className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                  <summary className="text-sm font-semibold cursor-pointer">Advanced: show commands</summary>
                  <div className="font-mono text-sm rounded-lg border p-3 my-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                    {component.update_script || 'No script available'}
                  </div>
                  {(component.manual_update || []).length > 0 && (
                    <div className="space-y-2">
                      {(component.manual_update || []).map((line, index) => (
                        <div key={index} className="font-mono text-sm rounded-lg border p-3 break-all" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.04)' }}>
                          {line}
                        </div>
                      ))}
                    </div>
                  )}
                </details>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default UpdatesPage
