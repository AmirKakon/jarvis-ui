// Central model registry (Claude + the small OpenAI jobs).
//
// Every model ID JARVIS uses lives here, so bumping a tier (e.g. Haiku 5.5 → 6)
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
// OpenAI (override in .env):
//   OPENAI_SMALL_MODEL       backup router + memory summaries; must be a GPT-6 model that
//                            accepts reasoning_effort "none" (gpt-6-luna, gpt-6.1-terra, gpt-6-sol)
//   OPENAI_TRANSCRIBE_MODEL  voice-note transcription
//
// IMPORTANT: read env LAZILY (inside these getters). index.js loads ~/jarvis/.env
// into process.env at startup, but ES module top-level code runs BEFORE that — so
// a top-level `process.env.X` read would freeze to its default before the env is
// populated. Call these at request time and the .env overrides take effect.

export const haikuModel  = () => process.env.MODEL_HAIKU  || 'claude-haiku-5-5';
export const sonnetModel = () => process.env.MODEL_SONNET || 'claude-sonnet-5-5';
export const opusModel   = () => process.env.MODEL_OPUS   || 'claude-opus-5-5';
export const fableModel  = () => process.env.MODEL_FABLE  || 'claude-fable-5-1';

export const frontModel  = () => process.env.MODEL_FRONT  || haikuModel();

export const researchModel   = () => process.env.RESEARCH_MODEL          || sonnetModel();
export const selfDevModel    = () => process.env.SELFDEV_MODEL           || opusModel();
export const mcpSimpleModel  = () => process.env.MCP_AGENT_MODEL         || haikuModel();
export const mcpComplexModel = () => process.env.MCP_AGENT_MODEL_COMPLEX || sonnetModel();

export const openaiSmallModel = () => process.env.OPENAI_SMALL_MODEL      || 'gpt-6-luna';
export const transcribeModel  = () => process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe';

// Haiku 5.x thinks by default and thinking counts toward max_tokens, which would eat the
// small budgets of routing/extraction calls. Other models get no extra fields: older ones
// don't think unless asked, and Opus/Fable 5.5 reject "disabled".
export function quickCallOptions(model) {
  return /haiku-5/.test(model) ? { thinking: { type: 'disabled' } } : {};
}
