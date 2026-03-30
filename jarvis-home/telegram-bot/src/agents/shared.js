const TOOL_RESULT_TYPES = ['web_search_tool_result', 'web_fetch_tool_result', 'code_execution_result'];

function extractResponseContent(data) {
  const blocks = data.content || [];
  const lastToolIdx = blocks.findLastIndex((b) => TOOL_RESULT_TYPES.includes(b.type));
  const hasToolResults = lastToolIdx >= 0;

  const textParts = [];
  const sources = new Map();

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== 'text') continue;
    if (hasToolResults && i <= lastToolIdx) continue;

    textParts.push(block.text);
    for (const cite of (block.citations || [])) {
      if (cite.url && !sources.has(cite.url)) {
        sources.set(cite.url, cite.title || cite.url);
      }
    }
  }

  return {
    text: textParts.join('').trim(),
    sources: [...sources.entries()].map(([url, title]) => ({ url, title })),
    searched: hasToolResults,
  };
}

export { TOOL_RESULT_TYPES, extractResponseContent };
