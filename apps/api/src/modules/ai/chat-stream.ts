/** Preserve already-sent deltas, but terminate failed public streams with a safe protocol error. */
export async function* forwardChatStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } catch {
    // Headers may already be sent. Never append [DONE] or expose upstream exception text.
    yield Buffer.from(
      `data: ${JSON.stringify({ error: { code: 'STREAM_INCOMPLETE', message: '模型回答未完整结束，已显示的内容可能不完整，请重试。' } })}\n\n`,
    );
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
