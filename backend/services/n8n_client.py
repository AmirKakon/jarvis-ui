"""n8n webhook client for communicating with Jarvis."""
import httpx
from typing import Optional
from config import get_settings

settings = get_settings()


class N8NClient:
    """Client for communicating with n8n webhook."""
    
    def __init__(self, webhook_url: Optional[str] = None, timeout: Optional[int] = None):
        self.webhook_url = webhook_url or settings.n8n_webhook_url
        self.timeout = timeout or settings.n8n_timeout_seconds
    
    async def send_message(self, message: str, session_id: str) -> dict:
        """
        Send a message to n8n webhook and get response.
        
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


# Global client instance
n8n_client = N8NClient()

