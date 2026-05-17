import React, { useEffect, useState } from 'react'

const CONFIG_GUIDE_SECTIONS = [
  {
    title: 'Core Structure',
    items: [
      { key: 'models', note: 'Main dictionary of available models. Every model ID you want to use must live here.' },
      { key: 'healthCheck.model', note: 'Model llama-swap uses for its own readiness checks.' },
      { key: 'globalTTL', note: 'Default unload timer in seconds. Use `0` to keep models loaded.' },
      { key: 'startPort', note: 'Starting value for `${PORT}` auto-assignment when your model commands use that macro.' }
    ]
  },
  {
    title: 'Top-Level Behavior',
    items: [
      { key: 'healthCheckTimeout', note: 'How long llama-swap waits for a model server to become ready.' },
      { key: 'logLevel', note: 'Proxy log verbosity. Usually `info`, `warn`, or `debug` while troubleshooting.' },
      { key: 'logToStdout', note: 'Choose whether stdout shows proxy logs, upstream logs, both, or none.' },
      { key: 'sendLoadingState', note: 'Inject loading progress into reasoning/thinking streams for compatible UIs.' },
      { key: 'includeAliasesInList', note: 'Show aliases as separate entries in `/v1/models`.' },
      { key: 'captureBuffer', note: 'How much memory is reserved for request/response capture.' }
    ]
  },
  {
    title: 'Model Fields',
    items: [
      { key: 'cmd', note: 'The command that starts the inference server for that model.' },
      { key: 'proxy', note: 'Where llama-swap sends requests after the model is running.' },
      { key: 'name', note: 'Display name shown in `/v1/models` and UIs.' },
      { key: 'description', note: 'Optional human-readable explanation of the model.' },
      { key: 'checkEndpoint', note: 'Readiness path checked before traffic is sent. Use `none` to skip.' },
      { key: 'useModelName', note: 'Override the model name sent upstream if the backend expects a different one.' },
      { key: 'ttl', note: 'Per-model unload timer. Overrides `globalTTL`.' },
      { key: 'env', note: 'Extra environment variables passed to the model process.' },
      { key: 'aliases', note: 'Alternative model IDs that reuse the same model definition.' },
      { key: 'metadata', note: 'Extra data returned in `/v1/models` for this model.' }
    ]
  },
  {
    title: 'Filters And Request Shaping',
    items: [
      { key: 'filters.stripParams', note: 'Remove request parameters before they hit the upstream model server.' },
      { key: 'filters.setParams', note: 'Force or default certain request parameters server-side.' },
      { key: 'filters.setParamsByID', note: 'Apply different request params per alias or model variant without reloading the model.' }
    ]
  },
  {
    title: 'Reuse And Automation',
    items: [
      { key: 'macros', note: 'Reusable substitutions for paths, flags, defaults, and environment-driven values.' },
      { key: 'hooks.on_startup.preload', note: 'Models to preload when llama-swap starts.' },
      { key: 'groups', note: 'Control swap behavior, exclusivity, and persistent loaded groups.' },
      { key: 'peers', note: 'Remote providers or other llama-swap instances exposed through the same API surface.' },
      { key: 'apiKeys', note: 'Optional API keys required by llama-swap before serving requests.' }
    ]
  }
]

