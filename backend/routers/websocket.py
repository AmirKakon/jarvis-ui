"""WebSocket endpoints for real-time chat with streaming support."""
import json
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from typing import Dict, Optional
from database.db import async_session_maker
from services.session_manager import session_manager
from services.orchestrator import get_orchestrator, OrchestratorEvent
from services.llm_provider import ChatMessage

router = APIRouter()
logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections."""
    
    def __init__(self):
        # Map of session_id to list of WebSocket connections
        self.active_connections: Dict[str, list[WebSocket]] = {}
    
    async def connect(self, websocket: WebSocket, session_id: str):
        """Accept and store a new WebSocket connection."""
        await websocket.accept()
        if session_id not in self.active_connections:
            self.active_connections[session_id] = []
        self.active_connections[session_id].append(websocket)
        logger.info(f"Client connected: {session_id}")
    
    def disconnect(self, websocket: WebSocket, session_id: str):
        """Remove a WebSocket connection."""
        if session_id in self.active_connections:
            if websocket in self.active_connections[session_id]:
                self.active_connections[session_id].remove(websocket)
            if not self.active_connections[session_id]:
                del self.active_connections[session_id]
        logger.info(f"Client disconnected: {session_id}")
    
    async def send_message(self, message: dict, session_id: str):
        """Send a message to all connections for a session."""
        if session_id in self.active_connections:
            for connection in self.active_connections[session_id]:
                try:
                    await connection.send_json(message)
                except Exception as e:
                    logger.error(f"Error sending message: {e}")
    
    async def broadcast(self, message: dict):
        """Broadcast a message to all connections."""
        for session_id in self.active_connections:
            await self.send_message(message, session_id)


# Global connection manager
manager = ConnectionManager()


async def load_conversation_history(db, session_id: str, limit: int = 20) -> list[ChatMessage]:
    """Load recent conversation history as ChatMessage objects."""
    messages = await session_manager.get_messages(db, session_id, limit=limit)
    
    history = []
    for msg in messages:
        history.append(ChatMessage(
            role=msg.role,
            content=msg.content,
        ))
    
    return history


@router.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    """
    WebSocket endpoint for chat communication with streaming support.
    
    Protocol:
    Client → Server:
        {"type": "message", "content": "..."}
        {"type": "get_history"}
        {"type": "stop"} - Stop current generation (future)
    
    Server → Client:
        {"type": "message", "role": "user"|"assistant", "content": "...", "timestamp": "...", "id": ...}
        {"type": "history", "messages": [...]}
        {"type": "error", "content": "..."}
        {"type": "typing", "status": true|false}
        {"type": "stream_start"}
        {"type": "stream_token", "content": "..."}
        {"type": "stream_end", "id": ..., "timestamp": "...", "content": "..."}
        {"type": "tool_call", "tool": "...", "args": {...}}
        {"type": "tool_result", "tool": "...", "result": {...}}
    """
    await manager.connect(websocket, session_id)
    
    try:
        while True:
            # Receive message from client
            data = await websocket.receive_text()
            
            try:
                message_data = json.loads(data)
            except json.JSONDecodeError:
                await websocket.send_json({
                    "type": "error",
                    "content": "Invalid JSON format",
                })
                continue
            
            msg_type = message_data.get("type", "message")
            
            # Create a new database session for this operation
            async with async_session_maker() as db:
                if msg_type == "get_history":
                    # Get chat history
                    messages = await session_manager.get_messages(db, session_id)
                    await websocket.send_json({
                        "type": "history",
                        "messages": [msg.to_dict() for msg in messages],
                    })
                
                elif msg_type == "message":
                    content = message_data.get("content", "").strip()
                    
                    if not content:
                        await websocket.send_json({
                            "type": "error",
                            "content": "Empty message",
                        })
                        continue
                    
                    # Store user message
                    user_msg = await session_manager.add_message(
                        db, session_id, "user", content
                    )
                    
                    # Send confirmation of user message
                    await websocket.send_json({
                        "type": "message",
                        "role": "user",
                        "content": content,
                        "timestamp": user_msg.timestamp.isoformat(),
                        "id": user_msg.id,
                    })
                    
                    # Send typing indicator
                    await websocket.send_json({
                        "type": "typing",
                        "status": True,
                    })
                    
                    # Load conversation history for context
                    conversation_history = await load_conversation_history(db, session_id)
                    # Remove the last message (the one we just added) since orchestrator will add it
                    if conversation_history:
                        conversation_history = conversation_history[:-1]
                    
                    # Get orchestrator and process message
                    orchestrator = get_orchestrator()
                    full_response = ""
                    stream_started = False
                    has_error = False
                    
                    try:
                        async for event in orchestrator.process_message(
                            user_message=content,
                            conversation_history=conversation_history,
                        ):
                            if event.type == "start":
                                stream_started = True
                                # Turn off typing indicator, start streaming
                                await websocket.send_json({
                                    "type": "typing",
                                    "status": False,
                                })
                                await websocket.send_json({
                                    "type": "stream_start",
                                })
                            
                            elif event.type == "token":
                                await websocket.send_json({
                                    "type": "stream_token",
                                    "content": event.content,
                                })
                            
                            elif event.type == "tool_call":
                                await websocket.send_json({
                                    "type": "tool_call",
                                    "tool": event.tool_name,
                                    "args": event.tool_args,
                                })
                            
                            elif event.type == "tool_result":
                                await websocket.send_json({
                                    "type": "tool_result",
                                    "tool": event.tool_name,
                                    "result": event.tool_result,
                                })
                            
                            elif event.type == "end":
                                full_response = event.full_response or ""
                            
                            elif event.type == "error":
                                has_error = True
                                full_response = event.content
                                await websocket.send_json({
                                    "type": "error",
                                    "content": event.content,
                                })
                    
                    except Exception as e:
                        logger.error(f"Orchestrator error: {e}")
                        has_error = True
                        full_response = f"Error communicating with AI: {str(e)}"
                        await websocket.send_json({
                            "type": "error",
                            "content": full_response,
                        })
                    
                    # Turn off typing if we didn't stream
                    if not stream_started:
                        await websocket.send_json({
                            "type": "typing",
                            "status": False,
                        })
                    
                    # Store assistant message in database
                    if full_response:
                        assistant_msg = await session_manager.add_message(
                            db, session_id, "assistant", full_response
                        )
                        
                        # Send stream end with message details
                        await websocket.send_json({
                            "type": "stream_end",
                            "id": assistant_msg.id,
                            "timestamp": assistant_msg.timestamp.isoformat(),
                            "content": full_response,
                        })
                    else:
                        # No response received
                        await websocket.send_json({
                            "type": "stream_end",
                            "content": "",
                        })
                
                elif msg_type == "stop":
                    # TODO: Implement generation stopping
                    logger.info(f"Stop requested for session {session_id}")
                    await websocket.send_json({
                        "type": "info",
                        "content": "Stop requested (not yet implemented)",
                    })
                
                else:
                    await websocket.send_json({
                        "type": "error",
                        "content": f"Unknown message type: {msg_type}",
                    })
    
    except WebSocketDisconnect:
        manager.disconnect(websocket, session_id)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(websocket, session_id)
