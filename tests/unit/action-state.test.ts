import { describe, expect, it } from 'vitest';
import {
  createActionRecord,
  actionResultMessage,
  generateBlockers,
  normalizeInterruptedActions,
} from '@/lib/action-state';

describe('persisted assistant action state', () => {
  it('creates stable pending records with an origin turn', () => {
    expect(
      createActionRecord(
        { kind: 'prompt', positive: 'rainy Berlin' },
        'turn-1',
        'action-1',
        100
      )
    ).toEqual({
      id: 'action-1',
      action: { kind: 'prompt', positive: 'rainy Berlin' },
      status: 'pending',
      originTurnId: 'turn-1',
      createdAt: 100,
      updatedAt: 100,
    });
  });

  it('marks interrupted applying actions unknown instead of retryable', () => {
    const record = createActionRecord({ kind: 'generate' }, 'turn-1', 'action-1', 100);
    record.status = 'applying';

    expect(normalizeInterruptedActions([record], 200)).toBe(true);
    expect(record).toMatchObject({
      status: 'unknown',
      updatedAt: 200,
      result: { success: false, unknown: true },
    });
  });

  it('blocks Generate on every non-applied prerequisite outcome', () => {
    const statuses = ['pending', 'applying', 'failed', 'unknown', 'dismissed', 'applied'] as const;
    const records = statuses.map((status, index) => ({
      ...createActionRecord({ kind: 'prompt', positive: String(index) }, 'turn', String(index), 1),
      status,
    }));

    expect(generateBlockers(records).map((record) => record.status)).toEqual([
      'pending',
      'applying',
      'failed',
      'unknown',
      'dismissed',
    ]);
  });

  it('releases a failed chain only when its corrective replacement is applied', () => {
    const failed = createActionRecord(
      { kind: 'prompt', positive: 'first' },
      'turn-1',
      'first',
      1
    );
    failed.status = 'failed';
    failed.supersededByActionId = 'second';
    const replacement = createActionRecord(
      { kind: 'prompt', positive: 'corrected' },
      'turn-2',
      'second',
      2
    );
    replacement.supersedesActionId = 'first';

    expect(generateBlockers([failed, replacement]).map((record) => record.id)).toEqual([
      'first',
      'second',
    ]);
    replacement.status = 'applied';
    expect(generateBlockers([failed, replacement])).toEqual([]);
  });

  it('does not make an unrelated confirmed MCP action a Generate prerequisite', () => {
    const mcp = createActionRecord(
      { kind: 'mcpTool', toolName: 'toggle_favorite', args: { imageId: 42 } },
      'turn', 'mcp-1', 1
    );
    expect(generateBlockers([mcp])).toEqual([]);
  });

  it('blocks Generate only while a question is waiting for an answer', () => {
    const question = createActionRecord(
      { kind: 'question', question: 'Which style?', options: ['Real', 'Anime'] },
      'turn', 'question-1', 1
    );
    expect(generateBlockers([question])).toEqual([question]);
    question.status = 'dismissed';
    expect(generateBlockers([question])).toEqual([]);
    question.status = 'applied';
    expect(generateBlockers([question])).toEqual([]);
  });

  it('builds a trusted continuation event without duplicating source-image bytes', () => {
    const record = createActionRecord(
      {
        kind: 'sourceImage',
        imageNumber: 2,
        url: 'data:image/png;base64,secret-pixels',
        slot: 'firstFrame',
      },
      'turn',
      'action-2',
      1
    );
    record.status = 'failed';
    record.result = { success: false, error: 'upload mismatch' };

    const message = actionResultMessage(record, { form: { prompt: '' } });
    expect(message).toContain('TRUSTED EXTENSION ACTION RESULT');
    expect(message).toContain('upload mismatch');
    expect(message).toContain('conversation image omitted');
    expect(message).not.toContain('secret-pixels');
  });
});
