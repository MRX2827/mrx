import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { initializeRoutes } from './fb/routing.js'

initializeRoutes().then(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(<App />)
})
