"""n8n webhook client for communicating with Jarvis."""
import httpx
import json
import logging
from typing import Optional, AsyncGenerator, Tuple
from config import get_settings

settings = get_settings()
logger = logging.getLogger(__name__)


class N8NClient:
    """Client for communicating with n8n webhook."""
    
    def __init__(self, webhook_url: Optional[str] = None, timeout: Optional[int] = None):
        self.webhook_url = webhook_url or settings.n8n_webhook_url
        self.timeout = timeout or settings.n8n_timeout_seconds
    
    async def send_message(self, message: str, session_id: str) -> dict:
        """
        Send a message to n8n webhook and get response (non-streaming).
        
        Args:
            message: The user message to send
            session_id: The session ID for context
            
        Returns:
            dict with response from n8n
        """
        payload = {
            "message": message,
            "sessionId": session_id,
        }
        
        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(
                    self.webhook_url,
                    json=payload,
                    timeout=self.timeout,
                )
                response.raise_for_status()
                
                # Try to parse as JSON
                try:
                    data = response.json()
                    # Handle different response formats
                    if isinstance(data, dict):
                        return data
                    elif isinstance(data, str):
                        return {"response": data}
                    else:
                        return {"response": str(data)}
                except:
                    # If not JSON, return as plain text
                    return {"response": response.text}
                    
            except httpx.TimeoutException:
                return {
                    "error": True,
                    "response": "Request timed out. The AI is taking too long to respond.",
                }
            except httpx.HTTPStatusError as e:
                return {
                    "error": True,
                    "response": f"HTTP error: {e.response.status_code}",
                }
            except Exception as e:
                return {
                    "error": True,
                    "response": f"Connection error: {str(e)}",
                }
    
    async def stream_message(
        self, 
        message: str, 
        session_id: str
    ) -> AsyncGenerator[Tuple[str, str], None]:
        """
        Send a message to n8n webhook and stream the response.
        
        Args:
            message: The user message to send
            session_id: The session ID for context
            
        Yields:
            Tuples of (event_type, content):
            - ("start", "") - Stream started
            - ("chunk", "text") - Text chunk
            - ("end", "full_response") - Stream ended with complete response
            - ("error", "error_message") - Error occurred
        """
        payload = {
            "message": message,
            "sessionId": session_id,
        }
        
        full_response = ""
        ai_agent_content = ""
        streaming_started = False
        
        async with httpx.AsyncClient() as client:
            try:
                async with client.stream(
                    "POST",
                    self.webhook_url,
                    json=payload,
                    timeout=self.timeout,
                ) as response:
                    response.raise_for_status()
                    
                    buffer = ""
                    
                    async for chunk in response.aiter_text():
                        buffer += chunk
                        
                        # Process complete JSON objects from buffer
                        # n8n sends newline-delimited JSON
                        while "\n" in buffer or buffer.strip().endswith("}"):
                            # Try to find a complete JSON object
                            lines = buffer.split("\n")
                            
                            for i, line in enumerate(lines[:-1]):
                                line = line.strip()
                                if not line:
                                    continue
                                    
                                try:
                                    data = json.loads(line)
                                    event_type = data.get("type")
                                    node_name = data.get("metadata", {}).get("nodeName", "")
                                    content = data.get("content", "")
                                    
                                    # Only process AI Agent node for streaming
                                    if node_name == "AI Agent":
                                        if event_type == "begin":
                                            if not streaming_started:
                                                streaming_started = True
                                                yield ("start", "")
                                        
                                        elif event_type == "item" and content:
                                            ai_agent_content += content
                                            yield ("chunk", content)
                                        
                                        elif event_type == "end":
                                            # AI Agent finished, but we might get more nodes
                                            pass
                                    
                                    # Check for final response in "Respond to Webhook" node
                                    elif node_name == "Respond to Webhook" and event_type == "item":
                                        try:
                                            # This contains the final JSON response
                                            final_data = json.loads(content)
                                            full_response = final_data.get("output", ai_agent_content)
                                        except json.JSONDecodeError:
                                            full_response = content or ai_agent_content
                                    
                                except json.JSONDecodeError:
                                    # Incomplete JSON, continue buffering
                                    continue
                            
                            # Keep the last incomplete line in buffer
                            buffer = lines[-1] if lines else ""
                            
                            # If buffer doesn't contain newline, break to get more data
                            if "\n" not in buffer and not buffer.strip().endswith("}"):
                                break
                        
                        # Try to parse the remaining buffer if it looks complete
                        if buffer.strip() and buffer.strip().endswith("}"):
                            try:
                                data = json.loads(buffer.strip())
                                event_type = data.get("type")
                                node_name = data.get("metadata", {}).get("nodeName", "")
                                content = data.get("content", "")
                                
                                if node_name == "AI Agent":
                                    if event_type == "begin" and not streaming_started:
                                        streaming_started = True
                                        yield ("start", "")
                                    elif event_type == "item" and content:
                                        ai_agent_content += content
                                        yield ("chunk", content)
                                elif node_name == "Respond to Webhook" and event_type == "item":
                                    try:
                                        final_data = json.loads(content)
                                        full_response = final_data.get("output", ai_agent_content)
                                    except json.JSONDecodeError:
                                        full_response = content or ai_agent_content
                                
                                buffer = ""
                            except json.JSONDecodeError:
                                pass
                    
                    # Use the full response if available, otherwise use accumulated content
                    final_content = full_response or ai_agent_content
                    yield ("end", final_content)
                        
            except httpx.TimeoutException:
                yield ("error", "Request timed out. The AI is taking too long to respond.")
            except httpx.HTTPStatusError as e:
                yield ("error", f"HTTP error: {e.response.status_code}")
            except Exception as e:
                logger.error(f"Streaming error: {e}")
                yield ("error", f"Connection error: {str(e)}")


# Global client instance
n8n_client = N8NClient()
