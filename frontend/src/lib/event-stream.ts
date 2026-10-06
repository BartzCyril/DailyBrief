export async function readEventStream<T>(response: Response, consume: (event: T) => void) {
  if (!response.body) throw new Error("Flux de progression indisponible.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const line = (value: string) => {
    if (value.trim()) consume(JSON.parse(value) as T);
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (chunk.done) break;
    }
    if (buffer.trim()) line(buffer);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
