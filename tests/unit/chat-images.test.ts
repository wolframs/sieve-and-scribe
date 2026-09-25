import { describe, expect, it } from 'vitest';
import {
  ensureChatImageNumbers,
  getChatImages,
  nextChatImageNumber,
  toProviderContent,
} from '@/lib/chat-images';
import type { ChatMessage, ImagePart } from '@/lib/types';

const image = (url: string, imageId?: number): ImagePart => ({
  type: 'image_url',
  image_url: { url },
  ...(imageId !== undefined ? { imageId } : {}),
});

describe('conversation image identities', () => {
  it('numbers legacy images, preserves valid ids, and repairs duplicates', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        timestamp: 1,
        content: [image('data:image/png;base64,a'), image('data:image/png;base64,b', 4)],
      },
      {
        role: 'user',
        timestamp: 2,
        content: [image('data:image/png;base64,c', 4)],
      },
    ];

    expect(ensureChatImageNumbers(messages)).toBe(true);
    expect(getChatImages(messages).map((entry) => entry.number)).toEqual([1, 4, 5]);
    expect(nextChatImageNumber(messages)).toBe(6);
    expect(ensureChatImageNumbers(messages)).toBe(false);
  });

  it('labels provider pixels and strips extension-only image metadata', () => {
    const content = toProviderContent([
      { type: 'text', text: 'Animate this.' },
      {
        ...image('data:image/png;base64,abc', 3),
        imageName: 'private-local-name.png',
      },
    ]);

    expect(content).toEqual([
      { type: 'text', text: 'Animate this.' },
      { type: 'text', text: 'Image 3:' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,abc' },
      },
    ]);
  });
});
