"""Configuration settings for Jarvis UI backend."""
import os
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Server settings
    host: str = "0.0.0.0"
    port: int = 20004
    
    # Database settings (required - must be set in .env)
    database_url: str
    
    # n8n settings (required - must be set in .env)
    n8n_webhook_url: str
    n8n_timeout_seconds: int = 60
    
    # Session settings
    session_ttl_days: int = 30
    
    # CORS settings
    cors_origins: str = "*"
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()

