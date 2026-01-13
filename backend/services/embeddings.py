"""Embedding service for semantic search using OpenAI embeddings."""
import logging
from typing import Optional, List
from config import get_settings

logger = logging.getLogger(__name__)

# OpenAI embedding model and dimensions
EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536


class EmbeddingService:
    """Service for generating and searching embeddings."""
    
    def __init__(self):
        self._client = None
    
    @property
    def client(self):
        """Lazy-load OpenAI client."""
        if self._client is None:
            from openai import AsyncOpenAI
            settings = get_settings()
            self._client = AsyncOpenAI(api_key=settings.openai_api_key)
        return self._client
    
    async def create_embedding(self, text: str) -> Optional[List[float]]:
        """
        Create an embedding vector for the given text.
        
        Args:
            text: The text to embed
            
        Returns:
            List of floats representing the embedding vector, or None on error
        """
        if not text or not text.strip():
            logger.warning("Empty text provided for embedding")
            return None
        
        try:
            response = await self.client.embeddings.create(
                model=EMBEDDING_MODEL,
                input=text.strip(),
            )
            return response.data[0].embedding
        except Exception as e:
            logger.error(f"Failed to create embedding: {e}")
            return None
    
    async def create_embeddings_batch(self, texts: List[str]) -> List[Optional[List[float]]]:
        """
        Create embeddings for multiple texts in a single API call.
        
        Args:
            texts: List of texts to embed
            
        Returns:
            List of embedding vectors (or None for failed items)
        """
        if not texts:
            return []
        
        # Filter out empty texts but keep track of indices
        valid_texts = []
        valid_indices = []
        for i, text in enumerate(texts):
            if text and text.strip():
                valid_texts.append(text.strip())
                valid_indices.append(i)
        
        if not valid_texts:
            return [None] * len(texts)
        
        try:
            response = await self.client.embeddings.create(
                model=EMBEDDING_MODEL,
                input=valid_texts,
            )
            
            # Map results back to original indices
            results = [None] * len(texts)
            for i, embedding_data in enumerate(response.data):
                original_idx = valid_indices[i]
                results[original_idx] = embedding_data.embedding
            
            return results
        except Exception as e:
            logger.error(f"Failed to create batch embeddings: {e}")
            return [None] * len(texts)
    
    def cosine_similarity(self, vec1: List[float], vec2: List[float]) -> float:
        """
        Calculate cosine similarity between two vectors.
        
        Args:
            vec1: First vector
            vec2: Second vector
            
        Returns:
            Cosine similarity score (0-1)
        """
        import math
        
        dot_product = sum(a * b for a, b in zip(vec1, vec2))
        norm1 = math.sqrt(sum(a * a for a in vec1))
        norm2 = math.sqrt(sum(b * b for b in vec2))
        
        if norm1 == 0 or norm2 == 0:
            return 0.0
        
        return dot_product / (norm1 * norm2)


# Global instance
embedding_service = EmbeddingService()

