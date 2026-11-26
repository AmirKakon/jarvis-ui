// Telegram swipe-reply: the quoted message arrives as ctx.message.reply_to_message,
// not in ctx.message.text. Prepend it so the model sees what the user is answering.

const MAX_QUOTE_LENGTH = 1000;

export function withReplyContext(text, replyTo) {
  if (!text?.trim()) return text;
  const quoted = (replyTo?.text || replyTo?.caption || '').trim();
  if (!quoted) return text;
  const clipped = quoted.length > MAX_QUOTE_LENGTH ? `${quoted.slice(0, MAX_QUOTE_LENGTH)}…` : quoted;
  return `The user is replying to this earlier message:\n"""\n${clipped}\n"""\n\n${text}`;
}
