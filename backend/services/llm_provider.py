"""LLM Provider abstraction layer with streaming and tool calling support."""
import json
import logging
from abc import ABC, abstractmethod
from typing import Optional, AsyncGenerator, Any
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class StreamEvent:
    """Represents a streaming event from the LLM."""
    type: str  # "start", "token", "tool_call", "tool_result", "end", "error"
    content: str = ""
    tool_name: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_args: Optional[dict] = None
    full_response: Optional[str] = None


@dataclass
class ToolCall:
    """Represents a tool call request from the LLM."""
    id: str
    name: str
    arguments: dict


@dataclass
class ChatMessage:
    """Represents a chat message."""
    role: str  # "system", "user", "assistant", "tool"
    content: str
    tool_calls: Optional[list[ToolCall]] = None
    tool_call_id: Optional[str] = None
    name: Optional[str] = None


class LLMProvider(ABC):
    """Abstract base class for LLM providers."""
    
    @abstractmethod
    async def chat(
        self,
        messages: list[ChatMessage],
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None,
    ) -> tuple[str, Optional[list[ToolCall]]]:
        """
        Send messages to the LLM and get a response.
        
        Returns:
            Tuple of (response_text, tool_calls)
        """
        raise NotImplementedError
    
    @abstractmethod
    async def chat_stream(
        self,
        messages: list[ChatMessage],
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        """
        Stream chat completions with optional tool calling.
        
        Yields:
            StreamEvent objects
        """
        raise NotImplementedError


class OpenAIProvider(LLMProvider):
    """OpenAI/GPT implementation with streaming and tool calling."""
    
    def __init__(self, model: str = "gpt-4o", api_key: Optional[str] = None):
        from openai import AsyncOpenAI
        self.model = model
        self.client = AsyncOpenAI(api_key=api_key)
    
    def _format_messages(
        self, 
        messages: list[ChatMessage], 
        system_prompt: Optional[str] = None
    ) -> list[dict]:
        """Convert ChatMessage objects to OpenAI format."""
        formatted = []
        
        if system_prompt:
            formatted.append({"role": "system", "content": system_prompt})
        
        for msg in messages:
            if msg.role == "tool":
                formatted.append({
                    "role": "tool",
                    "content": msg.content,
                    "tool_call_id": msg.tool_call_id,
                })
            elif msg.role == "assistant" and msg.tool_calls:
                formatted.append({
                    "role": "assistant",
                    "content": msg.content or "",
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": json.dumps(tc.arguments),
                            }
                        }
                        for tc in msg.tool_calls
                    ]
                })
            else:
                formatted.append({
                    "role": msg.role,
                    "content": msg.content,
                })
        
        return formatted
    
    async def chat(
        self,
        messages: list[ChatMessage],
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None,
    ) -> tuple[str, Optional[list[ToolCall]]]:
        """Non-streaming chat completion."""
        formatted_messages = self._format_messages(messages, system_prompt)
        
        kwargs = {
            "model": self.model,
            "messages": formatted_messages,
        }
        if tools:
            kwargs["tools"] = tools
        
        response = await self.client.chat.completions.create(**kwargs)
        choice = response.choices[0]
        
        tool_calls = None
        if choice.message.tool_calls:
            tool_calls = [
                ToolCall(
                    id=tc.id,
                    name=tc.function.name,
                    arguments=json.loads(tc.function.arguments),
                )
                for tc in choice.message.tool_calls
            ]
        
        return choice.message.content or "", tool_calls
    
    async def chat_stream(
        self,
        messages: list[ChatMessage],
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream chat completions with tool calling support."""
        formatted_messages = self._format_messages(messages, system_prompt)
        
        kwargs = {
            "model": self.model,
            "messages": formatted_messages,
            "stream": True,
        }
        if tools:
            kwargs["tools"] = tools
        
        try:
            yield StreamEvent(type="start")
            
            full_content = ""
            tool_calls_accumulator: dict[int, dict] = {}
            
            response = await self.client.chat.completions.create(**kwargs)
            
            async for chunk in response:
                delta = chunk.choices[0].delta if chunk.choices else None
                
                if delta is None:
                    continue
                
                # Handle text content
                if delta.content:
                    full_content += delta.content
                    yield StreamEvent(type="token", content=delta.content)
                
                # Handle tool calls
                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index
                        if idx not in tool_calls_accumulator:
                            tool_calls_accumulator[idx] = {
                                "id": "",
                                "name": "",
                                "arguments": "",
                            }
                        
                        if tc.id:
                            tool_calls_accumulator[idx]["id"] = tc.id
                        if tc.function:
                            if tc.function.name:
                                tool_calls_accumulator[idx]["name"] = tc.function.name
                            if tc.function.arguments:
                                tool_calls_accumulator[idx]["arguments"] += tc.function.arguments
            
            # Emit tool calls if any
            if tool_calls_accumulator:
                for idx in sorted(tool_calls_accumulator.keys()):
                    tc = tool_calls_accumulator[idx]
                    try:
                        args = json.loads(tc["arguments"]) if tc["arguments"] else {}
                    except json.JSONDecodeError:
                        args = {}
                    
                    yield StreamEvent(
                        type="tool_call",
                        tool_name=tc["name"],
                        tool_call_id=tc["id"],
                        tool_args=args,
                    )
            
            yield StreamEvent(type="end", full_response=full_content)
        
        except Exception as e:
            logger.error(f"OpenAI streaming error: {e}")
            yield StreamEvent(type="error", content=str(e))


class AnthropicProvider(LLMProvider):
    """Anthropic/Claude implementation with streaming and tool calling."""
    
    def __init__(self, model: str = "claude-3-opus-20240229", api_key: Optional[str] = None):
        from anthropic import AsyncAnthropic
        self.model = model
        self.client = AsyncAnthropic(api_key=api_key)
    
    def _format_messages(
        self, 
        messages: list[ChatMessage], 
        system_prompt: Optional[str] = None
    ) -> tuple[Optional[str], list[dict]]:
        """Convert ChatMessage objects to Anthropic format."""
        formatted = []
        
        for msg in messages:
            if msg.role == "system":
                # Anthropic handles system separately
                continue
            elif msg.role == "tool":
                formatted.append({
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": msg.tool_call_id,
                            "content": msg.content,
                        }
                    ]
                })
            elif msg.role == "assistant" and msg.tool_calls:
                content = []
                if msg.content:
                    content.append({"type": "text", "text": msg.content})
                for tc in msg.tool_calls:
                    content.append({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        "input": tc.arguments,
                    })
                formatted.append({"role": "assistant", "content": content})
            else:
                formatted.append({
                    "role": msg.role,
                    "content": msg.content,
                })
        
        return system_prompt, formatted
    
    def _format_tools(self, tools: Optional[list[dict]]) -> Optional[list[dict]]:
        """Convert OpenAI tool format to Anthropic format."""
        if not tools:
            return None
        
        anthropic_tools = []
        for tool in tools:
            if tool.get("type") == "function":
                func = tool["function"]
                anthropic_tools.append({
                    "name": func["name"],
                    "description": func.get("description", ""),
                    "input_schema": func.get("parameters", {"type": "object", "properties": {}}),
                })
        
        return anthropic_tools if anthropic_tools else None
    
    async def chat(
        self,
        messages: list[ChatMessage],
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None,
    ) -> tuple[str, Optional[list[ToolCall]]]:
        """Non-streaming chat completion."""
        system, formatted_messages = self._format_messages(messages, system_prompt)
        anthropic_tools = self._format_tools(tools)
        
        kwargs = {
            "model": self.model,
            "messages": formatted_messages,
            "max_tokens": 4096,
        }
        if system:
            kwargs["system"] = system
        if anthropic_tools:
            kwargs["tools"] = anthropic_tools
        
        response = await self.client.messages.create(**kwargs)
        
        text_content = ""
        tool_calls = []
        
        for block in response.content:
            if block.type == "text":
                text_content += block.text
            elif block.type == "tool_use":
                tool_calls.append(ToolCall(
                    id=block.id,
                    name=block.name,
                    arguments=block.input,
                ))
        
        return text_content, tool_calls if tool_calls else None
    
    async def chat_stream(
        self,
        messages: list[ChatMessage],
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream chat completions with tool calling support."""
        system, formatted_messages = self._format_messages(messages, system_prompt)
        anthropic_tools = self._format_tools(tools)
        
        kwargs = {
            "model": self.model,
            "messages": formatted_messages,
            "max_tokens": 4096,
            "stream": True,
        }
        if system:
            kwargs["system"] = system
        if anthropic_tools:
            kwargs["tools"] = anthropic_tools
        
        try:
            yield StreamEvent(type="start")
            
            full_content = ""
            current_tool: Optional[dict] = None
            tool_input_json = ""
            
            async with self.client.messages.stream(**kwargs) as stream:
                async for event in stream:
                    if event.type == "content_block_start":
                        if hasattr(event.content_block, "type"):
                            if event.content_block.type == "tool_use":
                                current_tool = {
                                    "id": event.content_block.id,
                                    "name": event.content_block.name,
                                }
                                tool_input_json = ""
                    
                    elif event.type == "content_block_delta":
                        if hasattr(event.delta, "text"):
                            full_content += event.delta.text
                            yield StreamEvent(type="token", content=event.delta.text)
                        elif hasattr(event.delta, "partial_json"):
                            tool_input_json += event.delta.partial_json
                    
                    elif event.type == "content_block_stop":
                        if current_tool:
                            try:
                                args = json.loads(tool_input_json) if tool_input_json else {}
                            except json.JSONDecodeError:
                                args = {}
                            
                            yield StreamEvent(
                                type="tool_call",
                                tool_name=current_tool["name"],
                                tool_call_id=current_tool["id"],
                                tool_args=args,
                            )
                            current_tool = None
                            tool_input_json = ""
            
            yield StreamEvent(type="end", full_response=full_content)
        
        except Exception as e:
            logger.error(f"Anthropic streaming error: {e}")
            yield StreamEvent(type="error", content=str(e))


class GeminiProvider(LLMProvider):
    """Google Gemini implementation with streaming and tool calling."""
    
    def __init__(self, model: str = "gemini-1.5-pro", api_key: Optional[str] = None):
        import google.generativeai as genai
        
        if api_key:
            genai.configure(api_key=api_key)
        
        self.model_name = model
        self.genai = genai
    
    def _format_messages(
        self,
        messages: list[ChatMessage],
        system_prompt: Optional[str] = None
    ) -> tuple[Optional[str], list[dict]]:
        """Convert ChatMessage objects to Gemini format."""
        history = []
        
        for msg in messages:
            if msg.role == "system":
                # Gemini handles system instruction separately
                continue
            elif msg.role == "user":
                history.append({
                    "role": "user",
                    "parts": [msg.content]
                })
            elif msg.role == "assistant":
                parts = []
                if msg.content:
                    parts.append(msg.content)
                if msg.tool_calls:
                    for tc in msg.tool_calls:
                        parts.append({
                            "function_call": {
                                "name": tc.name,
                                "args": tc.arguments
                            }
                        })
                history.append({
                    "role": "model",
                    "parts": parts if parts else [""]
                })
            elif msg.role == "tool":
                history.append({
                    "role": "user",
                    "parts": [{
                        "function_response": {
                            "name": msg.name or "unknown",
                            "response": {"result": msg.content}
                        }
                    }]
                })
        
        return system_prompt, history
    
    def _format_tools(self, tools: Optional[list[dict]]) -> Optional[list]:
        """Convert OpenAI tool format to Gemini format."""
        if not tools:
            return None
        
        function_declarations = []
        for tool in tools:
            if tool.get("type") == "function":
                func = tool["function"]
                function_declarations.append({
                    "name": func["name"],
                    "description": func.get("description", ""),
                    "parameters": func.get("parameters", {"type": "object", "properties": {}})
                })
        
        if not function_declarations:
            return None
        
        return [{"function_declarations": function_declarations}]
    
    async def chat(
        self,
        messages: list[ChatMessage],
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None,
    ) -> tuple[str, Optional[list[ToolCall]]]:
        """Non-streaming chat completion."""
        system, history = self._format_messages(messages, system_prompt)
        gemini_tools = self._format_tools(tools)
        
        # Create model with system instruction
        model_kwargs = {}
        if system:
            model_kwargs["system_instruction"] = system
        
        model = self.genai.GenerativeModel(
            model_name=self.model_name,
            **model_kwargs
        )
        
        # Start chat with history (excluding the last message which we'll send)
        chat_history = history[:-1] if len(history) > 1 else []
        last_message = history[-1]["parts"] if history else [""]
        
        chat = model.start_chat(history=chat_history)
        
        # Generate response
        generation_config = {"candidate_count": 1}
        
        response = await chat.send_message_async(
            last_message,
            generation_config=generation_config,
            tools=gemini_tools
        )
        
        # Extract text and tool calls
        text_content = ""
        tool_calls = []
        
        for part in response.parts:
            if hasattr(part, "text") and part.text:
                text_content += part.text
            elif hasattr(part, "function_call"):
                fc = part.function_call
                tool_calls.append(ToolCall(
                    id=f"gemini_{fc.name}_{len(tool_calls)}",
                    name=fc.name,
                    arguments=dict(fc.args) if fc.args else {},
                ))
        
        return text_content, tool_calls if tool_calls else None
    
    async def chat_stream(
        self,
        messages: list[ChatMessage],
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream chat completions with tool calling support."""
        system, history = self._format_messages(messages, system_prompt)
        gemini_tools = self._format_tools(tools)
        
        # Create model with system instruction
        model_kwargs = {}
        if system:
            model_kwargs["system_instruction"] = system
        
        model = self.genai.GenerativeModel(
            model_name=self.model_name,
            **model_kwargs
        )
        
        # Start chat with history (excluding the last message which we'll send)
        chat_history = history[:-1] if len(history) > 1 else []
        last_message = history[-1]["parts"] if history else [""]
        
        chat = model.start_chat(history=chat_history)
        
        try:
            yield StreamEvent(type="start")
            
            full_content = ""
            tool_calls = []
            
            # Generate streaming response
            response = await chat.send_message_async(
                last_message,
                tools=gemini_tools,
                stream=True
            )
            
            async for chunk in response:
                for part in chunk.parts:
                    if hasattr(part, "text") and part.text:
                        full_content += part.text
                        yield StreamEvent(type="token", content=part.text)
                    elif hasattr(part, "function_call"):
                        fc = part.function_call
                        tc = ToolCall(
                            id=f"gemini_{fc.name}_{len(tool_calls)}",
                            name=fc.name,
                            arguments=dict(fc.args) if fc.args else {},
                        )
                        tool_calls.append(tc)
                        yield StreamEvent(
                            type="tool_call",
                            tool_name=tc.name,
                            tool_call_id=tc.id,
                            tool_args=tc.arguments,
                        )
            
            yield StreamEvent(type="end", full_response=full_content)
        
        except Exception as e:
            logger.error(f"Gemini streaming error: {e}")
            yield StreamEvent(type="error", content=str(e))


class MockProvider(LLMProvider):
    """Mock provider for testing without API calls."""
    
    async def chat(
        self,
        messages: list[ChatMessage],
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None,
    ) -> tuple[str, Optional[list[ToolCall]]]:
        """Return a mock response."""
        last_msg = messages[-1].content if messages else "empty"
        return f"[Mock] Received: {last_msg}", None
    
    async def chat_stream(
        self,
        messages: list[ChatMessage],
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream a mock response."""
        import asyncio
        
        yield StreamEvent(type="start")
        
        last_msg = messages[-1].content if messages else "empty"
        response = f"At once, Sir. I received your message: {last_msg}"
        
        for word in response.split(" "):
            yield StreamEvent(type="token", content=word + " ")
            await asyncio.sleep(0.05)
        
        yield StreamEvent(type="end", full_response=response)


class N8NLegacyProvider(LLMProvider):
    """Legacy n8n webhook provider for backwards compatibility."""
    
    def __init__(self, webhook_url: str, timeout: int = 120):
        self.webhook_url = webhook_url
        self.timeout = timeout
    
    async def chat(
        self,
        messages: list[ChatMessage],
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None,
    ) -> tuple[str, Optional[list[ToolCall]]]:
        """Send message via n8n webhook (no tool support)."""
        import httpx
        
        last_msg = messages[-1].content if messages else ""
        session_id = "default"
        
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    self.webhook_url,
                    json={"message": last_msg, "sessionId": session_id},
                )
                result = response.json()
                
                text = result.get("response") or result.get("output") or result.get("text") or ""
                return text, None
        except Exception as e:
            logger.error(f"n8n webhook error: {e}")
            return f"Error: {e}", None
    
    async def chat_stream(
        self,
        messages: list[ChatMessage],
        tools: Optional[list[dict]] = None,
        system_prompt: Optional[str] = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        """n8n doesn't support streaming, so we fake it."""
        yield StreamEvent(type="start")
        
        response, _ = await self.chat(messages, tools, system_prompt)
        
        # Emit the full response as one token
        yield StreamEvent(type="token", content=response)
        yield StreamEvent(type="end", full_response=response)


def get_llm_provider(
    provider_type: str = "openai",
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    webhook_url: Optional[str] = None,
    timeout: int = 120,
) -> LLMProvider:
    """
    Get an LLM provider instance.
    
    Args:
        provider_type: Type of provider ('openai', 'anthropic', 'gemini', 'n8n', 'mock')
        model: Model name (provider-specific)
        api_key: API key for the provider
        webhook_url: Webhook URL for n8n provider
        timeout: Timeout for requests
        
    Returns:
        LLMProvider instance
    """
    if provider_type == "openai":
        return OpenAIProvider(
            model=model or "gpt-4o",
            api_key=api_key,
        )
    elif provider_type == "anthropic":
        return AnthropicProvider(
            model=model or "claude-3-opus-20240229",
            api_key=api_key,
        )
    elif provider_type == "gemini":
        return GeminiProvider(
            model=model or "gemini-1.5-pro",
            api_key=api_key,
        )
    elif provider_type == "n8n":
        if not webhook_url:
            raise ValueError("webhook_url required for n8n provider")
        return N8NLegacyProvider(webhook_url=webhook_url, timeout=timeout)
    elif provider_type == "mock":
        return MockProvider()
    else:
        raise ValueError(f"Unknown provider type: {provider_type}")


# Create provider from settings
def create_provider_from_settings() -> LLMProvider:
    """Create an LLM provider based on application settings."""
    from config import get_settings
    settings = get_settings()
    
    # Select the appropriate API key based on provider
    api_key = None
    if settings.llm_provider == "openai":
        api_key = settings.openai_api_key
    elif settings.llm_provider == "anthropic":
        api_key = settings.anthropic_api_key
    elif settings.llm_provider == "gemini":
        api_key = settings.gemini_api_key
    
    return get_llm_provider(
        provider_type=settings.llm_provider,
        model=settings.llm_model,
        api_key=api_key,
        webhook_url=settings.n8n_webhook_url,
        timeout=settings.n8n_timeout_seconds,
    )
