"""LLM Provider abstraction layer (MCP - Model Context Protocol)."""
from abc import ABC, abstractmethod
from typing import Optional
from services.n8n_client import n8n_client


class LLMProvider(ABC):
    """Abstract base class for LLM providers."""
    
    @abstractmethod
    async def send_message(
        self, 
        message: str, 
        session_id: str, 
        context: Optional[dict] = None
    ) -> str:
        """
        Send a message to the LLM and get a response.
        
        Args:
            message: The user message
            session_id: Session identifier
            context: Optional context dict
            
        Returns:
            Response string from the LLM
        """
        raise NotImplementedError


class N8NProvider(LLMProvider):
    """n8n webhook implementation (current default)."""
    
    async def send_message(
        self, 
        message: str, 
        session_id: str, 
        context: Optional[dict] = None
    ) -> str:
        """Send message via n8n webhook."""
        result = await n8n_client.send_message(message, session_id)
        
        if result.get("error"):
            return result.get("response", "An error occurred")
        
        # Extract response from various possible formats
        response = result.get("response") or result.get("output") or result.get("text")
        
        if response is None:
            # Try to find any string value in the response
            for key, value in result.items():
                if isinstance(value, str) and value:
                    return value
            return "No response received"
        
        return response


class MockProvider(LLMProvider):
    """Mock provider for testing without n8n."""
    
    async def send_message(
        self, 
        message: str, 
        session_id: str, 
        context: Optional[dict] = None
    ) -> str:
        """Return a mock response."""
        return f"[Mock] Received: {message}"


# Factory function to get the appropriate provider
def get_llm_provider(provider_type: str = "n8n") -> LLMProvider:
    """
    Get an LLM provider instance.
    
    Args:
        provider_type: Type of provider ('n8n', 'mock')
        
    Returns:
        LLMProvider instance
    """
    providers = {
        "n8n": N8NProvider,
        "mock": MockProvider,
    }
    
    provider_class = providers.get(provider_type, N8NProvider)
    return provider_class()


# Default provider
llm_provider = get_llm_provider("n8n")

