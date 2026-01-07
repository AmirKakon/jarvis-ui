"""n8n webhook client for communicating with Jarvis."""
import httpx
import json
import logging
import re
from typing import Optional, AsyncGenerator, Tuple
from config import get_settings

settings = get_settings()
logger = logging.getLogger(__name__)

# Set to True for verbose streaming debug output
DEBUG_STREAMING = True


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
    
    def _extract_json_objects(self, text: str) -> tuple[list[dict], str]:
        """
        Extract complete JSON objects from a text buffer.
        Returns (list of parsed objects, remaining unparsed text).
        """
        objects = []
        remaining = text
        
        # Try to find JSON objects by looking for matching braces
        while remaining:
            remaining = remaining.lstrip()
            if not remaining.startswith('{'):
                # Skip any non-JSON prefix (like newlines)
                idx = remaining.find('{')
                if idx == -1:
                    break
                remaining = remaining[idx:]
            
            # Try to parse from the start
            depth = 0
            in_string = False
            escape = False
            end_idx = -1
            
            for i, char in enumerate(remaining):
                if escape:
                    escape = False
                    continue
                if char == '\\' and in_string:
                    escape = True
                    continue
                if char == '"' and not escape:
                    in_string = not in_string
                    continue
                if in_string:
                    continue
                if char == '{':
                    depth += 1
                elif char == '}':
                    depth -= 1
                    if depth == 0:
                        end_idx = i + 1
                        break
            
            if end_idx > 0:
                json_str = remaining[:end_idx]
                try:
                    obj = json.loads(json_str)
                    objects.append(obj)
                    remaining = remaining[end_idx:]
                except json.JSONDecodeError:
                    # Not valid JSON, skip this character and continue
                    remaining = remaining[1:]
            else:
                # Incomplete JSON, return what we have
                break
        
        return objects, remaining
    
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
        
        if DEBUG_STREAMING:
            logger.info(f"Sending streaming request to: {self.webhook_url}")
        
        async with httpx.AsyncClient() as client:
            try:
                async with client.stream(
                    "POST",
                    self.webhook_url,
                    json=payload,
                    timeout=self.timeout,
                ) as response:
                    response.raise_for_status()
                    
                    if DEBUG_STREAMING:
                        logger.info(f"Got response, status: {response.status_code}")
                    
                    buffer = ""
                    chunk_count = 0
                    
                    async for chunk in response.aiter_text():
                        chunk_count += 1
                        buffer += chunk
                        
                        if DEBUG_STREAMING:
                            logger.debug(f"Raw chunk #{chunk_count} ({len(chunk)} bytes): {chunk[:80]}...")
                        
                        # Extract all complete JSON objects from buffer
                        objects, buffer = self._extract_json_objects(buffer)
                        
                        for data in objects:
                            event_type = data.get("type")
                            node_name = data.get("metadata", {}).get("nodeName", "")
                            content = data.get("content", "")
                            
                            if DEBUG_STREAMING:
                                logger.debug(f"Parsed: type={event_type}, node={node_name}, content={content[:30] if content else ''}...")
                            
                            # Only process AI Agent node for streaming
                            if node_name == "AI Agent":
                                if event_type == "begin":
                                    if not streaming_started:
                                        streaming_started = True
                                        if DEBUG_STREAMING:
                                            logger.info(">>> Stream started (AI Agent begin)")
                                        yield ("start", "")
                                
                                elif event_type == "item" and content:
                                    ai_agent_content += content
                                    if DEBUG_STREAMING:
                                        logger.info(f">>> Yielding chunk: '{content}'")
                                    yield ("chunk", content)
                                
                                elif event_type == "end":
                                    if DEBUG_STREAMING:
                                        logger.info("AI Agent end received")
                            
                            # Check for final response in "Respond to Webhook" node
                            elif node_name == "Respond to Webhook" and event_type == "item":
                                try:
                                    # This contains the final JSON response
                                    final_data = json.loads(content)
                                    full_response = final_data.get("output", ai_agent_content)
                                    if DEBUG_STREAMING:
                                        logger.info(f"Got final response from Respond to Webhook: {len(full_response)} chars")
                                except json.JSONDecodeError:
                                    full_response = content or ai_agent_content
                    
                    # Use the full response if available, otherwise use accumulated content
                    final_content = full_response or ai_agent_content
                    if DEBUG_STREAMING:
                        logger.info(f"Stream complete. Chunks: {chunk_count}, Final length: {len(final_content)}")
                    yield ("end", final_content)
                        
            except httpx.TimeoutException:
                logger.error("Streaming timeout")
                yield ("error", "Request timed out. The AI is taking too long to respond.")
            except httpx.HTTPStatusError as e:
                logger.error(f"HTTP error: {e.response.status_code}")
                yield ("error", f"HTTP error: {e.response.status_code}")
            except Exception as e:
                logger.error(f"Streaming error: {type(e).__name__}: {e}")
                yield ("error", f"Connection error: {str(e)}")


# Global client instance
n8n_client = N8NClient()
