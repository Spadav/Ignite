import React, { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useModels } from '../hooks/useModels'

function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return 'Unknown size'
  const gb = bytes / (1024 ** 3)
  return `${gb.toFixed(2)} GiB`
}

function formatDate(isoDate) {
  if (!isoDate) return '-'
  try {
    return new Date(isoDate).toLocaleString()
  } catch {
    return isoDate
  }
}

function ModelsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { models, loading, error, refreshModels } = useModels()
  const [repoId, setRepoId] = useState('')
  const [repoFiles, setRepoFiles] = useState([])
  const [repoLoading, setRepoLoading] = useState(false)
  const [repoError, setRepoError] = useState('')
  const [selectedFilePath, setSelectedFilePath] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')
  const [downloadFilename, setDownloadFilename] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [configMessage, setConfigMessage] = useState(null)
  const [configuringModel, setConfiguringModel] = useState('')
  const [autoLoadedRepo, setAutoLoadedRepo] = useState('')
  const [lastDownloadedModel, setLastDownloadedModel] = useState('')
  const [presetPicker, setPresetPicker] = useState(null)
  const [presetLoading, setPresetLoading] = useState(false)

  const handleDelete = async (filename) => {
    if (!confirm(`Delete ${filename}?`)) return
    
    try {
      await fetch(`/api/models/${filename}`, { method: 'DELETE' })
      refreshModels()
    } catch (error) {
      alert('Failed to delete model')
    }
  }

  const startDownload = async (url, filename) => {
    if (!url || !filename) return

    setDownloading(true)
    setProgress(0)
    setConfigMessage(null)
    
    try {
      const response = await fetch('/api/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, filename })
      })
      if (!response.ok) throw new Error('Failed to start download')
      const data = await response.json()

      const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${wsProtocol}://${window.location.host}/ws/download/${data.task_id}`)
      
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.progress !== undefined) {
          setProgress(message.progress)
        }
        if (message.status === 'completed') {
          setDownloading(false)
          setProgress(0)
          setLastDownloadedModel(filename)
          refreshModels()
        }
        if (message.status === 'error') {
          setDownloading(false)
          alert(`Download failed: ${message.error}`)
        }
      }
      
      ws.onclose = () => {
        setDownloading(false)
      }
      
    } catch (error) {
      setDownloading(false)
      alert('Failed to start download')
    }
  }

  const handleDownload = async () => {
    await startDownload(downloadUrl, downloadFilename)
  }

  const submitAddToConfig = async (filename, presetId) => {
    try {
      setConfiguringModel(filename)
      setConfigMessage(null)
      const response = await fetch('/api/config/add-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, preset_id: presetId })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.detail || 'Failed to add model to config')
      setConfigMessage({
        type: 'success',
        text: `Added ${data.model_id} to config using the ${data.preset_id} preset`,
        modelId: data.model_id
      })
      setPresetPicker(null)
    } catch (error) {
      setConfigMessage({
        type: 'error',
        text: error.message || 'Failed to add model to config'
      })
    } finally {
      setConfiguringModel('')
    }
  }

  const handleAddToConfig = async (filename) => {
    try {
      setPresetLoading(true)
      setConfigMessage(null)
      const response = await fetch(`/api/models/${encodeURIComponent(filename)}/presets`)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.detail || 'Failed to load presets')
      setPresetPicker({
        filename,
        presets: data.presets || [],
        hardware: data.hardware || null,
      })
    } catch (error) {
      setConfigMessage({
        type: 'error',
        text: error.message || 'Failed to load model presets'
      })
    } finally {
      setPresetLoading(false)
    }
  }

  const fetchRepoFiles = async (repoOverride) => {
    const resolvedRepo = (repoOverride ?? repoId).trim()
    if (!resolvedRepo) return
    try {
      setRepoLoading(true)
      setRepoError('')
      setRepoFiles([])
      setSelectedFilePath('')
      const response = await fetch(`/api/hf/repo-files?repo_id=${encodeURIComponent(resolvedRepo)}`)
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Failed to fetch repository files')
      setRepoFiles(data.files || [])
      if ((data.files || []).length === 0) {
        setRepoError('No GGUF files found in this repository')
      }
    } catch (error) {
      setRepoError(error.message || 'Failed to fetch repository files')
    } finally {
      setRepoLoading(false)
    }
  }

  useEffect(() => {
    const repoFromQuery = (searchParams.get('repo') || '').trim()
    if (!repoFromQuery || repoFromQuery === autoLoadedRepo) return
    setRepoId(repoFromQuery)
    setAutoLoadedRepo(repoFromQuery)
    fetchRepoFiles(repoFromQuery)
  }, [searchParams, autoLoadedRepo])

  const handleRepoDownload = async () => {
    const file = repoFiles.find(f => f.path === selectedFilePath)
    if (!file) return
    await startDownload(file.download_url, file.filename)
  }

  const handleGoToTest = (modelId) => {
    const params = new URLSearchParams()
    if (modelId) params.set('model', modelId)
    navigate(`/test${params.toString() ? `?${params.toString()}` : ''}`)
  }

  return (
    <div className="p-6">
      <h2 className="text-2xl font-semibold tracking-tight mb-6">Model Management</h2>

      {presetPicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(8, 10, 14, 0.7)' }}
          onClick={() => setPresetPicker(null)}
        >
          <div
            className="card w-full max-w-5xl max-h-[85vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h3 className="text-xl font-semibold">Choose Launch Profile</h3>
                <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                  Ignite generated these presets for {presetPicker.filename} using your detected hardware.
                </p>
              </div>
              <button
                onClick={() => setPresetPicker(null)}
                className="px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--line-soft)' }}
              >
                Close
              </button>
            </div>

            {presetPicker.hardware?.gpu && (
              <div className="mb-4 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                GPU VRAM: {presetPicker.hardware.gpu.available ? `${presetPicker.hardware.gpu.memory_total_gb} GiB` : 'Not detected'} • Runtime: {presetPicker.hardware.runtime_mode}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {presetPicker.presets.map((preset) => (
                <div
                  key={preset.id}
                  className="rounded-lg border p-4 space-y-3"
                  style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}
                >
                  <div>
                    <h4 className="text-lg font-semibold">{preset.name}</h4>
                    <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                      {preset.summary}
                    </p>
                  </div>
                  <div className="text-sm space-y-1">
                    <div><span style={{ color: 'var(--text-muted)' }}>Context:</span> {preset.context}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>GPU layers:</span> {preset.gpu_layers}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Flash attention:</span> {preset.flash_attention ? 'On' : 'Off'}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Template mode:</span> {preset.template_mode}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>KV cache:</span> {preset.kv_cache ? `${preset.kv_cache.k} / ${preset.kv_cache.v}` : 'Default'}</div>
                  </div>
                  <div className="text-sm">
                    <p><span className="font-medium">Why use:</span> {preset.why_use}</p>
                    <p className="mt-2"><span className="font-medium">Why not:</span> {preset.why_not}</p>
                  </div>
                  <button
                    onClick={() => submitAddToConfig(presetPicker.filename, preset.id)}
                    disabled={configuringModel === presetPicker.filename}
                    className="btn btn-primary text-sm w-full"
                  >
                    {configuringModel === presetPicker.filename ? 'Adding...' : `Use ${preset.name}`}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      
      <div className="mb-6 card">
        <h3 className="text-lg font-semibold mb-4">Download Model</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Hugging Face Repository</label>
            <input
              type="text"
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              placeholder="unsloth/Qwen3.5-35B-A3B-GGUF"
              className="w-full px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700"
            />
          </div>
          <button
            onClick={fetchRepoFiles}
            disabled={repoLoading || downloading || !repoId.trim()}
            className="btn btn-secondary"
          >
            {repoLoading ? 'Loading files...' : 'Load GGUF Files'}
          </button>

          {repoError && (
            <p className="text-sm text-red-500">{repoError}</p>
          )}

          {repoFiles.length > 0 && (
            <div>
              <label className="block text-sm font-medium mb-1">GGUF File</label>
              <select
                value={selectedFilePath}
                onChange={(e) => setSelectedFilePath(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700"
              >
                <option value="">Select a file...</option>
                {repoFiles.map((file) => (
                  <option key={file.path} value={file.path}>
                    {file.path} ({formatSize(file.size_bytes)})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <button
              onClick={handleRepoDownload}
              disabled={downloading || !selectedFilePath}
              className="btn btn-primary"
            >
              {downloading ? 'Downloading...' : 'Download Selected File'}
            </button>
          </div>

          <details className="rounded-lg border dark:border-gray-600 p-3">
            <summary className="cursor-pointer text-sm font-medium">Advanced: Direct URL</summary>
            <div className="space-y-3 mt-3">
              <div>
                <label className="block text-sm font-medium mb-1">Direct URL</label>
                <input
                  type="url"
                  value={downloadUrl}
                  onChange={(e) => setDownloadUrl(e.target.value)}
                  placeholder="https://huggingface.co/.../resolve/main/model.gguf?download=true"
                  className="w-full px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Save As Filename</label>
                <input
                  type="text"
                  value={downloadFilename}
                  onChange={(e) => setDownloadFilename(e.target.value)}
                  placeholder="model.gguf"
                  className="w-full px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700"
                />
              </div>
              <button
                onClick={handleDownload}
                disabled={downloading || !downloadUrl || !downloadFilename}
                className="btn btn-secondary"
              >
                Start Direct Download
              </button>
            </div>
          </details>

          {downloading && (
            <div className="w-full rounded-full h-2" style={{ background: 'var(--line-soft)' }}>
              <div
                className="h-2 rounded-full transition-all"
                style={{ width: `${progress}%`, background: 'var(--brand)' }}
              />
            </div>
          )}

          {lastDownloadedModel && !downloading && (
            <div
              className="rounded-lg border p-4 space-y-3"
              style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}
            >
              <div>
                <p className="font-medium">Downloaded: {lastDownloadedModel}</p>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Next step: add it to the llama-swap config, then open Test.
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => handleAddToConfig(lastDownloadedModel)}
                  disabled={configuringModel === lastDownloadedModel || presetLoading}
                  className="btn btn-primary text-sm"
                >
                  {presetLoading ? 'Loading presets...' : configuringModel === lastDownloadedModel ? 'Adding...' : 'Choose Launch Profile'}
                </button>
                <button
                  onClick={() => handleGoToTest(configMessage?.modelId || '')}
                  className="btn btn-secondary text-sm"
                >
                  Go to Test
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Installed Models</h3>
          <button onClick={refreshModels} className="btn btn-secondary text-sm">
            Refresh
          </button>
        </div>
        
        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading...</p>
        ) : error ? (
          <p className="text-red-500">Error: {error}</p>
        ) : models.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No models installed</p>
        ) : (
          <div className="space-y-2">
            {configMessage && (
              <div
                className={`px-3 py-2 rounded-lg text-sm border ${
                  configMessage.type === 'success' ? 'text-green-700' : 'text-red-700'
                }`}
                style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span>{configMessage.text}</span>
                  {configMessage.type === 'success' && configMessage.modelId && (
                    <button
                      onClick={() => handleGoToTest(configMessage.modelId)}
                      className="btn btn-secondary text-sm"
                    >
                      Open in Test
                    </button>
                  )}
                </div>
              </div>
            )}
            {models.map((model) => (
              <div
                key={model.filename}
                className="flex items-center justify-between gap-3 p-3 rounded-lg border"
                style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}
              >
                <div>
                  <p className="font-medium">{model.filename}</p>
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    {model.size_gb} GiB • {formatDate(model.modified)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleAddToConfig(model.filename)}
                    disabled={configuringModel === model.filename || presetLoading}
                    className="btn btn-secondary text-sm"
                  >
                    {presetLoading ? 'Loading presets...' : configuringModel === model.filename ? 'Adding...' : 'Add to Config'}
                  </button>
                  <button
                    onClick={() => handleDelete(model.filename)}
                    className="btn btn-danger text-sm"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default ModelsPage
