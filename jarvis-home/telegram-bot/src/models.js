// Central Claude model registry.
//
// Every model ID JARVIS uses lives here, so bumping a tier (e.g. Haiku 4.5 → 5)
// or pointing a role at a different tier is a ONE-LINE change — ideally in
// ~/jarvis/.env, with no code edit at all.
//
// Tiers (override in .env):
//   MODEL_HAIKU   fast/cheap front-line — routing, classifiers, single-tool agents
//   MODEL_SONNET  balanced — research, complex MCP tool-chaining
//   MODEL_OPUS    heavy agentic — delegate, self-development, /deep
//   MODEL_FABLE   top tier — optional, for maximum depth (pricier/slower)
//   MODEL_FRONT   the front router model (defaults to the Haiku tier)
//
// Roles (fall back to a tier; override in .env for fine-grained control):
//   RESEARCH_MODEL, SELFDEV_MODEL, MCP_AGENT_MODEL, MCP_AGENT_MODEL_COMPLEX
//
// IMPORTANT: read env LAZILY (inside these getters). index.js loads ~/jarvis/.env
// into process.env at startup, but ES module top-level code runs BEFORE that — so
// a top-level `process.env.X` read would freeze to its default before the env is
// populated. Call these at request time and the .env overrides take effect.

export const haikuModel  = () => process.env.MODEL_HAIKU  || 'claude-haiku-4-5-20251001';
export const sonnetModel = () => process.env.MODEL_SONNET || 'claude-sonnet-5';
export const opusModel   = () => process.env.MODEL_OPUS   || 'claude-opus-5';
export const fableModel  = () => process.env.MODEL_FABLE  || 'claude-fable-5';

export const frontModel  = () => process.env.MODEL_FRONT  || haikuModel();

export const researchModel   = () => process.env.RESEARCH_MODEL          || sonnetModel();
export const selfDevModel    = () => process.env.SELFDEV_MODEL           || opusModel();
export const mcpSimpleModel  = () => process.env.MCP_AGENT_MODEL         || haikuModel();
export const mcpComplexModel = () => process.env.MCP_AGENT_MODEL_COMPLEX || sonnetModel();
