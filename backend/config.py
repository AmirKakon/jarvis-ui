"""Configuration settings for Jarvis UI backend."""
import os
from pydantic_settings import BaseSettings
from functools import lru_cache
from typing import Optional


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Server settings
    host: str = "0.0.0.0"
    port: int = 20005
    
    # Database settings (required - must be set in .env)
    database_url: str
    
    # Memory database (optional - defaults to main database)
    memory_database_url: Optional[str] = None
    
    # LLM Provider settings
    llm_provider: str = "openai"  # openai, anthropic, gemini, n8n, mock
    llm_model: str = "gpt-4o"
    
    # OpenAI settings
    openai_api_key: Optional[str] = None
    
    # Anthropic settings
    anthropic_api_key: Optional[str] = None
    
    # Google Gemini settings
    gemini_api_key: Optional[str] = None
    
    # n8n Tool Executor settings
    n8n_tool_executor_url: Optional[str] = None
    n8n_timeout_seconds: int = 120
    
    # n8n API settings (for direct workflow execution)
    n8n_api_url: Optional[str] = None  # e.g., http://192.168.1.100:20003/api/v1
    n8n_api_key: Optional[str] = None  # n8n API key for authentication
    
    # Legacy n8n webhook (for fallback/compatibility)
    n8n_webhook_url: Optional[str] = None
    
    # Session settings
    session_ttl_days: int = 30
    
    # CORS settings
    cors_origins: str = "*"
    
    # Streaming settings
    stream_enabled: bool = True
    
    # SSL verification (disable if behind corporate proxy with self-signed certs)
    verify_ssl: bool = True
    
    @property
    def effective_memory_db_url(self) -> str:
        """Get the memory database URL, defaulting to main database."""
        return self.memory_database_url or self.database_url
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
