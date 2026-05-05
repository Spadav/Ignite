import React, { useState, useEffect } from 'react'
import { useNavigate, useLocation, Outlet } from 'react-router-dom'
import { useGpuStats } from './hooks/useGpuStats'
import { useServiceStatus } from './hooks/useServiceStatus'
import igniteLogo from './assets/Ignite_logo.jpeg'

function App() {
  const appName = 'Ignite'
  const navigate = useNavigate()
  const location = useLocation()
  const [darkMode, setDarkMode] = useState(true)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const gpuStats = useGpuStats()
  const { running, pid } = useServiceStatus()
  const formatGiB = (value) => Number(value || 0).toFixed(1).replace(/\.0$/, '')

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
    { label: 'Runtime', path: '/runtime' },
    { label: 'Discover', path: '/discover' },
    { label: 'Config', path: '/config' },
    { label: 'Models', path: '/models' },
    { label: 'Playground', path: '/playground' },
    { label: 'Logs', path: '/logs' },
    { label: 'Updates', path: '/updates' },
    { label: 'Settings', path: '/settings' },
  ]

  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname])

  const renderSidebarContent = () => (
    <>
      <div className="px-3 pb-3 mb-3 border-b" style={{ borderColor: 'var(--line-soft)' }}>
        <span className="text-xs uppercase tracking-[0.2em]" style={{ color: 'var(--text-muted)' }}>Workspace</span>
      </div>
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
        <div className="px-3 py-2">
          <span className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>Runtime</span>
          <div className="flex items-center gap-2 mt-1">
            <span className={`w-2 h-2 rounded-full ${running ? 'bg-green-500' : 'bg-red-500'}`}></span>
            <span className="text-sm font-medium">{running ? 'Running' : 'Stopped'}</span>
            {pid && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>(PID: {pid})</span>}
          </div>
        </div>
      </div>
    </>
  )

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-main)' }}>
      <header className="border-b" style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--bg-card)' }}>
        <div className="max-w-[1600px] mx-auto w-full px-4 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img
              src={igniteLogo}
              alt="Ignite"
              className="h-10 w-10 rounded-xl object-cover border"
              style={{ borderColor: 'var(--line-soft)' }}
            />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{appName}</h1>
              <p className="text-xs uppercase tracking-[0.22em]" style={{ color: 'var(--text-muted)' }}>
                Local AI Runtime
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 md:gap-3 flex-wrap justify-end">
            <div className="shell-chip">
              <span className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>GPU</span>
              <span className="text-sm font-mono">
                {formatGiB(gpuStats.memoryUsedGb)}/{formatGiB(gpuStats.memoryTotalGb)}GiB
              </span>
            </div>
            <div className="shell-chip">
              <span className={`w-2.5 h-2.5 rounded-full ${running ? 'bg-green-500' : 'bg-red-500'}`}></span>
              <span className="text-sm font-medium">{running ? 'Runtime On' : 'Runtime Off'}</span>
            </div>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="btn btn-secondary text-sm"
            >
              {darkMode ? 'Light' : 'Dark'}
            </button>
            <button
              onClick={() => setMobileNavOpen(true)}
              className="btn btn-secondary text-sm md:hidden"
            >
              Menu
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-[1600px] mx-auto w-full mt-4 md:mt-6 px-4">
        <div className="hidden md:flex gap-4">
          <aside className="w-60 rounded-2xl p-3 border h-fit shell-panel shrink-0" style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--bg-card)' }}>
            {renderSidebarContent()}
          </aside>

          <main className="flex-1 min-w-0">
            <Outlet />
          </main>
        </div>

        <div className="md:hidden">
          <main className="min-w-0">
            <Outlet />
          </main>
        </div>
      </div>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 md:hidden" style={{ background: 'rgba(2, 6, 23, 0.72)' }}>
          <div className="absolute inset-0" onClick={() => setMobileNavOpen(false)} />
          <aside
            className="absolute left-0 top-0 h-full w-[82vw] max-w-[320px] rounded-r-2xl p-4 border-r shell-panel"
            style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--bg-card)' }}
          >
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <div className="font-semibold">{appName}</div>
                <div className="text-xs uppercase tracking-[0.18em]" style={{ color: 'var(--text-muted)' }}>
                  Navigation
                </div>
              </div>
              <button onClick={() => setMobileNavOpen(false)} className="btn btn-secondary text-sm">
                Close
              </button>
            </div>
            {renderSidebarContent()}
          </aside>
        </div>
      )}
    </div>
  )
}

export default App
