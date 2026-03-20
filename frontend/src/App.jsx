import React, { useState, useEffect } from 'react'
import { useNavigate, useLocation, Outlet } from 'react-router-dom'
import { useGpuStats } from './hooks/useGpuStats'
import { useServiceStatus } from './hooks/useServiceStatus'

function App() {
  const appName = 'Ignite'
  const navigate = useNavigate()
  const location = useLocation()
  const [darkMode, setDarkMode] = useState(false)
  const gpuStats = useGpuStats()
  const { running, pid } = useServiceStatus()

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [darkMode])

  const menuItems = [
    { label: 'Setup', path: '/setup' },
    { label: 'Status', path: '/status' },
    { label: 'Discover', path: '/discover' },
    { label: 'Config', path: '/config' },
    { label: 'Models', path: '/models' },
    { label: 'Test', path: '/test' },
    { label: 'Settings', path: '/settings' },
  ]

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-main)' }}>
      <header className="border-b" style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--bg-card)' }}>
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{appName}</h1>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1 rounded-lg border" style={{ borderColor: 'var(--line-soft)' }}>
              <span className="text-sm">GPU:</span>
              <span className="text-sm font-mono">
                {gpuStats.memoryUsedGb}/{gpuStats.memoryTotalGb}GiB {gpuStats.temperatureC}°C
              </span>
            </div>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="btn btn-secondary text-sm"
            >
              {darkMode ? 'Light' : 'Dark'}
            </button>
          </div>
        </div>
      </header>

      <div className="flex max-w-7xl mx-auto mt-4 px-2 md:px-0">
        <aside className="w-56 rounded-xl p-2 border h-fit" style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--bg-card)' }}>
          <nav className="space-y-1">
            {menuItems.map((item) => (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={`shell-nav-item ${location.pathname === item.path ? 'active' : ''}`}
              >
                <div className="flex items-center gap-3">
                  <span className="shell-nav-dot"></span>
                  <span className="font-medium">{item.label}</span>
                </div>
              </button>
            ))}
          </nav>
          
          <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--line-soft)' }}>
            <div className="px-4 py-2">
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Service</span>
              <div className="flex items-center gap-2 mt-1">
                <span className={`w-2 h-2 rounded-full ${running ? 'bg-green-500' : 'bg-red-500'}`}></span>
                <span className="text-sm font-medium">{running ? 'Running' : 'Stopped'}</span>
                {pid && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>(PID: {pid})</span>}
              </div>
            </div>
          </div>
        </aside>

        <main className="flex-1 ml-4">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export default App
