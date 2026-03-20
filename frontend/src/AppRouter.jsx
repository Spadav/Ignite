import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import App from './App'
import ModelsPage from './pages/ModelsPage'
import ConfigPage from './pages/ConfigPage'
import DiscoverPage from './pages/DiscoverPage'
import StatusPage from './pages/StatusPage'
import TestPage from './pages/TestPage'
import SettingsPage from './pages/SettingsPage'

function AppWithRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<Navigate to="/status" replace />} />
          <Route path="discover" element={<DiscoverPage />} />
          <Route path="models" element={<ModelsPage />} />
          <Route path="config" element={<ConfigPage />} />
          <Route path="status" element={<StatusPage />} />
          <Route path="test" element={<TestPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default AppWithRouter
