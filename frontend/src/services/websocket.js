/**
 * WebSocket client for real-time chat communication.
 */

class WebSocketClient {
  constructor() {
    this.socket = null;
    this.sessionId = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.listeners = {
      message: [],
      history: [],
      typing: [],
      error: [],
      connect: [],
      disconnect: [],
      stream_start: [],
      stream_chunk: [],
      stream_end: [],
    };
  }

  /**
   * Get the WebSocket URL based on current location.
   * @param {string} sessionId - The session ID
   * @returns {string} The WebSocket URL
   */
  getWebSocketUrl(sessionId) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    // In development, use the Vite proxy (same port)
    // In production, use the same origin
    const port = import.meta.env.DEV ? window.location.port : (window.location.port || (protocol === 'wss:' ? '443' : '80'));
    return `${protocol}//${host}:${port}/ws/${sessionId}`;
  }

  /**
   * Connect to the WebSocket server.
   * @param {string} sessionId - The session ID
   * @returns {Promise<void>}
   */
  connect(sessionId) {
    return new Promise((resolve, reject) => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.disconnect();
      }

      this.sessionId = sessionId;
      const url = this.getWebSocketUrl(sessionId);
      
      console.log('Connecting to WebSocket:', url);
      this.socket = new WebSocket(url);

      this.socket.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
        this.emit('connect', { sessionId });
        resolve();
      };

      this.socket.onclose = (event) => {
        console.log('WebSocket disconnected:', event.code, event.reason);
        this.emit('disconnect', { code: event.code, reason: event.reason });
        
        // Auto-reconnect if not intentionally closed
        if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          console.log(`Reconnecting... (attempt ${this.reconnectAttempts})`);
          setTimeout(() => {
            this.connect(this.sessionId).catch(console.error);
          }, this.reconnectDelay * this.reconnectAttempts);
        }
      };

      this.socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.emit('error', { error: 'Connection error' });
        reject(error);
      };

      this.socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (error) {
          console.error('Error parsing message:', error);
        }
      };
    });
  }

  /**
   * Handle incoming WebSocket messages.
   * @param {object} data - The message data
   */
  handleMessage(data) {
    const { type, ...payload } = data;
    
    switch (type) {
      case 'message':
        this.emit('message', payload);
        break;
      case 'history':
        this.emit('history', payload);
        break;
      case 'typing':
        this.emit('typing', payload);
        break;
      case 'error':
        this.emit('error', payload);
        break;
      case 'stream_start':
        this.emit('stream_start', payload);
        break;
      case 'stream_chunk':
        this.emit('stream_chunk', payload);
        break;
      case 'stream_end':
        this.emit('stream_end', payload);
        break;
      default:
        console.log('Unknown message type:', type, data);
    }
  }

  /**
   * Send a chat message.
   * @param {string} content - The message content
   */
  sendMessage(content) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not connected');
      return;
    }

    this.socket.send(JSON.stringify({
      type: 'message',
      content,
    }));
  }

  /**
   * Request chat history.
   */
  getHistory() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not connected');
      return;
    }

    this.socket.send(JSON.stringify({
      type: 'get_history',
    }));
  }

  /**
   * Disconnect from the WebSocket server.
   */
  disconnect() {
    if (this.socket) {
      this.socket.close(1000, 'Client disconnect');
      this.socket = null;
    }
  }

  /**
   * Add an event listener.
   * @param {string} event - The event type
   * @param {function} callback - The callback function
   */
  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  /**
   * Remove an event listener.
   * @param {string} event - The event type
   * @param {function} callback - The callback function
   */
  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }
  }

  /**
   * Emit an event to all listeners.
   * @param {string} event - The event type
   * @param {object} data - The event data
   */
  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => callback(data));
    }
  }

  /**
   * Check if the WebSocket is connected.
   * @returns {boolean}
   */
  isConnected() {
    return this.socket && this.socket.readyState === WebSocket.OPEN;
  }
}

// Export a singleton instance
export const wsClient = new WebSocketClient();
