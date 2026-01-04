import React, { useState, useEffect, useCallback, useRef } from 'react'
import { wsClient } from '../services/websocket'
import { getSessionId, resetSession } from '../utils/session'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import './Chat.css'

function Chat() {
  const [messages, setMessages] = useState([])
  const [isConnected, setIsConnected] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [sessionId, setSessionId] = useState(getSessionId())
  const [error, setError] = useState(null)
  const reconnectTimeoutRef = useRef(null)

  // Connect to WebSocket
  const connect = useCallback(async () => {
    try {
      setError(null)
      await wsClient.connect(sessionId)
      wsClient.getHistory()
    } catch (err) {
      console.error('Connection failed:', err)
      setError('Failed to connect to server. Retrying...')
    }
  }, [sessionId])

  // Handle new session
  const handleNewSession = useCallback(() => {
    const newSessionId = resetSession()
    setSessionId(newSessionId)
    setMessages([])
    wsClient.disconnect()
  }, [])

  // Setup WebSocket listeners
  useEffect(() => {
    const handleConnect = () => {
      setIsConnected(true)
      setError(null)
    }

    const handleDisconnect = () => {
      setIsConnected(false)
    }

    const handleMessage = (data) => {
      setMessages(prev => {
        // Avoid duplicates (user messages are echoed back)
        if (data.id && prev.some(m => m.id === data.id)) {
          return prev
        }
        return [...prev, {
          id: data.id || Date.now(),
          role: data.role,
          content: data.content,
          timestamp: data.timestamp,
        }]
      })
    }

    const handleHistory = (data) => {
      setMessages(data.messages.map(msg => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
      })))
    }

    const handleTyping = (data) => {
      setIsTyping(data.status)
    }

    const handleError = (data) => {
      console.error('WebSocket error:', data)
      setError(data.content || data.error || 'An error occurred')
    }

    wsClient.on('connect', handleConnect)
    wsClient.on('disconnect', handleDisconnect)
    wsClient.on('message', handleMessage)
    wsClient.on('history', handleHistory)
    wsClient.on('typing', handleTyping)
    wsClient.on('error', handleError)

    // Connect on mount
    connect()

    return () => {
      wsClient.off('connect', handleConnect)
      wsClient.off('disconnect', handleDisconnect)
      wsClient.off('message', handleMessage)
      wsClient.off('history', handleHistory)
      wsClient.off('typing', handleTyping)
      wsClient.off('error', handleError)
      
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
    }
  }, [connect])

  // Reconnect when session changes
  useEffect(() => {
    if (sessionId) {
      connect()
    }
  }, [sessionId, connect])

  // Send message
  const handleSendMessage = useCallback((content) => {
    if (!isConnected) {
      setError('Not connected to server')
      return
    }
    wsClient.sendMessage(content)
  }, [isConnected])

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="header-content">
          <div className="header-title">
            <div className="logo">
              <svg viewBox="0 0 100 100" className="logo-icon">
                <defs>
                  <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#00d4ff" />
                    <stop offset="100%" stopColor="#7c3aed" />
                  </linearGradient>
                </defs>
                <circle cx="50" cy="50" r="45" fill="none" stroke="url(#logoGrad)" strokeWidth="3"/>
                <circle cx="50" cy="50" r="20" fill="url(#logoGrad)" opacity="0.8"/>
                <circle cx="50" cy="50" r="8" fill="#0a0f1c"/>
              </svg>
            </div>
            <div className="title-text">
              <h1>Jarvis</h1>
              <span className="subtitle">AI Assistant</span>
            </div>
          </div>
          <div className="header-actions">
            <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
              <span className="status-dot"></span>
              <span className="status-text">{isConnected ? 'Connected' : 'Disconnected'}</span>
            </div>
            <button 
              className="new-session-btn"
              onClick={handleNewSession}
              title="Start new session"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              New Chat
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <MessageList 
        messages={messages} 
        isTyping={isTyping}
      />

      <MessageInput 
        onSend={handleSendMessage}
        disabled={!isConnected}
      />
    </div>
  )
}

export default Chat

