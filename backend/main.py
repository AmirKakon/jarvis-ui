"""FastAPI application entry point for Jarvis UI backend."""
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import os

from config import get_settings
from database.db import init_db, close_db
from routers import api, websocket

# Configure logging
# Set to DEBUG to see streaming chunks in console
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events."""
    # Startup
    logger.info("Starting Jarvis UI backend...")
    try:
        await init_db()
        logger.info("Database initialized")
    except Exception as e:
        logger.warning(f"Database initialization skipped (run migrations first): {e}")
    
    yield
    
    # Shutdown
    logger.info("Shutting down Jarvis UI backend...")
    await close_db()


# Create FastAPI app
app = FastAPI(
    title="Jarvis UI",
    description="Web UI for Jarvis AI Assistant",
    version="1.0.0",
    lifespan=lifespan,
)

# Configure CORS
origins = settings.cors_origins.split(",") if settings.cors_origins != "*" else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(api.router)
app.include_router(websocket.router)

# Serve static files from frontend build (if exists)
frontend_dist = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.exists(frontend_dist):
    app.mount("/assets", StaticFiles(directory=os.path.join(frontend_dist, "assets")), name="assets")
    
    @app.get("/")
    async def serve_frontend():
        """Serve the frontend application."""
        return FileResponse(os.path.join(frontend_dist, "index.html"))
    
    @app.get("/{path:path}")
    async def serve_frontend_routes(path: str):
        """Serve frontend for all other routes (SPA support)."""
        file_path = os.path.join(frontend_dist, path)
        if os.path.exists(file_path) and os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(frontend_dist, "index.html"))
else:
    @app.get("/")
    async def root():
        """Root endpoint when frontend is not built."""
        return {
            "message": "Jarvis UI Backend",
            "docs": "/docs",
            "websocket": "/ws/{session_id}",
        }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
    )

