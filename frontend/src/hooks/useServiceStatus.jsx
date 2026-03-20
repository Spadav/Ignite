import { useState, useEffect } from 'react'

export function useServiceStatus(pollMs = 10000) {
  const [status, setStatus] = useState({
    running: false,
    pid: null,
    dockerGpu: null,
    dockerControlAvailable: false,
    runtimeMode: 'local',
    configExists: false,
    configPath: '',
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
          runtimeMode: data.runtime_mode || 'local',
          configExists: Boolean(data.config_exists),
          configPath: data.config_path || '',
        })
    } catch (error) {
        setStatus({
          running: false,
          pid: null,
          dockerGpu: null,
          dockerControlAvailable: false,
          runtimeMode: 'local',
          configExists: false,
          configPath: '',
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
