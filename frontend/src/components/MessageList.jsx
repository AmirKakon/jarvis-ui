import React, { useEffect, useRef } from 'react'
import './MessageList.css'

function MessageList({ messages, isTyping }) {
  const containerRef = useRef(null)
  const bottomRef = useRef(null)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isTyping])

  // Format timestamp
  const formatTime = (timestamp) => {
    if (!timestamp) return ''
    const date = new Date(timestamp)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  // Parse and render message content with markdown-like formatting
  const renderContent = (content) => {
    if (!content) return null
    
    // Simple markdown-like parsing
    const lines = content.split('\n')
    const elements = []
    let inCodeBlock = false
    let codeContent = []
    let codeLanguage = ''
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      
      // Code block start/end
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          // End code block
          elements.push(
            <pre key={`code-${i}`} className="code-block">
              {codeLanguage && <span className="code-lang">{codeLanguage}</span>}
              <code>{codeContent.join('\n')}</code>
            </pre>
          )
          codeContent = []
          codeLanguage = ''
          inCodeBlock = false
        } else {
          // Start code block
          inCodeBlock = true
          codeLanguage = line.slice(3).trim()
        }
        continue
      }
      
      if (inCodeBlock) {
        codeContent.push(line)
        continue
      }
      
      // Empty line
      if (line.trim() === '') {
        elements.push(<br key={`br-${i}`} />)
        continue
      }
      
      // Regular line with inline formatting
      let formattedLine = line
      
      // Inline code
      formattedLine = formattedLine.replace(
        /`([^`]+)`/g, 
        '<code class="inline-code">$1</code>'
      )
      
      // Bold
      formattedLine = formattedLine.replace(
        /\*\*([^*]+)\*\*/g,
        '<strong>$1</strong>'
      )
      
      // Italic
      formattedLine = formattedLine.replace(
        /\*([^*]+)\*/g,
        '<em>$1</em>'
      )
      
      elements.push(
        <p 
          key={`p-${i}`} 
          dangerouslySetInnerHTML={{ __html: formattedLine }}
        />
      )
    }
    
    // Handle unclosed code block
    if (inCodeBlock && codeContent.length > 0) {
      elements.push(
        <pre key="code-unclosed" className="code-block">
          {codeLanguage && <span className="code-lang">{codeLanguage}</span>}
          <code>{codeContent.join('\n')}</code>
        </pre>
      )
    }
    
    return elements
  }

  return (
    <div className="message-list" ref={containerRef}>
      <div className="message-container">
        {messages.length === 0 && !isTyping && (
          <div className="empty-state">
            <div className="empty-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 3C7.03 3 3 7.03 3 12c0 1.74.5 3.37 1.36 4.74L3 21l4.26-1.36C8.63 20.5 10.26 21 12 21c4.97 0 9-4.03 9-9s-4.03-9-9-9z"/>
                <circle cx="12" cy="12" r="1"/>
                <circle cx="8" cy="12" r="1"/>
                <circle cx="16" cy="12" r="1"/>
              </svg>
            </div>
            <h2>Start a conversation</h2>
            <p>Send a message to begin chatting with Jarvis</p>
          </div>
        )}

        {messages.map((message) => (
          <div 
            key={message.id} 
            className={`message ${message.role}`}
          >
            <div className="message-avatar">
              {message.role === 'user' ? (
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                </svg>
              ) : (
                <svg viewBox="0 0 100 100">
                  <defs>
                    <linearGradient id="avatarGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#00d4ff" />
                      <stop offset="100%" stopColor="#7c3aed" />
                    </linearGradient>
                  </defs>
                  <circle cx="50" cy="50" r="45" fill="none" stroke="url(#avatarGrad)" strokeWidth="4"/>
                  <circle cx="50" cy="50" r="20" fill="url(#avatarGrad)" opacity="0.8"/>
                  <circle cx="50" cy="50" r="8" fill="#0a0f1c"/>
                </svg>
              )}
            </div>
            <div className="message-content">
              <div className="message-header">
                <span className="message-role">
                  {message.role === 'user' ? 'You' : 'Jarvis'}
                </span>
                <span className="message-time">
                  {formatTime(message.timestamp)}
                </span>
              </div>
              <div className="message-text">
                {renderContent(message.content)}
              </div>
            </div>
          </div>
        ))}

        {isTyping && (
          <div className="message assistant typing-indicator">
            <div className="message-avatar">
              <svg viewBox="0 0 100 100">
                <defs>
                  <linearGradient id="typingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#00d4ff" />
                    <stop offset="100%" stopColor="#7c3aed" />
                  </linearGradient>
                </defs>
                <circle cx="50" cy="50" r="45" fill="none" stroke="url(#typingGrad)" strokeWidth="4"/>
                <circle cx="50" cy="50" r="20" fill="url(#typingGrad)" opacity="0.8"/>
                <circle cx="50" cy="50" r="8" fill="#0a0f1c"/>
              </svg>
            </div>
            <div className="message-content">
              <div className="message-header">
                <span className="message-role">Jarvis</span>
              </div>
              <div className="typing-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  )
}

export default MessageList

