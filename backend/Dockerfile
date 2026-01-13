# Jarvis UI Backend Dockerfile
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create a non-root user
RUN useradd --create-home appuser && chown -R appuser:appuser /app
USER appuser

# Expose the backend port
EXPOSE 20005

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:20005/api/health')" || exit 1

# Run the application (production mode without reload)
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "20005"]