function ConfigPage() {
  const [config, setConfig] = useState(null)
  const [rawConfig, setRawConfig] = useState('')
  const [advancedGpuMode, setAdvancedGpuMode] = useState(false)
  const [runtimeProfile, setRuntimeProfile] = useState('unknown')
  const [gpuOptions, setGpuOptions] = useState([])
  const [gpuStatus, setGpuStatus] = useState(null)
  const [runtimeGpuWarning, setRuntimeGpuWarning] = useState(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [expandedFamilies, setExpandedFamilies] = useState({})
  const [selectedFolderFilter, setSelectedFolderFilter] = useState('all')
  const [selectedFamilyProfiles, setSelectedFamilyProfiles] = useState({})
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [message, setMessage] = useState(null)
  const [editorMode, setEditorMode] = useState('structured')
  const [folderModal, setFolderModal] = useState(null)
  const [groupHelpOpen, setGroupHelpOpen] = useState(false)
  const [folderNameDraft, setFolderNameDraft] = useState('')
  const [folderSelectionDraft, setFolderSelectionDraft] = useState({})
  const [envDrafts, setEnvDrafts] = useState({})

  useEffect(() => {
    fetchConfig()
  }, [])

  const fetchConfig = async () => {
    try {
      const [configResponse, rawResponse, settingsResponse, statusResponse] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/config/raw'),
        fetch('/api/settings'),
        fetch('/api/status')
      ])

      if (!configResponse.ok || !rawResponse.ok || !settingsResponse.ok || !statusResponse.ok) throw new Error('API error')

      const configData = await configResponse.json()
      const rawData = await rawResponse.json()
      const settingsData = await settingsResponse.json()
      const statusData = await statusResponse.json()
      const nextEnvDrafts = {}
      for (const [modelKey, model] of Object.entries(configData.models || {})) {
        nextEnvDrafts[modelKey] = serializeEnv(model.env)
      }

      setConfig(configData)
      setRawConfig(rawData.content || '')
      setAdvancedGpuMode(Boolean(settingsData.advanced_gpu_mode))
      setRuntimeProfile(detectRuntimeProfile(settingsData))
      setGpuOptions(Array.isArray(statusData?.gpu?.gpus) ? statusData.gpu.gpus : [])
      setGpuStatus(statusData?.gpu || null)
      setRuntimeGpuWarning(statusData?.runtime_gpu_warning || null)
      setEnvDrafts(nextEnvDrafts)
      setMessage(null)
    } catch (error) {
      setConfig(null)
      setRuntimeProfile('unknown')
      setGpuStatus(null)
      setRuntimeGpuWarning(null)
    } finally {
      setLoading(false)
    }
  }

  const saveStructuredConfig = async (nextConfig, successText = 'Config saved') => {
    setSaving(true)
    setMessage(null)

    const response = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextConfig)
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => null)
      throw new Error(errorData?.detail || 'Save failed')
    }

    setConfig(nextConfig)
    await fetchConfig()
    setMessage({ type: 'success', text: successText })
  }

  const handleSave = async () => {
    try {
      if (editorMode === 'raw') {
        setSaving(true)
        setMessage(null)

        const response = await fetch('/api/config/raw', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: rawConfig })
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => null)
          throw new Error(errorData?.detail || 'Save failed')
        }

        await fetchConfig()
        setMessage({ type: 'success', text: 'Raw YAML saved' })
      } else {
        await saveStructuredConfig(config, 'Config saved')
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Failed to save config' })
    } finally {
      setSaving(false)
    }
  }

  const openGuide = async () => {
    setGuideOpen(true)
  }

  const toggleFamily = (familyName) => {
    setExpandedFamilies(prev => ({ ...prev, [familyName]: !(prev[familyName] ?? true) }))
  }

  const handleModelChange = (modelKey, field, value) => {
    setConfig(prev => ({
      ...prev,
      models: {
        ...prev.models,
        [modelKey]: {
          ...prev.models[modelKey],
          [field]: value
        }
      }
    }))
  }

  const serializeEnv = (envObject) => {
    if (!envObject) return ''
    if (Array.isArray(envObject)) {
      return envObject.join('\n')
    }
    if (typeof envObject === 'object') {
      return Object.entries(envObject)
        .map(([key, value]) => `${key}=${value ?? ''}`)
        .join('\n')
    }
    return ''
  }

  const parseEnvText = (text) => {
    const env = []
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      env.push(line)
    }
    return env
  }

  const handleEnvChange = (modelKey, text) => {
    setEnvDrafts(prev => ({ ...prev, [modelKey]: text }))
    const nextEnv = parseEnvText(text)
    setConfig(prev => {
      const model = { ...prev.models[modelKey] }
      if (nextEnv.length > 0) {
        model.env = nextEnv
      } else {
        delete model.env
      }
      return {
        ...prev,
        models: {
          ...prev.models,
          [modelKey]: model
        }
      }
    })
  }

  const upsertCmdFlag = (cmd, flag, value = null) => {
    const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const withValuePattern = new RegExp(`${escapedFlag}\\s+[^\\s]+`, 'g')
    const barePattern = new RegExp(`${escapedFlag}(?=\\s|$)`, 'g')
    let next = String(cmd || '')

    next = next.replace(withValuePattern, '').replace(barePattern, '')
    next = next.replace(/\s+/g, ' ').trim()

    if (value === null || value === undefined || value === '') {
      return next
    }

    return `${next} ${flag} ${value}`.trim()
  }

  const ensureBareFlag = (cmd, flag) => {
    const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const barePattern = new RegExp(`${escapedFlag}(?=\\s|$)`, 'g')
    let next = String(cmd || '').replace(barePattern, '')
    next = next.replace(/\s+/g, ' ').trim()
    return `${next} ${flag}`.trim()
  }

  const removeChatTemplateKwargs = (cmd) => {
    return String(cmd || '')
      .replace(/--chat-template-kwargs\s+('(?:[^']*)'|"(?:[^"]*)")/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  const isThinkingDisabled = (cmd) => {
    const normalized = String(cmd || '').replace(/\s+/g, '')
    return normalized.includes('enable_thinking":false') || normalized.includes("enable_thinking':false")
  }

  const detectRuntimeProfile = (settingsData) => {
    const image =
      String(settingsData?._meta?.runtime_refs?.llama_cpp_image || settingsData?.llama_cpp_image || '')
        .toLowerCase()
    if (!image) return 'unknown'
    if (image.includes('ik-llama') || image.includes('ik_llama') || image.includes('ikawrakow')) return 'ik'
    if (
      image.includes('llama.cpp') ||
      image.includes('llama-cpp') ||
      image.includes('llama_cpp') ||
      image.includes('ggml-org/llama')
    ) return 'llama'
    return 'unknown'
  }

  const handleThinkingToggle = (modelKey, enabled) => {
    setConfig(prev => {
      const model = { ...prev.models[modelKey] }
      let nextCmd = removeChatTemplateKwargs(model.cmd)

      if (!enabled) {
        if (runtimeProfile === 'ik') {
          nextCmd = ensureBareFlag(nextCmd, '--jinja')
        }
        nextCmd = `${nextCmd} --chat-template-kwargs '{"enable_thinking":false}'`.trim()
      }

      model.cmd = nextCmd.replace(/\s+/g, ' ').trim()

      return {
        ...prev,
        models: {
          ...prev.models,
          [modelKey]: model
        }
      }
    })
  }

  const getGpuAssignment = (model) => {
    const envList = Array.isArray(model?.env) ? model.env : []
    const cudaLine = envList.find((entry) => String(entry).startsWith('CUDA_VISIBLE_DEVICES='))
    if (!cudaLine) return 'any'
    const visible = String(cudaLine).split('=', 2)[1] ?? ''
    if (visible === '') return 'any'

    const directMatch = gpuOptions.find((gpu) => gpu.uuid === visible)
    if (directMatch) return directMatch.uuid

    const legacyIndexMatch = gpuOptions.find((gpu) => String(gpu.index) === visible)
    if (legacyIndexMatch) return legacyIndexMatch.uuid

    return 'any'
  }

  const handleGpuAssignmentChange = (modelKey, gpuValue) => {
    let nextEnvText = ''
    setConfig(prev => {
      const model = { ...prev.models[modelKey] }
      const envList = Array.isArray(model.env) ? [...model.env] : []
      const filteredEnv = envList.filter((entry) => !String(entry).startsWith('CUDA_VISIBLE_DEVICES='))

      let nextCmd = String(model.cmd || '')
      if (gpuValue === 'any') {
        model.env = filteredEnv.length > 0 ? filteredEnv : undefined
        nextCmd = upsertCmdFlag(nextCmd, '--split-mode')
        nextCmd = upsertCmdFlag(nextCmd, '--main-gpu')
        nextEnvText = serializeEnv(model.env)
      } else {
        filteredEnv.push(`CUDA_VISIBLE_DEVICES=${gpuValue}`)
        model.env = filteredEnv
        nextCmd = upsertCmdFlag(nextCmd, '--split-mode', 'none')
        nextCmd = upsertCmdFlag(nextCmd, '--main-gpu', '0')
        nextEnvText = serializeEnv(model.env)
      }

      model.cmd = nextCmd

      return {
        ...prev,
        models: {
          ...prev.models,
          [modelKey]: model
        }
      }
    })
    setEnvDrafts(prev => ({ ...prev, [modelKey]: nextEnvText }))
  }

  const handleFilterChange = (modelKey, value) => {
    setConfig(prev => ({
      ...prev,
      models: {
        ...prev.models,
        [modelKey]: {
          ...prev.models[modelKey],
          filters: {
            ...(prev.models[modelKey].filters || {}),
            stripParams: value
          }
        }
      }
    }))
  }

  const removeFilters = (modelKey) => {
    setConfig(prev => {
      const model = { ...prev.models[modelKey] }
      delete model.filters
      return { ...prev, models: { ...prev.models, [modelKey]: model } }
    })
  }

  const handleAliasesChange = (modelKey, value) => {
    const aliases = value.split(',').map(a => a.trim()).filter(Boolean)
    handleModelChange(modelKey, 'aliases', aliases.length > 0 ? aliases : undefined)
  }

  const handleRequestModeChange = (modelKey, value) => {
    setConfig(prev => ({
      ...prev,
      models: {
        ...prev.models,
        [modelKey]: {
          ...prev.models[modelKey],
          metadata: {
            ...(prev.models[modelKey].metadata || {}),
            igniteRequestMode: value,
            igniteTemplateMode: value
          }
        }
      }
    }))
  }

  const getModelFolder = (model) => {
    return String(model?.metadata?.igniteFolder || '').trim()
  }

  const getModelPathFromCmd = (cmd) => {
    const match = String(cmd || '').match(/(?:^|\s)-m\s+([^\s]+)/)
    return match?.[1] || ''
  }

  const getFileStem = (path) => {
    const value = String(path || '').trim()
    if (!value) return ''
    const last = value.split('/').pop() || value
    return last.replace(/\.(gguf|bin|safetensors)$/i, '')
  }

  const getModelFamily = (modelKey, model) => {
    const explicit = String(model?.metadata?.igniteFamily || '').trim()
    if (explicit) return explicit

    const modelPath = getModelPathFromCmd(model?.cmd)
    const pathStem = getFileStem(modelPath)
    if (pathStem) return pathStem

    const displayName = String(model?.name || '').trim()
    if (displayName) return displayName

    return modelKey
  }

  const getModelProfile = (modelKey, model) => {
    const explicit = String(model?.metadata?.igniteProfile || '').trim()
    if (explicit) return explicit

    const description = String(model?.description || '').trim()
    if (description) return description

    return modelKey
  }

  const handleMetadataFieldChange = (modelKey, field, value) => {
    setConfig(prev => {
      const currentModel = prev.models[modelKey]
      const nextMetadata = { ...(currentModel.metadata || {}) }
      const trimmed = String(value || '').trim()

      if (trimmed) {
        nextMetadata[field] = trimmed
      } else {
        delete nextMetadata[field]
      }

      return {
        ...prev,
        models: {
          ...prev.models,
          [modelKey]: {
            ...currentModel,
            ...(Object.keys(nextMetadata).length > 0 ? { metadata: nextMetadata } : { metadata: undefined })
          }
        }
      }
    })
  }

  const getFolderOptions = () => {
    const folderNames = new Set()
    for (const model of Object.values(config?.models || {})) {
      folderNames.add(getModelFolder(model) || 'Ungrouped')
    }

    return Array.from(folderNames).sort((a, b) => {
      if (a === 'Ungrouped') return 1
      if (b === 'Ungrouped') return -1
      return a.localeCompare(b)
    })
  }

  const getFamilyGroups = (entries) => {
    const grouped = {}
    for (const [modelKey, model] of entries) {
      const family = getModelFamily(modelKey, model)
      if (!grouped[family]) grouped[family] = []
      grouped[family].push([modelKey, model])
    }

    return Object.entries(grouped)
      .map(([familyName, familyEntries]) => [
        familyName,
        [...familyEntries].sort(([aKey], [bKey]) => aKey.localeCompare(bKey))
      ])
      .sort(([a], [b]) => a.localeCompare(b))
  }

  const getVisibleFamilyGroups = () => {
    const visibleEntries = Object.entries(config?.models || {}).filter(([, model]) => {
      if (selectedFolderFilter === 'all') return true
      const folderName = getModelFolder(model) || 'Ungrouped'
      return folderName === selectedFolderFilter
    })

    return getFamilyGroups(visibleEntries).map(([familyName, familyEntries]) => {
      const folders = Array.from(new Set(
        familyEntries.map(([, model]) => getModelFolder(model) || 'Ungrouped')
      )).sort((a, b) => a.localeCompare(b))

      return { familyName, familyEntries, folders }
    })
  }

  const getSelectedFamilyProfile = (familyName, familyEntries) => {
    const current = selectedFamilyProfiles[familyName]
    if (current && familyEntries.some(([key]) => key === current)) {
      return current
    }
    return familyEntries[0]?.[0] || ''
  }

  const selectFamilyProfile = (familyName, modelKey) => {
    setSelectedFamilyProfiles(prev => ({ ...prev, [familyName]: modelKey }))
  }

  const getRuntimeGroups = () => {
    const groups = config?.groups && typeof config.groups === 'object' ? config.groups : {}
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
  }

  const getGroupMembers = (group) => {
    return Array.isArray(group?.members) ? group.members.filter(Boolean) : []
  }

  const getModelAssignedGroup = (modelKey) => {
    for (const [groupName, group] of getRuntimeGroups()) {
      if (getGroupMembers(group).includes(modelKey)) {
        return groupName
      }
    }
    return ''
  }

  const addRuntimeGroup = () => {
    const baseName = `group-${Date.now()}`
    setConfig(prev => ({
      ...prev,
      groups: {
        ...(prev.groups || {}),
        [baseName]: {
          swap: false,
          exclusive: false,
          persistent: false,
          members: []
        }
      }
    }))
  }

  const renameRuntimeGroup = (oldName, newNameRaw) => {
    const newName = newNameRaw.trim()
    if (!newName || newName === oldName) return
    if (config.groups?.[newName]) {
      setMessage({ type: 'error', text: `Group "${newName}" already exists` })
      return
    }

    setConfig(prev => {
      const nextGroups = {}
      for (const [groupName, group] of Object.entries(prev.groups || {})) {
        nextGroups[groupName === oldName ? newName : groupName] = group
      }
      return { ...prev, groups: nextGroups }
    })
  }

  const handleRuntimeGroupChange = (groupName, field, value) => {
    setConfig(prev => ({
      ...prev,
      groups: {
        ...(prev.groups || {}),
        [groupName]: {
          ...((prev.groups || {})[groupName] || {}),
          [field]: value
        }
      }
    }))
  }

  const deleteRuntimeGroup = (groupName) => {
    setConfig(prev => {
      const nextGroups = { ...(prev.groups || {}) }
      delete nextGroups[groupName]
      return {
        ...prev,
        ...(Object.keys(nextGroups).length > 0 ? { groups: nextGroups } : { groups: undefined })
      }
    })
  }

  const handleModelGroupAssignment = (modelKey, groupName) => {
    setConfig(prev => {
      const nextGroups = {}
      for (const [name, group] of Object.entries(prev.groups || {})) {
        nextGroups[name] = {
          ...group,
          members: getGroupMembers(group).filter((member) => member !== modelKey)
        }
      }

      if (groupName && nextGroups[groupName]) {
        nextGroups[groupName] = {
          ...nextGroups[groupName],
          members: [...getGroupMembers(nextGroups[groupName]), modelKey]
        }
      }

      return {
        ...prev,
        ...(Object.keys(nextGroups).length > 0 ? { groups: nextGroups } : { groups: undefined })
      }
    })
  }

  const openCreateFolderModal = () => {
    const nextSelection = {}
    for (const modelKey of Object.keys(config?.models || {})) {
      nextSelection[modelKey] = false
    }
    setFolderModal({ mode: 'create', previousName: '' })
    setFolderNameDraft('')
    setFolderSelectionDraft(nextSelection)
  }

  const openManageFolderModal = (folderName) => {
    const nextSelection = {}
    for (const [modelKey, model] of Object.entries(config?.models || {})) {
      nextSelection[modelKey] = getModelFolder(model) === folderName
    }
    setFolderModal({ mode: 'edit', previousName: folderName })
    setFolderNameDraft(folderName)
    setFolderSelectionDraft(nextSelection)
  }

  const closeFolderModal = () => {
    setFolderModal(null)
    setFolderNameDraft('')
    setFolderSelectionDraft({})
  }

  const toggleFolderSelection = (modelKey) => {
    setFolderSelectionDraft(prev => ({ ...prev, [modelKey]: !prev[modelKey] }))
  }

  const saveFolderModal = () => {
    const trimmedName = folderNameDraft.trim()
    if (!trimmedName) {
      setMessage({ type: 'error', text: 'Folder name cannot be empty' })
      return
    }

    const previousName = folderModal?.previousName || ''
    const nextModels = {}

    for (const [modelKey, model] of Object.entries(config?.models || {})) {
      const currentFolder = getModelFolder(model)
      const selected = Boolean(folderSelectionDraft[modelKey])
      const nextMetadata = { ...(model.metadata || {}) }

      if (selected) {
        nextMetadata.igniteFolder = trimmedName
      } else if (currentFolder === trimmedName || (previousName && currentFolder === previousName)) {
        delete nextMetadata.igniteFolder
      }

      nextModels[modelKey] = {
        ...model,
        ...(Object.keys(nextMetadata).length > 0 ? { metadata: nextMetadata } : { metadata: undefined }),
      }
    }

    setConfig(prev => ({ ...prev, models: nextModels }))
    closeFolderModal()
  }

  const removeFolder = (folderName) => {
    const nextModels = {}
    for (const [modelKey, model] of Object.entries(config?.models || {})) {
      const currentFolder = getModelFolder(model)
      if (currentFolder !== folderName) {
        nextModels[modelKey] = model
        continue
      }

      const nextMetadata = { ...(model.metadata || {}) }
      delete nextMetadata.igniteFolder
      nextModels[modelKey] = {
        ...model,
        ...(Object.keys(nextMetadata).length > 0 ? { metadata: nextMetadata } : { metadata: undefined }),
      }
    }

    setConfig(prev => ({ ...prev, models: nextModels }))
  }

  const removeAliases = (modelKey) => {
    setConfig(prev => {
      const model = { ...prev.models[modelKey] }
      delete model.aliases
      return { ...prev, models: { ...prev.models, [modelKey]: model } }
    })
  }

  const deleteModel = async (modelKey) => {
    try {
      const models = { ...config.models }
      delete models[modelKey]
      const nextGroups = {}
      for (const [groupName, group] of Object.entries(config.groups || {})) {
        nextGroups[groupName] = {
          ...group,
          members: getGroupMembers(group).filter((member) => member !== modelKey)
        }
      }
      const nextConfig = {
        ...config,
        models,
        ...(Object.keys(nextGroups).length > 0 ? { groups: nextGroups } : { groups: undefined })
      }
      if (nextConfig.healthCheck?.model === modelKey) {
        nextConfig.healthCheck = { ...nextConfig.healthCheck, model: '' }
      }
      await saveStructuredConfig(nextConfig, `Removed ${modelKey} from config`)
      setDeleteConfirm(null)
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Failed to delete model from config' })
    } finally {
      setSaving(false)
    }
  }

  const addModel = () => {
    const key = `NewModel_${Date.now()}`
    setConfig(prev => ({
      ...prev,
      models: {
        ...prev.models,
        [key]: {
          name: 'New Model',
          cmd: '/path/to/llama-server\n-m /path/to/model.gguf\n-ngl 99\n--host 127.0.0.1\n--port ${PORT}\n',
          proxy: 'http://127.0.0.1:${PORT}'
        }
      }
    }))
    setEnvDrafts(prev => ({ ...prev, [key]: '' }))
  }

  const renameModelKey = (oldKey, newKey) => {
    if (newKey === oldKey || !newKey.trim()) return
    if (config.models[newKey]) {
      alert(`Model key "${newKey}" already exists`)
      return
    }
    setConfig(prev => {
      const entries = Object.entries(prev.models)
      const newModels = {}
      for (const [k, v] of entries) {
        newModels[k === oldKey ? newKey : k] = v
      }
      const nextGroups = {}
      for (const [groupName, group] of Object.entries(prev.groups || {})) {
        nextGroups[groupName] = {
          ...group,
          members: getGroupMembers(group).map((member) => member === oldKey ? newKey : member)
        }
      }
      const newConfig = {
        ...prev,
        models: newModels,
        ...(Object.keys(nextGroups).length > 0 ? { groups: nextGroups } : { groups: undefined })
      }
      if (prev.healthCheck?.model === oldKey) {
        newConfig.healthCheck = { ...prev.healthCheck, model: newKey }
      }
      return newConfig
    })
    setEnvDrafts(prev => {
      const next = { ...prev }
      next[newKey] = next[oldKey] ?? ''
      delete next[oldKey]
      return next
    })
    setSelectedFamilyProfiles(prev => {
      const next = { ...prev }
      for (const [familyName, profileKey] of Object.entries(next)) {
        if (profileKey === oldKey) next[familyName] = newKey
      }
      return next
    })
  }

  const renderModelEditor = (key, model) => {
    const stripParamsValue = model.filters?.stripParams ?? model.filters?.strip_params ?? ''
    const requestMode = model.metadata?.igniteRequestMode ?? model.metadata?.igniteTemplateMode ?? 'chat'
    const envText = envDrafts[key] ?? serializeEnv(model.env)
    const gpuAssignment = getGpuAssignment(model)
    const runtimeGroup = getModelAssignedGroup(key)
    const thinkingSupported = runtimeProfile === 'llama' || runtimeProfile === 'ik'
    const thinkingEnabled = !isThinkingDisabled(model.cmd)

    return (
      <div key={key} className="space-y-4">
        <div className="rounded-lg border p-4 space-y-4" style={{ borderColor: 'var(--line-soft)' }}>
          <div className="text-sm font-semibold">General</div>
          <div>
            <label className="block text-sm font-medium mb-1">Model Key</label>
            <input
              type="text"
              defaultValue={key}
              onBlur={(e) => renameModelKey(key, e.target.value.trim())}
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              value={model.name || ''}
              onChange={(e) => handleModelChange(key, 'name', e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <input
              type="text"
              value={model.description || ''}
              onChange={(e) => handleModelChange(key, 'description', e.target.value)}
              placeholder="Short note about what this config is for"
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Model Family</label>
              <input
                type="text"
                value={String(model.metadata?.igniteFamily || '')}
                onChange={(e) => handleMetadataFieldChange(key, 'igniteFamily', e.target.value)}
                placeholder={getModelFamily(key, model)}
                className={inputClass}
              />
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Visual grouping only. Keep config names unique for agents and harnesses.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Profile Label</label>
              <input
                type="text"
                value={String(model.metadata?.igniteProfile || '')}
                onChange={(e) => handleMetadataFieldChange(key, 'igniteProfile', e.target.value)}
                placeholder={getModelProfile(key, model)}
                className={inputClass}
              />
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Example: `No Thinking`, `Harness A`, `Creative`, `Agent`.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border p-4 space-y-4" style={{ borderColor: 'var(--line-soft)' }}>
          <div className="text-sm font-semibold">Runtime</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Proxy</label>
              <input
                type="text"
                value={model.proxy || ''}
                onChange={(e) => handleModelChange(key, 'proxy', e.target.value)}
                className={`${inputClass} font-mono text-sm`}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">TTL (seconds)</label>
              <input
                type="number"
                value={model.ttl ?? ''}
                onChange={(e) => handleModelChange(key, 'ttl', e.target.value === '' ? undefined : parseInt(e.target.value, 10) || 0)}
                placeholder="Use global TTL"
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Check Endpoint</label>
              <input
                type="text"
                value={model.checkEndpoint || ''}
                onChange={(e) => handleModelChange(key, 'checkEndpoint', e.target.value || undefined)}
                placeholder="/health"
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Use Model Name</label>
              <input
                type="text"
                value={model.useModelName || ''}
                onChange={(e) => handleModelChange(key, 'useModelName', e.target.value || undefined)}
                placeholder="Override upstream model name"
                className={inputClass}
              />
            </div>
          </div>

          {advancedGpuMode && (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">GPU Assignment</label>
                <select
                  value={gpuAssignment}
                  onChange={(e) => handleGpuAssignmentChange(key, e.target.value)}
                  className={inputClass}
                >
                  <option value="any">Any Visible GPU</option>
                  {gpuOptions.map((gpu) => (
                    <option key={gpu.uuid || gpu.index} value={gpu.uuid || String(gpu.index)}>
                      GPU {gpu.index}: {gpu.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  Advanced GPU Mode pins this model with the selected GPU UUID plus `--split-mode none` and `--main-gpu 0`.
                </p>
                {hasFallbackOnlyGpu && (
                  <div
                    className="mt-2 rounded-lg border p-3 text-xs"
                    style={{
                      borderColor: 'rgba(245, 158, 11, 0.35)',
                      background: 'rgba(245, 158, 11, 0.10)',
                      color: '#fde68a'
                    }}
                  >
                    {runtimeGpuWarning?.message || 'Ignite can see that a GPU exists, but it could not enumerate GPU UUIDs directly. In that state this dropdown falls back to `Any Visible GPU` until the stack is recreated cleanly.'}
                    {runtimeGpuWarning?.next_step && (
                      <div className="mt-2">{runtimeGpuWarning.next_step}</div>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Runtime Group</label>
                <select
                  value={runtimeGroup}
                  onChange={(e) => handleModelGroupAssignment(key, e.target.value)}
                  className={inputClass}
                >
                  <option value="">Default Runtime Behavior</option>
                  {getRuntimeGroups().map(([groupName]) => (
                    <option key={groupName} value={groupName}>{groupName}</option>
                  ))}
                </select>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  Assign this model to a llama-swap group when you want custom swapping or multiple loaded models.
                </p>
              </div>
            </>
          )}

          <div>
            <label className="block text-sm font-medium mb-1">Request Mode</label>
            <select
              value={requestMode}
              onChange={(e) => handleRequestModeChange(key, e.target.value)}
              className={inputClass}
            >
              <option value="chat">Chat</option>
              <option value="completion">Completion</option>
            </select>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Use Chat for instruct/conversation models. Use Completion for code or continuation models like StarCoder.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Thinking</label>
            {thinkingSupported ? (
              <>
                <div className="inline-flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--line-soft)' }}>
                  <button
                    type="button"
                    onClick={() => handleThinkingToggle(key, true)}
                    className="px-3 py-2 text-sm"
                    style={{ background: thinkingEnabled ? 'var(--line-soft)' : 'transparent' }}
                  >
                    On
                  </button>
                  <button
                    type="button"
                    onClick={() => handleThinkingToggle(key, false)}
                    className="px-3 py-2 text-sm"
                    style={{ background: !thinkingEnabled ? 'var(--line-soft)' : 'transparent' }}
                  >
                    Off
                  </button>
                </div>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  {runtimeProfile === 'ik'
                    ? 'For ik_llama.cpp, turning thinking off also ensures `--jinja` is present so `enable_thinking=false` is respected.'
                    : 'For mainline llama.cpp, this toggles `--chat-template-kwargs {\"enable_thinking\":false}`.'}
                </p>
              </>
            ) : (
              <div className="text-xs rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', color: 'var(--text-muted)' }}>
                Thinking toggle is only automated for the known runtime profiles `llama.cpp` and `ik_llama.cpp`.
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border p-4 space-y-4" style={{ borderColor: 'var(--line-soft)' }}>
          <div className="text-sm font-semibold">Command</div>
          <div>
            <label className="block text-sm font-medium mb-1">Command</label>
            <textarea
              value={model.cmd || ''}
              onChange={(e) => handleModelChange(key, 'cmd', e.target.value)}
              rows={8}
              className={`${inputClass} font-mono text-sm`}
            />
          </div>
        </div>

        <div className="rounded-lg border p-4 space-y-4" style={{ borderColor: 'var(--line-soft)' }}>
          <div className="text-sm font-semibold">Env</div>
          <div>
            <label className="block text-sm font-medium mb-1">Environment Variables</label>
            <textarea
              value={envText}
              onChange={(e) => handleEnvChange(key, e.target.value)}
              rows={5}
              placeholder={'CUDA_VISIBLE_DEVICES=1\nHF_TOKEN=...'}
              className={`${inputClass} font-mono text-sm`}
            />
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              One `KEY=value` per line. Leave empty to remove model-specific environment overrides.
            </p>
          </div>
        </div>

        <div className="rounded-lg border p-4 space-y-4" style={{ borderColor: 'var(--line-soft)' }}>
          <div className="text-sm font-semibold">Aliases And Filters</div>
          {model.aliases ? (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium">Aliases (comma-separated)</label>
                <button
                  onClick={() => removeAliases(key)}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  Remove aliases
                </button>
              </div>
              <input
                type="text"
                value={(model.aliases || []).join(', ')}
                onChange={(e) => handleAliasesChange(key, e.target.value)}
                placeholder="alias-1, alias-2"
                className={`${inputClass} text-sm`}
              />
            </div>
          ) : (
            <button
              onClick={() => handleModelChange(key, 'aliases', [''])}
              className="text-sm text-blue-500 hover:text-blue-700"
            >
              + Add aliases
            </button>
          )}

          {model.filters ? (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium">Filters (stripParams)</label>
                <button
                  onClick={() => removeFilters(key)}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  Remove filters
                </button>
              </div>
              <input
                type="text"
                value={stripParamsValue}
                onChange={(e) => handleFilterChange(key, e.target.value)}
                placeholder="temperature, top_k, top_p"
                className={`${inputClass} text-sm`}
              />
            </div>
          ) : (
            <button
              onClick={() => handleFilterChange(key, '')}
              className="text-sm text-blue-500 hover:text-blue-700"
            >
              + Add filters
            </button>
          )}
        </div>

        <div className="pt-2 border-t" style={{ borderColor: 'var(--line-soft)' }}>
          {deleteConfirm === key ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-red-500">Delete this model?</span>
              <button
                onClick={() => deleteModel(key)}
                className="text-sm px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700"
              >
                Confirm
              </button>
              <button
                onClick={() => setDeleteConfirm(null)}
                className="text-sm px-3 py-1 rounded"
                style={{ background: 'var(--line-soft)' }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setDeleteConfirm(key)}
              className="text-sm text-red-500 hover:text-red-700"
            >
              Delete model
            </button>
          )}
        </div>
      </div>
    )
  }

  if (loading) return <p className="p-6">Loading...</p>
  if (!config) return <p className="p-6 text-red-500">Config file not found</p>

  const inputClass = 'w-full px-3 py-2 rounded-lg border bg-transparent'
  const folderOptions = getFolderOptions()
  const visibleFamilyGroups = getVisibleFamilyGroups()
  const hasFallbackOnlyGpu = Boolean(gpuStatus?.available) && gpuOptions.length === 0

  return (
    <div className="p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Configuration</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Structured mode covers the fields most people actually change. Raw YAML stays available for advanced schema editing only.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={openGuide} className="btn text-sm">
            Config Guide
          </button>
          <div className="inline-flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--line-soft)' }}>
            <button
              onClick={() => setEditorMode('structured')}
              className="px-3 py-2 text-sm"
              style={{
                background: editorMode === 'structured' ? 'var(--line-soft)' : 'transparent'
              }}
            >
              Structured
            </button>
            <button
              onClick={() => setEditorMode('raw')}
              className="px-3 py-2 text-sm"
              style={{
                background: editorMode === 'raw' ? 'var(--line-soft)' : 'transparent'
              }}
            >
              Raw YAML
            </button>
          </div>
          <button onClick={handleSave} disabled={saving} className="btn btn-primary">
            {saving ? 'Saving...' : editorMode === 'raw' ? 'Save YAML' : 'Save Changes'}
          </button>
        </div>
      </div>

      {message && (
        <div
          className={`mb-4 px-4 py-2 rounded-lg text-sm border ${
            message.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
          }`}
          style={{ borderColor: 'var(--line-soft)' }}
        >
          {message.text}
        </div>
      )}

      {guideOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(8, 10, 14, 0.7)' }}
          onClick={() => setGuideOpen(false)}
        >
          <div
            className="card w-full max-w-5xl max-h-[85vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h3 className="text-xl font-semibold">Config Guide</h3>
                <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                  Glossary for the main llama-swap settings. Use Raw YAML for advanced editing and this popup to understand what each section is for.
                </p>
              </div>
              <button
                onClick={() => setGuideOpen(false)}
                className="px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--line-soft)' }}
              >
                Close
              </button>
            </div>
            <div className="overflow-auto max-h-[68vh] rounded-lg border p-4 space-y-5" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="rounded-lg p-4" style={{ background: 'var(--line-soft)' }}>
                <p className="text-sm">
                  Start with Structured mode if you only need to edit model names, commands, proxy URLs, aliases, or simple strip filters.
                  Use Raw YAML when you need advanced fields like macros, hooks, peers, groups, `setParams`, `setParamsByID`, or API keys.
                </p>
              </div>

              {CONFIG_GUIDE_SECTIONS.map((section) => (
                <div key={section.title}>
                  <h4 className="text-base font-semibold mb-3">{section.title}</h4>
                  <div className="space-y-3">
                    {section.items.map((item) => (
                      <div key={item.key} className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)' }}>
                        <div className="font-mono text-sm mb-1">{item.key}</div>
                        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{item.note}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                <h4 className="text-base font-semibold mb-2">Quick Example</h4>
                <pre className="text-sm whitespace-pre-wrap break-words font-mono" style={{ color: 'var(--text-muted)' }}>
{`models:
  MyModel:
    cmd: /path/to/llama-server -m /path/to/model.gguf --port \${PORT}
    proxy: http://127.0.0.1:\${PORT}
    name: My Model
    aliases:
      - my-model-fast
    filters:
      stripParams: "temperature, top_p"`}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {folderModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(8, 10, 14, 0.7)' }}
          onClick={closeFolderModal}
        >
          <div
            className="card w-full max-w-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h3 className="text-xl font-semibold">
                  {folderModal.mode === 'create' ? 'Create Folder' : 'Manage Folder'}
                </h3>
                <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                  Visual folders only. They do not affect llama-swap runtime behavior.
                </p>
              </div>
              <button
                onClick={closeFolderModal}
                className="px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--line-soft)' }}
              >
                Close
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Folder Name</label>
                <input
                  type="text"
                  value={folderNameDraft}
                  onChange={(e) => setFolderNameDraft(e.target.value)}
                  className={inputClass}
                  placeholder="Coding"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Configs In This Folder</label>
                <div className="max-h-72 overflow-auto rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--line-soft)' }}>
                  {Object.entries(config?.models || {}).map(([modelKey, model]) => (
                    <label key={modelKey} className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(folderSelectionDraft[modelKey])}
                        onChange={() => toggleFolderSelection(modelKey)}
                      />
                      <div>
                        <div className="font-medium">{modelKey}</div>
                        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{model.name || modelKey}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-end gap-3">
                <button onClick={closeFolderModal} className="btn btn-secondary text-sm">
                  Cancel
                </button>
                <button onClick={saveFolderModal} className="btn btn-primary text-sm">
                  Save Folder
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {groupHelpOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(8, 10, 14, 0.7)' }}
          onClick={() => setGroupHelpOpen(false)}
        >
          <div
            className="card w-full max-w-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h3 className="text-xl font-semibold">Runtime Groups Help</h3>
                <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                  Groups control how llama-swap keeps models loaded or unloads them.
                </p>
              </div>
              <button
                onClick={() => setGroupHelpOpen(false)}
                className="px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--line-soft)' }}
              >
                Close
              </button>
            </div>

            <div className="space-y-4 text-sm">
              <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                <div className="font-semibold mb-1">swap</div>
                <div style={{ color: 'var(--text-muted)' }}>
                  If enabled, this group behaves like one-at-a-time swapping. Starting one model in the group unloads another model in the same group.
                </div>
              </div>

              <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                <div className="font-semibold mb-1">exclusive</div>
                <div style={{ color: 'var(--text-muted)' }}>
                  If enabled, starting a model in this group can unload models from other groups. This is not related to GPU assignment.
                </div>
              </div>

              <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                <div className="font-semibold mb-1">persistent</div>
                <div style={{ color: 'var(--text-muted)' }}>
                  If enabled, other groups should not unload this group. Use this when you want a group to stay loaded if hardware allows it.
                </div>
              </div>

              <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)', background: 'rgba(148, 163, 184, 0.08)' }}>
                <div className="font-semibold mb-1">Example: keep two models loaded</div>
                <div style={{ color: 'var(--text-muted)' }}>
                  Put each model in its own group and start with:
                  <br />
                  `swap: false`
                  <br />
                  `exclusive: false`
                  <br />
                  `persistent: true`
                  <br /><br />
                  GPU assignment is a separate setting on each model.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {editorMode === 'raw' ? (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Raw YAML</h3>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Advanced editing only
            </span>
          </div>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
            Changes here bypass structured validation. Use this when you need full llama-swap schema access, not for normal day-to-day edits.
          </p>
          <textarea
            value={rawConfig}
            onChange={(e) => setRawConfig(e.target.value)}
            rows={32}
            spellCheck={false}
            className={`${inputClass} font-mono text-sm`}
          />
        </div>
      ) : (
        <>
          <div className="card">
            <h3 className="text-lg font-semibold mb-4">Global Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Global TTL (seconds)</label>
                <input
                  type="number"
                  value={config.globalTTL ?? config.ttl ?? 0}
                  onChange={(e) => setConfig(prev => ({
                    ...prev,
                    globalTTL: parseInt(e.target.value, 10) || 0
                  }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Health Check Model</label>
                <select
                  value={config.healthCheck?.model || ''}
                  onChange={(e) => setConfig(prev => ({
                    ...prev,
                    healthCheck: { ...prev.healthCheck, model: e.target.value }
                  }))}
                  className={inputClass}
                >
                  <option value="">— none —</option>
                  {Object.keys(config.models || {}).map(key => (
                    <option key={key} value={key}>{key}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {advancedGpuMode && (
            <div className="card mt-6">
              <div className="flex items-center justify-between mb-4 gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold">Advanced Runtime Groups</h3>
                    <button
                      onClick={() => setGroupHelpOpen(true)}
                      className="w-7 h-7 rounded-full border text-sm font-semibold"
                      style={{ borderColor: 'var(--line-soft)', color: 'var(--text-muted)' }}
                    >
                      ?
                    </button>
                  </div>
                  <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                    Groups control llama-swap loading behavior directly. Use them when you want more than the default one-model-at-a-time swap policy.
                  </p>
                </div>
                <button onClick={addRuntimeGroup} className="btn btn-secondary text-sm">
                  + Add Group
                </button>
              </div>

              <div className="space-y-3">
                {getRuntimeGroups().length === 0 ? (
                  <div className="rounded-lg border p-4 text-sm" style={{ borderColor: 'var(--line-soft)', color: 'var(--text-muted)' }}>
                    No custom groups yet. Without groups, llama-swap uses its default runtime behavior.
                  </div>
                ) : (
                  getRuntimeGroups().map(([groupName, group]) => (
                    <div key={groupName} className="rounded-lg border p-4" style={{ borderColor: 'var(--line-soft)' }}>
                      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
                        <div className="lg:col-span-2">
                          <label className="block text-sm font-medium mb-1">Group Name</label>
                          <input
                            type="text"
                            defaultValue={groupName}
                            onBlur={(e) => renameRuntimeGroup(groupName, e.target.value)}
                            className={inputClass}
                          />
                        </div>

                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={Boolean(group.swap)}
                            onChange={(e) => handleRuntimeGroupChange(groupName, 'swap', e.target.checked)}
                          />
                          Swap
                        </label>

                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={Boolean(group.exclusive)}
                            onChange={(e) => handleRuntimeGroupChange(groupName, 'exclusive', e.target.checked)}
                          />
                          Exclusive
                        </label>

                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={Boolean(group.persistent)}
                            onChange={(e) => handleRuntimeGroupChange(groupName, 'persistent', e.target.checked)}
                          />
                          Persistent
                        </label>
                      </div>

                      <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                        Members: {getGroupMembers(group).length > 0 ? getGroupMembers(group).join(', ') : 'none'}
                      </div>

                      <div className="mt-3">
                        <button onClick={() => deleteRuntimeGroup(groupName)} className="btn text-sm">
                          Remove Group
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="mt-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Models ({Object.keys(config.models || {}).length})</h3>
              <div className="flex items-center gap-2">
                <button onClick={openCreateFolderModal} className="btn btn-secondary text-sm">+ Create Folder</button>
                <button onClick={addModel} className="btn btn-primary text-sm">+ Add Model</button>
              </div>
            </div>

            <div className="card mb-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="text-sm font-semibold">Use-Case Filters</div>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    Folders are now filters only. Models are grouped by family first, with profile tabs inside each family.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setSelectedFolderFilter('all')}
                    className="btn text-sm"
                    style={{ background: selectedFolderFilter === 'all' ? 'var(--line-soft)' : 'transparent' }}
                  >
                    All
                  </button>
                  {folderOptions.map((folderName) => (
                    <button
                      key={folderName}
                      onClick={() => setSelectedFolderFilter(folderName)}
                      className="btn text-sm"
                      style={{ background: selectedFolderFilter === folderName ? 'var(--line-soft)' : 'transparent' }}
                    >
                      {folderName}
                    </button>
                  ))}
                </div>
              </div>

              {selectedFolderFilter !== 'all' && selectedFolderFilter !== 'Ungrouped' && (
                <div className="flex items-center gap-2 mt-4 pt-4 border-t" style={{ borderColor: 'var(--line-soft)' }}>
                  <button onClick={() => openManageFolderModal(selectedFolderFilter)} className="btn btn-secondary text-sm">
                    Manage Folder
                  </button>
                  <button onClick={() => removeFolder(selectedFolderFilter)} className="btn text-sm">
                    Remove Folder
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-3">
              {visibleFamilyGroups.length === 0 ? (
                <div className="card text-sm" style={{ color: 'var(--text-muted)' }}>
                  No model configs match the current folder filter.
                </div>
              ) : (
                visibleFamilyGroups.map(({ familyName, familyEntries, folders }) => {
                  const selectedProfileKey = getSelectedFamilyProfile(familyName, familyEntries)
                  const selectedPair = familyEntries.find(([profileKey]) => profileKey === selectedProfileKey) || familyEntries[0]
                  const [key, model] = selectedPair
                  const profileLabel = getModelProfile(key, model)

                  return (
                    <div key={familyName} className="card">
                      <div className="flex items-center justify-between gap-4">
                        <button
                          onClick={() => toggleFamily(familyName)}
                          className="flex-1 flex items-center justify-between text-left"
                        >
                          <div>
                            <div className="font-semibold text-lg">{key}</div>
                            <div className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                              {model?.name || key}
                            </div>
                            <div className="text-xs uppercase tracking-[0.14em] mt-2" style={{ color: 'var(--text-muted)' }}>
                              Family: {familyName}{profileLabel ? ` • Profile: ${profileLabel}` : ''}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 mt-2">
                              {folders.map((folderName) => (
                                <span
                                  key={folderName}
                                  className="px-2 py-1 rounded-full text-xs border"
                                  style={{ borderColor: 'var(--line-soft)', color: 'var(--text-muted)' }}
                                >
                                  {folderName}
                                </span>
                              ))}
                              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {familyEntries.length} profile{familyEntries.length === 1 ? '' : 's'}
                              </span>
                            </div>
                          </div>
                          <span className="text-xl" style={{ color: 'var(--text-muted)' }}>
                            {(expandedFamilies[familyName] ?? false) ? '▼' : '▶'}
                          </span>
                        </button>
                      </div>

                      {(expandedFamilies[familyName] ?? false) && (
                        <div className="mt-4 space-y-4 border-t pt-4" style={{ borderColor: 'var(--line-soft)' }}>
                          <div>
                            <div className="text-sm font-semibold mb-2">Profiles</div>
                            <div className="flex flex-wrap gap-2">
                              {familyEntries.map(([profileKey, profileModel]) => {
                                const profileLabel = getModelProfile(profileKey, profileModel)
                                const active = profileKey === selectedProfileKey
                                return (
                                  <button
                                    key={profileKey}
                                    onClick={() => selectFamilyProfile(familyName, profileKey)}
                                    className="btn text-sm"
                                    style={{ background: active ? 'var(--line-soft)' : 'transparent' }}
                                  >
                                    {profileLabel}
                                  </button>
                                )
                              })}
                            </div>
                          </div>

                          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)', background: 'rgba(255,255,255,0.015)' }}>
                            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              Active config key
                            </div>
                            <div className="font-mono text-sm mt-1">{key}</div>
                          </div>

                          {renderModelEditor(key, model)}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default ConfigPage
