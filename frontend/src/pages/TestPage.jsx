import React, { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

const TEST_STATE_KEY = 'ignite_test_state_v2'
const PLAYGROUND_TABS = [
  { key: 'chat', label: 'Chat + Vision' },
  { key: 'speech', label: 'Speech' },
]

function splitThinkingBlocks(text) {
  if (!text) return { answer: '', thinkingBlocks: [] }

  const thinkingBlocks = []
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi
  let match

  while ((match = thinkRegex.exec(text)) !== null) {
    const content = (match[1] || '').trim()
    if (content) thinkingBlocks.push(content)
  }

  const answer = text.replace(thinkRegex, '').trim()
  return { answer, thinkingBlocks }
}

function TestPage() {
  const [searchParams] = useSearchParams()
  const [activeTab, setActiveTab] = useState(searchParams.get('speech') === '1' ? 'speech' : 'chat')

  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [imageDataUrl, setImageDataUrl] = useState('')
  const [imageName, setImageName] = useState('')
  const [models, setModels] = useState({})
  const [response, setResponse] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [loading, setLoading] = useState(false)
  const [tokens, setTokens] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState('')
  const [meta, setMeta] = useState(null)

  const [speechModels, setSpeechModels] = useState([])
  const [speechError, setSpeechError] = useState('')
  const [speechLoading, setSpeechLoading] = useState(true)
  const [ttsModel, setTtsModel] = useState('')
  const [ttsVoice, setTtsVoice] = useState('')
  const [ttsInput, setTtsInput] = useState('')
  const [ttsVoices, setTtsVoices] = useState([])
  const [ttsLoading, setTtsLoading] = useState(false)
  const [ttsAudioUrl, setTtsAudioUrl] = useState('')
  const [sttModel, setSttModel] = useState('')
  const [sttFile, setSttFile] = useState(null)
  const [sttLoading, setSttLoading] = useState(false)
  const [sttResult, setSttResult] = useState('')

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(TEST_STATE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw)
      setActiveTab(saved.activeTab || (searchParams.get('speech') === '1' ? 'speech' : 'chat'))
      setPrompt(saved.prompt || '')
      setModel(saved.model || '')
      setResponse(saved.response || '')
      setReasoning(saved.reasoning || '')
      setTokens(saved.tokens || 0)
      setDuration(saved.duration || 0)
      setError(saved.error || '')
      setMeta(saved.meta || null)
      setTtsInput(saved.ttsInput || '')
      setTtsModel(saved.ttsModel || '')
      setTtsVoice(saved.ttsVoice || '')
      setSttModel(saved.sttModel || '')
      setSttResult(saved.sttResult || '')
    } catch {
      // Ignore invalid stored data
    }
  }, [searchParams])

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        setModels(data.models || {})
        const keys = Object.keys(data.models || {})
        const requestedModel = (searchParams.get('model') || '').trim()
        if (requestedModel && keys.includes(requestedModel)) {
          setModel(requestedModel)
          return
        }
        if (keys.length > 0 && !model) setModel(keys[0])
      })
      .catch(() => {})
  }, [searchParams, model])

  useEffect(() => {
    const loadSpeechModels = async () => {
      try {
        setSpeechLoading(true)
        const response = await fetch('/api/speech/models')
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.detail || 'Failed to load speech models')
        const installed = Array.isArray(data.data) ? data.data : []
        setSpeechModels(installed)
        const tts = installed.filter((item) => item.task === 'text-to-speech')
        const stt = installed.filter((item) => item.task === 'automatic-speech-recognition')
        if (!ttsModel && tts[0]?.id) setTtsModel(tts[0].id)
        if (!sttModel && stt[0]?.id) setSttModel(stt[0].id)
        setSpeechError('')
      } catch (err) {
        setSpeechModels([])
        setSpeechError(err.message || 'Failed to load speech models')
      } finally {
        setSpeechLoading(false)
      }
    }

    loadSpeechModels()
  }, [ttsModel, sttModel])

  useEffect(() => {
    const payload = {
      activeTab,
      prompt,
      model,
      response,
      reasoning,
      tokens,
      duration,
      error,
      meta,
      ttsInput,
      ttsModel,
      ttsVoice,
      sttModel,
      sttResult,
    }
    sessionStorage.setItem(TEST_STATE_KEY, JSON.stringify(payload))
  }, [activeTab, prompt, model, response, reasoning, tokens, duration, error, meta, ttsInput, ttsModel, ttsVoice, sttModel, sttResult])

  useEffect(() => {
    const loadVoices = async () => {
      if (!ttsModel) {
        setTtsVoices([])
        return
      }
      try {
        const response = await fetch(`/api/speech/voices?model=${encodeURIComponent(ttsModel)}`)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.detail || 'Failed to load voices')
        const voices = Array.isArray(data.voices) ? data.voices : []
        setTtsVoices(voices)
        if (!voices.some((voice) => voice.id === ttsVoice) && voices[0]?.id) {
          setTtsVoice(voices[0].id)
        }
      } catch {
        setTtsVoices([])
      }
    }

    loadVoices()
  }, [ttsModel, ttsVoice])

  const handleSubmit = async () => {
    if (!prompt.trim() || !model) return

    try {
      setLoading(true)
      setResponse('')
      setReasoning('')
      setError('')
      setMeta(null)

      const res = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, model, image_data_url: imageDataUrl })
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || `HTTP ${res.status}`)
      }

      const data = await res.json()
      setResponse(data.response)
      setReasoning(data.reasoning || '')
      setTokens(data.tokens)
      setDuration(data.duration_ms)
      setMeta({
        model: data.model,
        finish_reason: data.finish_reason,
        id: data.id,
        system_fingerprint: data.system_fingerprint,
        created: data.created,
        request_mode: data.request_mode,
        usage: data.usage || {},
        timings: data.timings || {}
      })
    } catch (err) {
      setError(err.message || 'Failed to send prompt. Make sure llama-swap is running.')
    } finally {
      setLoading(false)
    }
  }

  const handleTtsSubmit = async () => {
    if (!ttsModel || !ttsInput.trim()) return
    try {
      setTtsLoading(true)
      setSpeechError('')
      setTtsAudioUrl('')
      const response = await fetch('/api/speech/test/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ttsModel, voice: ttsVoice || undefined, input: ttsInput })
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.detail || 'Failed to synthesize speech')
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      setTtsAudioUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous)
        return url
      })
    } catch (err) {
      setSpeechError(err.message || 'Failed to synthesize speech')
    } finally {
      setTtsLoading(false)
    }
  }

  const handleSttSubmit = async () => {
    if (!sttModel || !sttFile) return
    try {
      setSttLoading(true)
      setSpeechError('')
      setSttResult('')
      const formData = new FormData()
      formData.append('model', sttModel)
      formData.append('file', sttFile)
      const response = await fetch('/api/speech/test/stt', {
        method: 'POST',
        body: formData
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.detail || 'Failed to transcribe audio')
      setSttResult(data.text || JSON.stringify(data, null, 2))
    } catch (err) {
      setSpeechError(err.message || 'Failed to transcribe audio')
    } finally {
      setSttLoading(false)
    }
  }

  const modelKeys = Object.keys(models)
  const selectedModelMode = models[model]?.metadata?.igniteTemplateMode || 'chat'
  const { answer, thinkingBlocks } = splitThinkingBlocks(response)
  const reasoningText = reasoning.trim()
  const hasThinking = reasoningText.length > 0 || thinkingBlocks.length > 0
  const hasResult = response.trim().length > 0 || reasoningText.length > 0
  const hasImage = imageDataUrl.length > 0
  const ttsModels = speechModels.filter((item) => item.task === 'text-to-speech')
  const sttModels = speechModels.filter((item) => item.task === 'automatic-speech-recognition')

  const handleImageChange = async (event) => {
    const file = event.target.files?.[0]
    if (!file) {
      setImageDataUrl('')
      setImageName('')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      setImageDataUrl(result)
      setImageName(file.name)
    }
    reader.onerror = () => {
      setError('Failed to read image file.')
      setImageDataUrl('')
      setImageName('')
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Playground</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Use installed LLM, vision, STT, and TTS models from one place.
          </p>
        </div>
        <div className="inline-flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--line-soft)' }}>
          {PLAYGROUND_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className="px-3 py-2 text-sm"
              style={{ background: activeTab === tab.key ? 'var(--line-soft)' : 'transparent' }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'chat' && (
        <>
          <div className="card mb-6">
            <div className="mb-4">
              <label className="block text-sm font-medium mb-1">Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700"
              >
                {modelKeys.length === 0 && <option value="">No models configured</option>}
                {modelKeys.map(key => (
                  <option key={key} value={key}>
                    {key} — {models[key].name}
                  </option>
                ))}
              </select>
              {model && (
                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                  Request mode: {selectedModelMode === 'completion' ? 'Completion' : 'Chat'}
                </p>
              )}
            </div>

            {model && selectedModelMode === 'completion' && (
              <div className="mb-4 rounded-lg border p-3 text-sm" style={{ borderColor: 'rgba(245, 158, 11, 0.35)', background: 'rgba(245, 158, 11, 0.10)' }}>
                <p className="font-medium mb-1">Completion model</p>
                <p style={{ color: 'var(--text-muted)' }}>
                  This model is better for code or text continuation than normal chat. Use a code prefix, unfinished function, or partial paragraph instead of a conversational prompt like "hi".
                </p>
              </div>
            )}

            {model && selectedModelMode !== 'completion' && (
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">Image</label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleImageChange}
                  className="w-full px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700"
                />
                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                  Optional. Add an image to test a vision-capable chat model with text and image input together.
                </p>
                {hasImage && (
                  <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div className="text-sm font-medium">{imageName || 'Selected image'}</div>
                      <button
                        type="button"
                        onClick={() => {
                          setImageDataUrl('')
                          setImageName('')
                        }}
                        className="btn btn-secondary text-sm"
                      >
                        Remove Image
                      </button>
                    </div>
                    <img src={imageDataUrl} alt={imageName || 'Selected test image'} className="max-h-72 rounded-lg border" style={{ borderColor: 'var(--line-soft)' }} />
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium mb-1">Prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={selectedModelMode === 'completion' ? 'Enter a completion prompt or code prefix...' : (hasImage ? 'Ask about the image or combine image + text instructions...' : 'Enter your prompt here...')}
                rows={4}
                className="w-full px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 resize-none"
              />
            </div>

            <button onClick={handleSubmit} disabled={loading || (!prompt.trim() && !hasImage) || !model} className="btn btn-primary mt-4">
              {loading ? 'Generating...' : 'Send Prompt'}
            </button>
          </div>

          {error && (
            <div className="card mb-6 border border-red-500">
              <p className="text-red-500 text-sm">{error}</p>
            </div>
          )}

          {hasResult && (
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">Response</h3>
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {tokens} tokens • {duration}ms
                </div>
              </div>

              {hasThinking && (
                <details className="mb-4 rounded-lg border dark:border-gray-600 p-3" open>
                  <summary className="cursor-pointer font-medium">Thinking</summary>
                  <div className="mt-3 space-y-3">
                    {reasoningText && (
                      <pre className="whitespace-pre-wrap text-sm rounded p-3 border" style={{ background: 'rgba(148, 163, 184, 0.08)', borderColor: 'var(--line-soft)' }}>
                        {reasoningText}
                      </pre>
                    )}
                    {!reasoningText && thinkingBlocks.map((block, index) => (
                      <pre key={index} className="whitespace-pre-wrap text-sm rounded p-3 border" style={{ background: 'rgba(148, 163, 184, 0.08)', borderColor: 'var(--line-soft)' }}>
                        {block}
                      </pre>
                    ))}
                  </div>
                </details>
              )}

              <div className="prose dark:prose-invert max-w-none">
                <p className="whitespace-pre-wrap">{answer || response || 'No final answer content returned.'}</p>
              </div>

              {meta && (
                <div className="mt-6 border-t pt-4" style={{ borderColor: 'var(--line-soft)' }}>
                  <h4 className="text-sm font-semibold mb-3">Run Stats</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                    <div><span style={{ color: 'var(--text-muted)' }}>Model:</span> {meta.model || '-'}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Finish reason:</span> {meta.finish_reason || '-'}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Prompt tokens:</span> {meta.usage.prompt_tokens ?? '-'}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Completion tokens:</span> {meta.usage.completion_tokens ?? '-'}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Total tokens:</span> {meta.usage.total_tokens ?? '-'}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Prompt ms:</span> {meta.timings.prompt_ms ?? '-'}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Predicted tokens:</span> {meta.timings.predicted_n ?? '-'}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Predicted ms:</span> {meta.timings.predicted_ms ?? '-'}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Tokens/sec:</span> {meta.timings.predicted_per_second ?? '-'}</div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Request mode:</span> {meta.request_mode || selectedModelMode}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {activeTab === 'speech' && (
        <div className="space-y-6">
          {speechError && (
            <div className="card border border-red-500">
              <p className="text-red-500 text-sm">{speechError}</p>
            </div>
          )}

          <div className="card">
            <h3 className="text-lg font-semibold mb-4">Text To Speech</h3>
            {speechLoading ? (
              <p style={{ color: 'var(--text-muted)' }}>Loading speech models...</p>
            ) : ttsModels.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>No TTS models installed. Install one from Discover.</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">TTS Model</label>
                  <select value={ttsModel} onChange={(e) => setTtsModel(e.target.value)} className="w-full px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700">
                    {ttsModels.map((item) => (
                      <option key={item.id} value={item.id}>{item.id}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Voice</label>
                  <select value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)} className="w-full px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700">
                    {ttsVoices.length === 0 && <option value="">No voices loaded</option>}
                    {ttsVoices.map((voice) => (
                      <option key={voice.id} value={voice.id}>{voice.id}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Input</label>
                  <textarea value={ttsInput} onChange={(e) => setTtsInput(e.target.value)} rows={4} className="w-full px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 resize-none" placeholder="Type text to synthesize..." />
                </div>
                <button onClick={handleTtsSubmit} disabled={ttsLoading || !ttsModel || !ttsInput.trim()} className="btn btn-primary">
                  {ttsLoading ? 'Generating Audio...' : 'Generate Speech'}
                </button>
                {ttsAudioUrl && (
                  <div className="space-y-3">
                    <audio controls src={ttsAudioUrl} className="w-full" />
                    <a
                      href={ttsAudioUrl}
                      download={`${(ttsModel || 'speech').replace(/[^A-Za-z0-9._-]+/g, '-')}.mp3`}
                      className="btn btn-secondary inline-flex text-sm"
                    >
                      Download Audio
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <h3 className="text-lg font-semibold mb-4">Speech To Text</h3>
            {speechLoading ? (
              <p style={{ color: 'var(--text-muted)' }}>Loading speech models...</p>
            ) : sttModels.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>No STT models installed. Install one from Discover.</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">STT Model</label>
                  <select value={sttModel} onChange={(e) => setSttModel(e.target.value)} className="w-full px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700">
                    {sttModels.map((item) => (
                      <option key={item.id} value={item.id}>{item.id}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Audio File</label>
                  <input type="file" accept="audio/*" onChange={(e) => setSttFile(e.target.files?.[0] || null)} className="w-full px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700" />
                </div>
                <button onClick={handleSttSubmit} disabled={sttLoading || !sttModel || !sttFile} className="btn btn-primary">
                  {sttLoading ? 'Transcribing...' : 'Transcribe Audio'}
                </button>
                {sttResult && (
                  <div className="rounded-lg border p-3 text-sm whitespace-pre-wrap" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                    {sttResult}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default TestPage
