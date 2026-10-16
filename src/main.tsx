import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { loadCatalog, loadFeature } from './data/puzzles'
import { utcDay } from './lib/game'
import './styles.css'

void loadCatalog()
  .then((catalog) => {
    const today = catalog.daily[utcDay()]
    if (today) return loadFeature(today)
  })
  .catch(() => {}) // App shows an error if the requested puzzle cannot load.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
