import type { ChatMessage, ContentPart, ImagePart } from './types';

export interface ChatImage {
  number: number;
  url: string;
  name?: string;
}

function imageParts(messages: ChatMessage[]): ImagePart[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part): part is ImagePart => part.type === 'image_url')
      : []
  );
}

/**
 * Give every saved image a unique, stable number within its conversation.
 * Existing valid numbers survive; legacy/duplicate parts receive the next free number.
 */
export function ensureChatImageNumbers(messages: ChatMessage[]): boolean {
  const used = new Set<number>();
  let next = 1;
  let changed = false;

  for (const part of imageParts(messages)) {
    let number = part.imageId;
    if (!Number.isInteger(number) || number! <= 0 || used.has(number!)) {
      while (used.has(next)) next++;
      number = next;
      part.imageId = number;
      changed = true;
    }
    used.add(number!);
    next = Math.max(next, number! + 1);
  }
  return changed;
}

export function nextChatImageNumber(messages: ChatMessage[]): number {
  return (
    imageParts(messages).reduce(
      (max, part) => Math.max(max, Number.isInteger(part.imageId) ? part.imageId! : 0),
      0
    ) + 1
  );
}

export function getChatImages(messages: ChatMessage[]): ChatImage[] {
  return imageParts(messages)
    .filter((part): part is ImagePart & { imageId: number } => Number.isInteger(part.imageId))
    .map((part) => ({
      number: part.imageId,
      url: part.image_url.url,
      ...(part.imageName ? { name: part.imageName } : {}),
    }));
}

/** Strip extension-only metadata and place a visible label immediately before every image. */
export function toProviderContent(content: string | ContentPart[]): string | ContentPart[] {
  if (typeof content === 'string') return content;
  const result: ContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      result.push(part);
      continue;
    }
    if (Number.isInteger(part.imageId)) {
      result.push({ type: 'text', text: `Image ${part.imageId}:` });
    }
    result.push({
      type: 'image_url',
      image_url: {
        url: part.image_url.url,
        ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
      },
    });
  }
  return result;
}
