import { useState, useEffect } from 'react'

export function useServiceStatus(pollMs = 10000) {
  const [status, setStatus] = useState({
    running: false,
    pid: null,
    dockerGpu: null,
    dockerControlAvailable: false,
    dockerControlWarning: '',
    runtimeMode: 'local',
    backendPort: 3000,
    llamaSwapPort: 8090,
    configExists: false,
    configPath: '',
    configuredModelCount: 0,
    configuredModelIds: [],
    defaultModelId: '',
    defaultModelMode: 'chat',
    activeRuntimeModel: null,
  })

  const refreshStatus = async () => {
    try {
      const response = await fetch('/api/status')
      if (!response.ok) throw new Error('API error')
      const data = await response.json()
        setStatus({
          running: data.running || false,
          pid: data.pid,
          dockerGpu: data.docker_gpu || null,
          dockerControlAvailable: Boolean(data.docker_control_available),
          dockerControlWarning: data.docker_control_warning || '',
          runtimeMode: data.runtime_mode || 'local',
          backendPort: Number(data.backend_port || 3000),
          llamaSwapPort: Number(data.llama_swap_port || 8090),
          configExists: Boolean(data.config_exists),
          configPath: data.config_path || '',
          configuredModelCount: Number(data.configured_model_count || 0),
          configuredModelIds: Array.isArray(data.configured_model_ids) ? data.configured_model_ids : [],
          defaultModelId: data.default_model_id || '',
          defaultModelMode: data.default_model_mode || 'chat',
          activeRuntimeModel: data.active_runtime_model || null,
        })
    } catch (error) {
        setStatus({
          running: false,
          pid: null,
          dockerGpu: null,
          dockerControlAvailable: false,
          dockerControlWarning: '',
          runtimeMode: 'local',
          backendPort: 3000,
          llamaSwapPort: 8090,
          configExists: false,
          configPath: '',
          configuredModelCount: 0,
          configuredModelIds: [],
          defaultModelId: '',
          defaultModelMode: 'chat',
          activeRuntimeModel: null,
        })
    }
  }

  useEffect(() => {
    refreshStatus()
    if (!pollMs || pollMs <= 0) return
    const interval = setInterval(refreshStatus, pollMs)
    return () => clearInterval(interval)
  }, [pollMs])

  return {
    ...status,
    refreshStatus
  }
}
