type JsonObjectRequest = {
  messages: Array<Record<string, unknown>>;
  response_format?: unknown;
};

export const JSON_OBJECT_USER_INSTRUCTION = '请只输出符合上述字段定义的 JSON 对象。';

/**
 * Some OpenAI-compatible gateways require the JSON mode instruction to appear in a user
 * message, even when a system message already specifies JSON output. Preserve the original
 * prompt and payload, adding only this instruction to the last user message.
 */
export function withJsonObjectUserInstruction<T extends JsonObjectRequest>(request: T): T {
  if (!isJsonObjectFormat(request.response_format)) return request;

  const messages = [...request.messages];
  let userMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      userMessageIndex = index;
      break;
    }
  }

  if (userMessageIndex < 0) {
    messages.push({ role: 'user', content: JSON_OBJECT_USER_INSTRUCTION });
  } else {
    const message = { ...messages[userMessageIndex] };
    const content = message.content;
    if (typeof content === 'string') {
      if (!content.includes(JSON_OBJECT_USER_INSTRUCTION)) {
        message.content = `${content}\n\n${JSON_OBJECT_USER_INSTRUCTION}`;
      }
    } else if (Array.isArray(content)) {
      if (
        !content.some(
          (part) =>
            typeof part === 'object' &&
            part !== null &&
            'text' in part &&
            (part as { text?: unknown }).text === JSON_OBJECT_USER_INSTRUCTION,
        )
      ) {
        message.content = [...content, { type: 'text', text: JSON_OBJECT_USER_INSTRUCTION }];
      }
    } else {
      messages.push({ role: 'user', content: JSON_OBJECT_USER_INSTRUCTION });
      return { ...request, messages };
    }
    messages[userMessageIndex] = message;
  }

  return { ...request, messages };
}

function isJsonObjectFormat(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { type?: unknown }).type === 'json_object'
  );
}
