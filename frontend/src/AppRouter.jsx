import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import App from './App'
import ModelsPage from './pages/ModelsPage'
import ConfigPage from './pages/ConfigPage'
import DiscoverPage from './pages/DiscoverPage'
import StatusPage from './pages/StatusPage'
import TestPage from './pages/TestPage'
import SettingsPage from './pages/SettingsPage'
import SetupPage from './pages/SetupPage'

const SETUP_STATE_KEY = 'ignite_onboarding_complete_v1'

function getDefaultRoute() {
  return localStorage.getItem(SETUP_STATE_KEY) === '1' ? '/status' : '/setup'
}

function AppWithRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<Navigate to={getDefaultRoute()} replace />} />
          <Route path="setup" element={<SetupPage />} />
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
