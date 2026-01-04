"""WebSocket endpoints for real-time chat."""
import json
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Dict
from database.db import get_db, async_session_maker
from services.session_manager import session_manager
from services.llm_provider import llm_provider

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


@router.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    """
    WebSocket endpoint for chat communication.
    
    Protocol:
    - Client sends: {"type": "message", "content": "..."}
    - Client sends: {"type": "get_history"}
    - Server sends: {"type": "message", "role": "user"|"assistant", "content": "...", "timestamp": "..."}
    - Server sends: {"type": "history", "messages": [...]}
    - Server sends: {"type": "error", "content": "..."}
    - Server sends: {"type": "typing", "status": true|false}
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
                    
                    # Get response from LLM
                    try:
                        response = await llm_provider.send_message(content, session_id)
                    except Exception as e:
                        logger.error(f"LLM error: {e}")
                        response = f"Error communicating with AI: {str(e)}"
                    
                    # Store assistant message
                    assistant_msg = await session_manager.add_message(
                        db, session_id, "assistant", response
                    )
                    
                    # Send typing indicator off
                    await websocket.send_json({
                        "type": "typing",
                        "status": False,
                    })
                    
                    # Send assistant response
                    await websocket.send_json({
                        "type": "message",
                        "role": "assistant",
                        "content": response,
                        "timestamp": assistant_msg.timestamp.isoformat(),
                        "id": assistant_msg.id,
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

