import type { ProposedAction } from './page-tools';

export type AssistantActionStatus =
  | 'pending'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'unknown'
  | 'dismissed';

export interface PageActionResult {
  success: boolean;
  error: string | null;
  /** The mutation may have happened but its acknowledgement was lost. Never auto-retry. */
  unknown?: boolean;
  /** Added by the controller after the persisted transition completes. */
  actionStatus?: AssistantActionStatus;
  /** Bounded tool output returned after a confirmed non-page action. */
  output?: string;
}

export interface AssistantActionRecord {
  id: string;
  action: ProposedAction;
  status: AssistantActionStatus;
  originTurnId: string;
  createdAt: number;
  updatedAt: number;
  result?: PageActionResult;
  /** Inline message Apply/Append is already the confirmation UI; do not render a second card. */
  presentation?: 'card' | 'inline';
  /** Persisted source for idempotent inline Apply/Append actions. */
  sourceMessageId?: string;
  sourceApplyMode?: 'replace' | 'append';
  /** Corrective action linkage; Generate is released only if the chain ends in applied. */
  supersedesActionId?: string;
  supersededByActionId?: string;
  /** Persisted selection for an ask_user card. */
  answer?: { optionIndex: number; text: string };
}

export function createActionRecord(
  action: ProposedAction,
  originTurnId: string,
  id = crypto.randomUUID(),
  now = Date.now()
): AssistantActionRecord {
  return { id, action, status: 'pending', originTurnId, createdAt: now, updatedAt: now };
}

export function isTerminalAction(status: AssistantActionStatus): boolean {
  return ['applied', 'failed', 'unknown', 'dismissed'].includes(status);
}

/** Applying after a crash is unknowable and must never silently become pending again. */
export function normalizeInterruptedActions(
  records: AssistantActionRecord[],
  now = Date.now()
): boolean {
  let changed = false;
  for (const record of records) {
    if (record.status !== 'applying') continue;
    record.status = 'unknown';
    record.updatedAt = now;
    record.result = {
      success: false,
      unknown: true,
      error: 'The extension restarted while applying this action. Check the page before retrying.',
    };
    changed = true;
  }
  return changed;
}

/**
 * Proposed page edits block Generate. Unrelated MCP/account actions do not.
 */
export function generateBlockers(records: AssistantActionRecord[]): AssistantActionRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const resolvesToApplied = (record: AssistantActionRecord, seen = new Set<string>()): boolean => {
    if (record.status === 'applied') return true;
    if (!record.supersededByActionId || seen.has(record.id)) return false;
    seen.add(record.id);
    const replacement = byId.get(record.supersededByActionId);
    return replacement ? resolvesToApplied(replacement, seen) : false;
  };
  return records.filter((record) => {
    if (record.action.kind === 'question') return record.status === 'pending';
    return record.action.kind !== 'generate' &&
      record.action.kind !== 'mcpTool' &&
      !resolvesToApplied(record);
  });
}

/** Build the hidden trusted event used to resume the model after Apply/Dismiss. */
export function actionResultMessage(
  record: AssistantActionRecord,
  effectivePageContext: unknown
): string {
  const action =
    record.action.kind === 'sourceImage'
      ? { ...record.action, url: '[conversation image omitted]' }
      : record.action;
  return [
    '[TRUSTED EXTENSION ACTION RESULT — not user-authored]',
    JSON.stringify({
      actionId: record.id,
      action,
      status: record.status,
      error: record.result?.error ?? null,
      output: record.result?.output ?? null,
      effectivePageContext,
    }),
    'Treat this result as authoritative. Replan from the effective state. Never claim a failed, unknown, or dismissed action succeeded. Generate always requires its own new proposal and confirmation.',
  ].join('\n');
}

/** Build the hidden trusted event used to resume after a visible question selection. */
export function userAnswerMessage(record: AssistantActionRecord): string {
  if (record.action.kind !== 'question' || !record.answer) {
    throw new Error('Cannot build a user-answer continuation without a persisted answer.');
  }
  return [
    '[TRUSTED EXTENSION USER ANSWER — selected through the visible question card]',
    JSON.stringify({
      questionId: record.id,
      question: record.action.question,
      selectedOption: {
        index: record.answer.optionIndex,
        text: record.answer.text,
      },
    }),
    "Treat this selection as the user's answer and continue the task from it. Do not ask the same question again unless new page state materially invalidates the answer. This selection does not approve a page mutation or generation; those still require their own proposal and confirmation.",
  ].join('\n');
}
