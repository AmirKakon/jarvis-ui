"""Knowledge-graph memory service (backend read path).

Provides graph-augmented retrieval over durable facts:
  1. Vector-search memory_facts for seed facts relevant to the query
  2. Always include identity/preference facts (parity with the Telegram bot)
  3. Expand through the graph (recursive CTE over graph_relations) to pull in
     connected facts and the relation triples traversed
  4. Format the result into a compact context block

The traversal SQL mirrors `expandFactsViaGraph` in the Telegram bot's
memory.js so both surfaces behave identically.

Extraction/writes live primarily in the bot; this module is read-only.
"""
import logging
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import get_settings
from services.embeddings import embedding_service

logger = logging.getLogger(__name__)

ALWAYS_INCLUDE_CATEGORIES = ["identity", "preference"]
SEED_FACT_LIMIT = 12
FACT_RETRIEVAL_THRESHOLD = 0.20
MAX_FACTS_IN_CONTEXT = 25


class GraphMemoryService:
    """Graph-augmented retrieval over memory_facts + graph_relations."""

    async def _vector_seed_facts(
        self, db: AsyncSession, query_text: str,
        embedding: Optional[list[float]] = None,
    ) -> list[dict]:
        """Return facts most semantically similar to the query."""
        if embedding is None:
            embedding = await embedding_service.create_embedding(query_text)
        if not embedding:
            # Fallback: most recent non-always-include facts
            result = await db.execute(
                text(
                    """
                    SELECT id, content, category
                    FROM memory_facts
                    WHERE category IS NULL OR NOT (category = ANY(:always))
                    ORDER BY created_at DESC
                    LIMIT :limit
                    """
                ),
                {"always": ALWAYS_INCLUDE_CATEGORIES, "limit": SEED_FACT_LIMIT},
            )
            return [dict(r._mapping) for r in result.fetchall()]

        embedding_str = f"[{','.join(str(x) for x in embedding)}]"
        result = await db.execute(
            text(
                """
                SELECT id, content, category,
                       1 - (embedding <=> :embedding::vector) AS similarity
                FROM memory_facts
                WHERE embedding IS NOT NULL
                  AND 1 - (embedding <=> :embedding::vector) >= :threshold
                ORDER BY embedding <=> :embedding::vector
                LIMIT :limit
                """
            ),
            {
                "embedding": embedding_str,
                "threshold": FACT_RETRIEVAL_THRESHOLD,
                "limit": SEED_FACT_LIMIT,
            },
        )
        return [dict(r._mapping) for r in result.fetchall()]

    async def _always_include_facts(self, db: AsyncSession) -> list[dict]:
        result = await db.execute(
            text(
                """
                SELECT id, content, category
                FROM memory_facts
                WHERE category = ANY(:always)
                ORDER BY created_at
                """
            ),
            {"always": ALWAYS_INCLUDE_CATEGORIES},
        )
        return [dict(r._mapping) for r in result.fetchall()]

    async def expand_facts_via_graph(
        self, db: AsyncSession, seed_fact_ids: list[int],
        query_embedding: Optional[list[float]] = None,
    ) -> dict:
        """
        Expand from seed facts' entities out to graph_max_hops, returning
        connected facts and the relation triples traversed.

        Connected facts are pulled only through NON-HUB entities (hubs like
        "User" link to nearly everything) and, when a query embedding is given,
        ranked by similarity to the query instead of arbitrary id order.
        """
        settings = get_settings()
        if not seed_fact_ids:
            return {"facts": [], "relations": []}

        params = {
            "ids": seed_fact_ids,
            "min_conf": settings.graph_relation_min_confidence,
            "max_hops": settings.graph_max_hops,
        }

        rel_result = await db.execute(
            text(
                """
                WITH RECURSIVE seed_entities AS (
                    SELECT DISTINCT entity_id AS id FROM fact_entities WHERE fact_id = ANY(:ids)
                ),
                reachable AS (
                    SELECT id, 0 AS depth FROM seed_entities
                    UNION
                    SELECT CASE WHEN r.subject_entity_id = rc.id THEN r.object_entity_id
                                ELSE r.subject_entity_id END AS id,
                           rc.depth + 1 AS depth
                    FROM reachable rc
                    JOIN graph_relations r
                      ON (r.subject_entity_id = rc.id OR r.object_entity_id = rc.id)
                     AND r.confidence >= :min_conf
                    WHERE rc.depth < :max_hops
                )
                SELECT DISTINCT r.id, r.predicate, r.confidence,
                       s.name AS subject, o.name AS object
                FROM graph_relations r
                JOIN reachable rs ON rs.id = r.subject_entity_id
                JOIN reachable ro ON ro.id = r.object_entity_id
                JOIN graph_entities s ON s.id = r.subject_entity_id
                JOIN graph_entities o ON o.id = r.object_entity_id
                WHERE r.confidence >= :min_conf
                ORDER BY r.confidence DESC
                LIMIT :limit
                """
            ),
            {**params, "limit": settings.graph_max_relations_in_context},
        )
        relations = [dict(r._mapping) for r in rel_result.fetchall()]

        fact_params = {
            **params,
            "limit": settings.graph_max_related_facts,
            "hub": settings.graph_hub_degree_threshold,
        }

        if query_embedding:
            fact_params["embedding"] = f"[{','.join(str(x) for x in query_embedding)}]"
            fact_params["fact_threshold"] = FACT_RETRIEVAL_THRESHOLD
            fact_sql = """
                WITH RECURSIVE seed_entities AS (
                    SELECT DISTINCT entity_id AS id FROM fact_entities WHERE fact_id = ANY(:ids)
                ),
                reachable AS (
                    SELECT id, 0 AS depth FROM seed_entities
                    UNION
                    SELECT CASE WHEN r.subject_entity_id = rc.id THEN r.object_entity_id
                                ELSE r.subject_entity_id END AS id,
                           rc.depth + 1 AS depth
                    FROM reachable rc
                    JOIN graph_relations r
                      ON (r.subject_entity_id = rc.id OR r.object_entity_id = rc.id)
                     AND r.confidence >= :min_conf
                    WHERE rc.depth < :max_hops
                ),
                non_hub AS (
                    SELECT rc.id FROM reachable rc
                    WHERE (SELECT COUNT(*) FROM fact_entities fe WHERE fe.entity_id = rc.id) <= :hub
                )
                SELECT DISTINCT f.id, f.content, f.category,
                       1 - (f.embedding <=> :embedding::vector) AS similarity
                FROM memory_facts f
                JOIN fact_entities fe ON fe.fact_id = f.id
                JOIN non_hub rc ON rc.id = fe.entity_id
                WHERE NOT (f.id = ANY(:ids))
                  AND f.embedding IS NOT NULL
                  AND 1 - (f.embedding <=> :embedding::vector) >= :fact_threshold
                ORDER BY similarity DESC
                LIMIT :limit
            """
        else:
            fact_sql = """
                WITH RECURSIVE seed_entities AS (
                    SELECT DISTINCT entity_id AS id FROM fact_entities WHERE fact_id = ANY(:ids)
                ),
                reachable AS (
                    SELECT id, 0 AS depth FROM seed_entities
                    UNION
                    SELECT CASE WHEN r.subject_entity_id = rc.id THEN r.object_entity_id
                                ELSE r.subject_entity_id END AS id,
                           rc.depth + 1 AS depth
                    FROM reachable rc
                    JOIN graph_relations r
                      ON (r.subject_entity_id = rc.id OR r.object_entity_id = rc.id)
                     AND r.confidence >= :min_conf
                    WHERE rc.depth < :max_hops
                ),
                non_hub AS (
                    SELECT rc.id FROM reachable rc
                    WHERE (SELECT COUNT(*) FROM fact_entities fe WHERE fe.entity_id = rc.id) <= :hub
                )
                SELECT DISTINCT f.id, f.content, f.category
                FROM memory_facts f
                JOIN fact_entities fe ON fe.fact_id = f.id
                JOIN non_hub rc ON rc.id = fe.entity_id
                WHERE NOT (f.id = ANY(:ids))
                ORDER BY f.id
                LIMIT :limit
            """

        fact_result = await db.execute(text(fact_sql), fact_params)
        facts = [dict(r._mapping) for r in fact_result.fetchall()]

        return {"facts": facts, "relations": relations}

    async def build_graph_context(self, db: AsyncSession, query_text: str) -> str:
        """
        Build the durable-facts context block, graph-augmented.

        Returns a markdown block (or empty string) suitable for appending to
        the system prompt.
        """
        settings = get_settings()

        # Embed the query once; reuse for vector seeding and graph fact ranking.
        query_embedding = await embedding_service.create_embedding(query_text)

        always_facts = await self._always_include_facts(db)
        seed_facts = await self._vector_seed_facts(db, query_text, query_embedding)

        # Seed the graph traversal from always-include + vector-seed facts
        seed_ids = list({f["id"] for f in always_facts} | {f["id"] for f in seed_facts})
        expansion = {"facts": [], "relations": []}
        if settings.graph_enabled and seed_ids:
            try:
                expansion = await self.expand_facts_via_graph(db, seed_ids, query_embedding)
            except Exception as e:
                logger.warning(f"Graph expansion failed, using vector facts only: {e}")

        # Merge facts, dedup by id, cap
        seen: set[int] = set()
        ordered_facts: list[dict] = []
        for f in [*always_facts, *seed_facts, *expansion["facts"]]:
            if f["id"] in seen:
                continue
            seen.add(f["id"])
            ordered_facts.append(f)
            if len(ordered_facts) >= MAX_FACTS_IN_CONTEXT:
                break

        if not ordered_facts and not expansion["relations"]:
            return ""

        lines: list[str] = []
        if ordered_facts:
            lines.append("\n\n## Permanent Facts\n")
            for f in ordered_facts:
                lines.append(f"- {f['content']}")

        if expansion["relations"]:
            lines.append("\n## Related Knowledge (graph)\n")
            for r in expansion["relations"]:
                predicate = str(r["predicate"]).replace("_", " ")
                lines.append(f"- {r['subject']} {predicate} {r['object']}")

        lines.append("")
        return "\n".join(lines)


# Global instance
graph_memory_service = GraphMemoryService()
