import { describe, expect, it } from 'vitest';
import {
  JSON_OBJECT_USER_INSTRUCTION,
  withJsonObjectUserInstruction,
} from '../src/modules/ai/json-object-request';

describe('JSON object request compatibility', () => {
  it('adds an explicit output instruction to the last user message without replacing its payload', () => {
    const source = {
      messages: [
        { role: 'system', content: 'Return JSON.' },
        { role: 'user', content: '{"learnerTranslation":"A synthetic sentence."}' },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 500,
    };

    const normalized = withJsonObjectUserInstruction(source);

    expect(normalized.messages[0]).toEqual(source.messages[0]);
    expect(normalized.messages[1].content).toBe(
      `{"learnerTranslation":"A synthetic sentence."}\n\n${JSON_OBJECT_USER_INSTRUCTION}`,
    );
    expect(normalized.response_format).toEqual({ type: 'json_object' });
    expect(normalized.max_tokens).toBe(500);
    expect(source.messages[1].content).toBe('{"learnerTranslation":"A synthetic sentence."}');
  });

  it('does not change requests without JSON object mode and avoids duplicate suffixes', () => {
    const plain = { messages: [{ role: 'user', content: 'Speak naturally.' }] };
    expect(withJsonObjectUserInstruction(plain)).toBe(plain);

    const structured = {
      messages: [{ role: 'user', content: `Return JSON.\n\n${JSON_OBJECT_USER_INSTRUCTION}` }],
      response_format: { type: 'json_object' },
    };
    expect(withJsonObjectUserInstruction(structured).messages[0].content).toBe(
      structured.messages[0].content,
    );
  });

  it('keeps multimodal user content and supplies a user message when one is absent', () => {
    const multimodal = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this picture.' }] }],
      response_format: { type: 'json_object' },
    };
    const normalized = withJsonObjectUserInstruction(multimodal);
    expect(normalized.messages[0].content).toEqual([
      { type: 'text', text: 'Describe this picture.' },
      { type: 'text', text: JSON_OBJECT_USER_INSTRUCTION },
    ]);

    const noUser = {
      messages: [{ role: 'system', content: 'Return JSON.' }],
      response_format: { type: 'json_object' },
    };
    expect(withJsonObjectUserInstruction(noUser).messages.at(-1)).toEqual({
      role: 'user',
      content: JSON_OBJECT_USER_INSTRUCTION,
    });
  });
});
