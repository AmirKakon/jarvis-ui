"""AI Orchestrator service with streaming and tool execution."""
import json
import logging
from typing import AsyncGenerator, Optional
from dataclasses import dataclass

from services.llm_provider import (
    LLMProvider, ChatMessage, ToolCall, StreamEvent,
    create_provider_from_settings,
)
from services.tool_registry import tool_registry
from prompts.jarvis import JARVIS_SYSTEM_PROMPT

logger = logging.getLogger(__name__)


@dataclass
class OrchestratorEvent:
    """Event emitted by the orchestrator during processing."""
    type: str  # "start", "token", "tool_call", "tool_result", "end", "error"
    content: str = ""
    tool_name: Optional[str] = None
    tool_args: Optional[dict] = None
    tool_result: Optional[dict] = None
    full_response: Optional[str] = None


class Orchestrator:
    """
    AI Orchestrator that manages conversation flow, tool execution, and streaming.
    
    Handles the agentic loop:
    1. Send user message to LLM
    2. If LLM requests tool call, execute it and feed result back
    3. Continue until LLM produces final response
    4. Stream tokens to client throughout
    """
    
    def __init__(
        self,
        llm_provider: Optional[LLMProvider] = None,
        system_prompt: str = JARVIS_SYSTEM_PROMPT,
        max_tool_iterations: int = 10,
    ):
        self.llm_provider = llm_provider or create_provider_from_settings()
        self.system_prompt = system_prompt
        self.max_tool_iterations = max_tool_iterations
        self.tools = tool_registry.get_schemas()
    
    async def process_message(
        self,
        user_message: str,
        conversation_history: Optional[list[ChatMessage]] = None,
    ) -> AsyncGenerator[OrchestratorEvent, None]:
        """
        Process a user message with streaming and tool execution.
        
        Args:
            user_message: The user's message
            conversation_history: Previous messages in the conversation
            
        Yields:
            OrchestratorEvent objects representing the processing flow
        """
        # Build messages list
        messages = conversation_history.copy() if conversation_history else []
        messages.append(ChatMessage(role="user", content=user_message))
        
        yield OrchestratorEvent(type="start")
        
        full_response = ""
        iteration = 0
        
        while iteration < self.max_tool_iterations:
            iteration += 1
            
            try:
                pending_tool_calls: list[ToolCall] = []
                current_text = ""
                
                # Stream response from LLM
                async for event in self.llm_provider.chat_stream(
                    messages=messages,
                    tools=self.tools if iteration == 1 or pending_tool_calls else self.tools,
                    system_prompt=self.system_prompt,
                ):
                    if event.type == "token":
                        current_text += event.content
                        yield OrchestratorEvent(type="token", content=event.content)
                    
                    elif event.type == "tool_call":
                        pending_tool_calls.append(ToolCall(
                            id=event.tool_call_id or f"call_{len(pending_tool_calls)}",
                            name=event.tool_name,
                            arguments=event.tool_args or {},
                        ))
                        yield OrchestratorEvent(
                            type="tool_call",
                            tool_name=event.tool_name,
                            tool_args=event.tool_args,
                        )
                    
                    elif event.type == "error":
                        yield OrchestratorEvent(type="error", content=event.content)
                        return
                    
                    elif event.type == "end":
                        if event.full_response:
                            current_text = event.full_response
                
                # If there are tool calls, execute them
                if pending_tool_calls:
                    # Add assistant message with tool calls to history
                    messages.append(ChatMessage(
                        role="assistant",
                        content=current_text,
                        tool_calls=pending_tool_calls,
                    ))
                    
                    # Execute each tool
                    for tool_call in pending_tool_calls:
                        logger.info(f"Executing tool: {tool_call.name} with args: {tool_call.arguments}")
                        
                        result = await tool_registry.execute(
                            tool_call.name,
                            tool_call.arguments,
                        )
                        
                        yield OrchestratorEvent(
                            type="tool_result",
                            tool_name=tool_call.name,
                            tool_result=result,
                        )
                        
                        # Add tool result to messages
                        messages.append(ChatMessage(
                            role="tool",
                            content=json.dumps(result),
                            tool_call_id=tool_call.id,
                            name=tool_call.name,
                        ))
                    
                    # Continue the loop to get LLM's response to tool results
                    continue
                
                # No tool calls, we have the final response
                full_response = current_text
                break
            
            except Exception as e:
                logger.error(f"Orchestrator error in iteration {iteration}: {e}")
                yield OrchestratorEvent(type="error", content=str(e))
                return
        
        if iteration >= self.max_tool_iterations:
            logger.warning(f"Max tool iterations ({self.max_tool_iterations}) reached")
            yield OrchestratorEvent(
                type="error",
                content="Maximum tool iterations reached. Please try a simpler request."
            )
            return
        
        yield OrchestratorEvent(type="end", full_response=full_response)
    
    async def process_message_simple(
        self,
        user_message: str,
        conversation_history: Optional[list[ChatMessage]] = None,
    ) -> str:
        """
        Process a message and return the final response (non-streaming).
        
        Useful for simple integrations that don't need streaming.
        """
        full_response = ""
        
        async for event in self.process_message(user_message, conversation_history):
            if event.type == "end":
                full_response = event.full_response or ""
            elif event.type == "error":
                full_response = f"Error: {event.content}"
        
        return full_response


def create_orchestrator() -> Orchestrator:
    """Create an orchestrator instance with default settings."""
    return Orchestrator()


# Global orchestrator instance (lazy initialization)
_orchestrator: Optional[Orchestrator] = None


def get_orchestrator() -> Orchestrator:
    """Get the global orchestrator instance."""
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = create_orchestrator()
    return _orchestrator

