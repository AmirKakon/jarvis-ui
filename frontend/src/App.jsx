import React from 'react'
import Chat from './components/Chat'
import './App.css'

function App() {
  return (
    <div className="app">
      {/* Corner decorations for HUD effect */}
      <div className="corner-decoration top-left"></div>
      <div className="corner-decoration top-right"></div>
      <div className="corner-decoration bottom-left"></div>
      <div className="corner-decoration bottom-right"></div>
      <Chat />
    </div>
  )
}

export default App
