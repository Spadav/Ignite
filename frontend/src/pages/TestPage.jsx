import React, { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

const TEST_STATE_KEY = 'ignite_test_state_v1'

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
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState({})
  const [response, setResponse] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [loading, setLoading] = useState(false)
  const [tokens, setTokens] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState('')
  const [meta, setMeta] = useState(null)

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(TEST_STATE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw)
      setPrompt(saved.prompt || '')
      setModel(saved.model || '')
      setResponse(saved.response || '')
      setReasoning(saved.reasoning || '')
      setTokens(saved.tokens || 0)
      setDuration(saved.duration || 0)
      setError(saved.error || '')
      setMeta(saved.meta || null)
    } catch {
      // Ignore invalid stored data
    }
  }, [])

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
    const payload = {
      prompt,
      model,
      response,
      reasoning,
      tokens,
      duration,
      error,
      meta
    }
    sessionStorage.setItem(TEST_STATE_KEY, JSON.stringify(payload))
  }, [prompt, model, response, reasoning, tokens, duration, error, meta])

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
        body: JSON.stringify({ prompt, model })
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

  const modelKeys = Object.keys(models)
  const selectedModelMode = models[model]?.metadata?.igniteTemplateMode || 'chat'
  const { answer, thinkingBlocks } = splitThinkingBlocks(response)
  const reasoningText = reasoning.trim()
  const hasThinking = reasoningText.length > 0 || thinkingBlocks.length > 0
  const hasResult = response.trim().length > 0 || reasoningText.length > 0

  return (
    <div className="p-6">
      <h2 className="text-2xl font-semibold tracking-tight mb-6">Quick Test</h2>

      <div className="card mb-6">
        {/* Model selector */}
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
          <div
            className="mb-4 rounded-lg border p-3 text-sm"
            style={{ borderColor: 'rgba(245, 158, 11, 0.35)', background: 'rgba(245, 158, 11, 0.10)' }}
          >
            <p className="font-medium mb-1">Completion model</p>
            <p style={{ color: 'var(--text-muted)' }}>
              This model is better for code or text continuation than normal chat. Use a code prefix, unfinished function, or partial paragraph instead of a conversational prompt like "hi".
            </p>
          </div>
        )}

        {/* Prompt */}
        <div>
          <label className="block text-sm font-medium mb-1">Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={selectedModelMode === 'completion' ? 'Enter a completion prompt or code prefix...' : 'Enter your prompt here...'}
            rows={4}
            className="w-full px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 resize-none"
          />
        </div>

        <button
          onClick={handleSubmit}
          disabled={loading || !prompt.trim() || !model}
          className="btn btn-primary mt-4"
        >
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
              {tokens} tokens &bull; {duration}ms
            </div>
          </div>

          {hasThinking && (
            <details className="mb-4 rounded-lg border dark:border-gray-600 p-3" open>
              <summary className="cursor-pointer font-medium">
                Thinking
              </summary>
              <div className="mt-3 space-y-3">
                {reasoningText && (
                  <pre className="whitespace-pre-wrap text-sm rounded p-3 border" style={{ background: 'rgba(148, 163, 184, 0.08)', borderColor: 'var(--line-soft)' }}>
                    {reasoningText}
                  </pre>
                )}
                {!reasoningText && thinkingBlocks.map((block, index) => (
                  <pre
                    key={index}
                    className="whitespace-pre-wrap text-sm rounded p-3 border"
                    style={{ background: 'rgba(148, 163, 184, 0.08)', borderColor: 'var(--line-soft)' }}
                  >
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
                <div><span style={{ color: 'var(--text-muted)' }}>ID:</span> {meta.id || '-'}</div>
                <div><span style={{ color: 'var(--text-muted)' }}>Fingerprint:</span> {meta.system_fingerprint || '-'}</div>
                <div><span style={{ color: 'var(--text-muted)' }}>Created:</span> {meta.created ?? '-'}</div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default TestPage
