/**
 * Chat controller: the conversation flow (persist → stream → tools → persist),
 * extracted from the content script so the SAME logic drives the chat whether the
 * UI is the in-page overlay (direct DOM access) or the Chrome side panel (DOM
 * access via the page bridge). All page interaction goes through the PageAccess
 * interface; everything else (storage, LLM streaming via the background proxy,
 * CivitAI API tools) works identically in both contexts.
 */
import { sendMessageWithTools } from './api-client';
import { CIVITAI_TOOLS, executeCivitaiTool, civitaiToolsAvailable } from './civitai-tools';
import {
  executePageTool,
  isPageTool,
  pageToolsForForm,
  type ProposedAction,
} from './page-tools';
import {
  settingsStorage,
  activeConversationIdStorage,
  getActiveProvider,
  getConversation,
} from './storage';
import {
  saveConversation as saveConversationRpc,
  deleteConversation as deleteConversationRpc,
} from './conversation-rpc';
import type {
  ToolActivity,
  ChatMessage,
  Conversation,
  ExtensionSettings,
  FormState,
  GeneratorImage,
  ImagePart,
  ProviderConfig,
  GenerationParams,
} from './types';
import {
  createActionRecord,
  actionResultMessage,
  generateBlockers,
  isTerminalAction,
  normalizeInterruptedActions,
  userAnswerMessage,
  type AssistantActionRecord,
  type PageActionResult,
} from './action-state';
import {
  ensureChatImageNumbers,
  getChatImages,
  nextChatImageNumber,
} from './chat-images';
import {
  buildSystemPrompt,
  hasPromptPayload,
  parseAssistantMessage,
} from '@/entrypoints/civitai.content/prompt-parser';
import type { ChatPanel } from '@/entrypoints/civitai.content/chat-panel';
import { executeSiteMcpTool, getSiteMcpTools } from './civitai-mcp-rpc';
import { recordDebugEvent, recordChatFailure, sanitizeDiagnosticText } from './diagnostic-log';

/** How the controller reaches the CivitAI page. All async so an RPC impl fits. */
export interface PageAccess {
  onGeneratePage(): Promise<boolean>;
  formState(): Promise<FormState | null>;
  pageContext(): Promise<Record<string, unknown>>;
  pageImages(limit: number): Promise<string[]>;
  generatorImages(): Promise<GeneratorImage[]>;
  applyAction(action: ProposedAction): Promise<PageActionResult>;
  catalogTool?(name: string, args: string, token?: string, signal?: AbortSignal): Promise<string>;
}

export interface ChatControllerRuntime {
  getActiveConversationId(): Promise<string | null>;
  setActiveConversationId(id: string | null): Promise<void>;
  getConversation(id: string): Promise<Conversation | null>;
  saveConversation(conversation: Conversation): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  getActiveProvider(): Promise<ProviderConfig | null>;
  getSettings(): Promise<ExtensionSettings>;
  sendMessageWithTools: typeof sendMessageWithTools;
  getSiteMcpTools: typeof getSiteMcpTools;
  executeSiteMcpTool: typeof executeSiteMcpTool;
}

interface ActionContinuationUi {
  updateLastAssistant(content: string, messageId?: string, toolStatus?: string | null, toolActivity?: ToolActivity[]): void;
  setStreaming(streaming: boolean): void;
  setError(error: string | null): void;
  appendActionCard(action: AssistantActionRecord): void;
  notify(text: string): void;
}

export function createChatController(
  page: PageAccess,
  runtime: Partial<ChatControllerRuntime> = {}
) {
  const getActiveConversationId =
    runtime.getActiveConversationId ?? (() => activeConversationIdStorage.getValue());
  const setActiveConversationId =
    runtime.setActiveConversationId ?? ((id) => activeConversationIdStorage.setValue(id));
  const loadConversation = runtime.getConversation ?? getConversation;
  const save = runtime.saveConversation ?? saveConversationRpc;
  const loggedActionStates = new Map<string, string>();
  const persistConversation = async (conversation: Conversation) => {
    await save(conversation);
    for (const record of conversation.actions ?? []) {
      const key = `${conversation.id}:${record.id}`;
      if (loggedActionStates.get(key) === record.status) continue;
      loggedActionStates.set(key, record.status);
      void recordDebugEvent('chat', 'action.state', {
        conversationId: conversation.id, actionId: record.id,
        kind: record.action.kind, status: record.status,
        error: record.result?.error, sourceMessageId: record.sourceMessageId,
        supersedesActionId: record.supersedesActionId,
      });
    }
  };
  const removeConversation = runtime.deleteConversation ?? deleteConversationRpc;
  const loadActiveProvider = runtime.getActiveProvider ?? getActiveProvider;
  const loadSettings = runtime.getSettings ?? (() => settingsStorage.getValue());
  const streamMessages = runtime.sendMessageWithTools ?? sendMessageWithTools;
  const loadSiteMcpTools = runtime.getSiteMcpTools ?? getSiteMcpTools;
  const runSiteMcpTool = runtime.executeSiteMcpTool ?? executeSiteMcpTool;
  let activeStream: AbortController | null = null;
  const userStopReason = new DOMException('Response stopped.', 'AbortError');
  const resolvingActions = new Set<string>();
  let applyingAssistantMessage = false;
  const actionInProgress = () => resolvingActions.size > 0 || applyingAssistantMessage;

  const ensureMessageIds = (messages: ChatMessage[]): boolean => {
    let changed = false;
    for (const message of messages) {
      if (message.id) continue;
      message.id = crypto.randomUUID();
      changed = true;
    }
    return changed;
  };

  async function handleSendMessage(
    content: string,
    attachments: ImagePart[],
    appendToPanel: (msg: ChatMessage) => void,
    updateLastAssistant: (content: string, messageId?: string, toolStatus?: string | null, toolActivity?: ToolActivity[]) => void,
    setStreaming: (streaming: boolean) => void,
    setError: (error: string | null) => void,
    appendActionCard: (action: AssistantActionRecord) => void,
    notify: (text: string) => void = () => {},
    internal = false,
    continuationOfActionId?: string,
    expectedConversationId?: string,
  ) {
    if (!internal && actionInProgress()) {
      setError('Wait for the current action to finish before sending another message.');
      return;
    }
    // Outer boundary: storage/provider/persist failures BEFORE streaming must surface in
    // the UI too, not become an unhandled rejection after the composer already cleared.
    try {
      await sendFlow();
    } catch (err) {
      setStreaming(false);
      setError(err instanceof Error ? err.message : 'Something went wrong sending the message.');
    }

    async function sendFlow() {
    setError(null);

    // Get active provider
    const provider = await loadActiveProvider();
    if (!provider || !provider.apiKey) {
      setError('No API key configured. Open the extension settings to add your API key.');
      return;
    }

    // Get or create conversation
    const convId = await getActiveConversationId();
    if (expectedConversationId && convId !== expectedConversationId) return;
    let conversation: Conversation | null = convId ? ((await loadConversation(convId)) ?? null) : null;

    if (!conversation) {
      conversation = {
        id: crypto.randomUUID(),
        title: content.slice(0, 50) || (attachments.length ? 'Image chat' : 'New chat'),
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await setActiveConversationId(conversation.id);
    }
    ensureMessageIds(conversation.messages);
    ensureChatImageNumbers(conversation.messages);
    conversation.actions ??= [];

    // The panel pre-allocates visible numbers as images are pasted. Reconcile at the
    // persistence boundary too, so cross-window races or legacy conversations can never
    // produce two different attachments called "Image 3".
    const usedImageNumbers = new Set(getChatImages(conversation.messages).map((image) => image.number));
    let nextImageNumber = nextChatImageNumber(conversation.messages);
    for (const attachment of attachments) {
      if (
        !Number.isInteger(attachment.imageId) ||
        attachment.imageId! <= 0 ||
        usedImageNumbers.has(attachment.imageId!)
      ) {
        while (usedImageNumbers.has(nextImageNumber)) nextImageNumber++;
        attachment.imageId = nextImageNumber++;
      }
      usedImageNumbers.add(attachment.imageId!);
    }

    // Get settings for system prompt
    const settings = await loadSettings();
    // Rolling context (default on): caps request size/cost and avoids hard
    // context-length failures on long conversations.
    const rolling = settings.rollingContext ?? true;
    const keepTurns = Math.max(2, settings.contextTurns ?? 20);

    // Build system prompt with current form context
    const formContext: FormState | undefined = (await page.onGeneratePage().catch(() => false))
      ? ((await page.formState().catch(() => null)) ?? undefined)
      : undefined;
    const systemPrompt = buildSystemPrompt(settings.systemPrompt, formContext);
    // A confirmed action belongs to its original chat, even if the user changes
    // conversations while its page operation or context lookup is pending.
    if (expectedConversationId && (await getActiveConversationId()) !== expectedConversationId) return;

    // Add user message — multimodal when images are attached, plain string otherwise.
    const userContent: ChatMessage['content'] = attachments.length
      ? [...(content ? [{ type: 'text' as const, text: content }] : []), ...attachments]
      : content;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userContent,
      timestamp: Date.now(),
      ...(internal ? { internal: true } : {}),
    };
    conversation.messages.push(userMessage);
    if (!internal) appendToPanel(userMessage);
    // One-time heads-up, one turn before the rolling window starts sliding.
    const userTurns = conversation.messages.filter((m) => m.role === 'user' && !m.internal).length;
    if (rolling && !conversation.rollNoticeShown && userTurns >= keepTurns - 1) {
      conversation.rollNoticeShown = true;
      notify(
        `Rolling context: from turn ${keepTurns + 1}, only your last ${keepTurns} turns stay in the model's view (configurable in settings).`
      );
    }
    // Persist immediately so a failed stream doesn't orphan the user's message
    // (and the next send doesn't silently start a fresh conversation).
    conversation.updatedAt = Date.now();
    await persistConversation(conversation);

    // Prepare messages for API.
    const nonSystem = conversation.messages.filter((m) => m.role !== 'system');
    // Rolling window: keep everything from the Nth-from-last user turn onward. The
    // sliding start invalidates provider-side prefix caches for the message tail,
    // but the (large) system prompt stays a stable cached prefix.
    let windowed = nonSystem;
    if (rolling) {
      const userIdxs: number[] = [];
      nonSystem.forEach((m, i) => {
        if (m.role === 'user' && !m.internal) userIdxs.push(i);
      });
      if (userIdxs.length > keepTurns) windowed = nonSystem.slice(userIdxs[userIdxs.length - keepTurns]);
    }
    // Bound request size: keep image parts only in the most recent image-bearing
    // message; older images are replaced with a text placeholder (the model has
    // already seen them) so big base64 attachments aren't re-sent on every turn.
    let lastImageIdx = -1;
    for (let i = windowed.length - 1; i >= 0; i--) {
      const c = windowed[i].content;
      if (Array.isArray(c) && c.some((part) => part.type === 'image_url')) {
        lastImageIdx = i;
        break;
      }
    }
    const trimmed = windowed.map((m, i) => {
      if (i === lastImageIdx || !Array.isArray(m.content)) return m;
      if (!m.content.some((part) => part.type === 'image_url')) return m;
      const text = m.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      const numbers = m.content
        .filter((part): part is ImagePart => part.type === 'image_url')
        .map((part) => part.imageId)
        .filter((number): number is number => Number.isInteger(number));
      const omitted =
        numbers.length > 0
          ? `[Images ${numbers.join(', ')} omitted from this request; call view_chat_image to inspect one again.]`
          : '[image omitted]';
      return { ...m, content: text ? `${text}\n${omitted}` : omitted };
    });
    const apiMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt, timestamp: 0 },
      ...trimmed,
    ];

    // Stream response
    let fullResponse = '';
    const toolActivity: ToolActivity[] = [];
    const assistantMessageId = crypto.randomUUID();
    const abortController = new AbortController();
    activeStream?.abort();
    activeStream = abortController;
    setStreaming(true);

    // Civitai lookups (toggleable) + page-action tools (always available).
    const mcpMode = settings.civitaiMcpMode
      ?? (settings.civitaiToolsEnabled === false ? 'off' : 'read');
    const toolsOn = civitaiToolsAvailable(mcpMode !== 'off');
    const siteMcpTools = toolsOn
      ? await loadSiteMcpTools(
          mcpMode,
          settings.civitaiApiToken || undefined,
          abortController.signal
        ).catch(() => [])
      : [];
    const siteMcpByName = new Map(
      siteMcpTools.map((tool) => [tool.definition.function.name, tool])
    );
    const tools = [
      ...(toolsOn ? CIVITAI_TOOLS : []),
      ...siteMcpTools.map((tool) => tool.definition),
      ...pageToolsForForm(formContext),
    ];
    const originTurnId = crypto.randomUUID();
    void recordDebugEvent('chat', 'chat.request', {
      conversationId: conversation.id, turnId: originTurnId, model: provider.defaultModel,
      messageCount: apiMessages.length, toolCount: tools.length, internal,
    });

    // Throttled durability checkpoint: a side-panel document can be torn down mid-stream
    // (panel closed, window closed) with no chance to run our catch — persist the partial
    // reply every couple seconds so at most ~2s of streamed text can be lost.
    let lastCheckpoint = 0;
    const checkpointPartial = () => {
      if (!fullResponse && !toolActivity.length) return;
      void persistConversation({
        ...conversation!,
        messages: [
          ...conversation!.messages,
          { id: assistantMessageId, role: 'assistant', content: fullResponse, toolActivity: structuredClone(toolActivity), timestamp: Date.now() },
        ],
        updatedAt: Date.now(),
      }).catch(() => {});
    };

    try {
      abortController.signal.throwIfAborted();
      for await (const chunk of streamMessages(apiMessages, provider, {
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        signal: abortController.signal,
        tools,
        cacheableTools: [
          ...CIVITAI_TOOLS.map((tool) => tool.function.name),
          ...siteMcpTools.filter((tool) => tool.readOnly && /search|model|enum/.test(tool.definition.function.name))
            .map((tool) => tool.definition.function.name),
        ],
        sessionId: conversation.id,
        executeTool: async (name, args, signal) => {
          signal?.throwIfAborted();
          if (isPageTool(name)) {
            const { result, card, images } = await executePageTool(name, args, {
              getContext: () => page.pageContext(),
              getFormState: () => page.formState(),
              getPageImages: (limit) => page.pageImages(limit),
              getGeneratorImages: () => page.generatorImages(),
              getChatImages: () => getChatImages(conversation!.messages),
            });
            signal?.throwIfAborted();
            if (card?.kind === 'generate') {
              const blockers = generateBlockers(conversation!.actions ?? []);
              if (blockers.length) {
                return JSON.stringify({
                  error: 'Generate is blocked until earlier proposed edits are verified as applied.',
                  blockingActionIds: blockers.map((record) => record.id),
                });
              }
            }
            if (card) {
              const record = createActionRecord(card, originTurnId);
              const predecessor = continuationOfActionId
                ? conversation!.actions!.find(
                    (candidate) => candidate.id === continuationOfActionId
                  )
                : undefined;
              if (
                predecessor &&
                predecessor.action.kind === card.kind &&
                predecessor.status !== 'applied'
              ) {
                record.supersedesActionId = predecessor.id;
                predecessor.supersededByActionId = record.id;
                predecessor.updatedAt = Date.now();
              }
              conversation!.actions!.push(record);
              conversation!.updatedAt = Date.now();
              await persistConversation(conversation!);
              appendActionCard(record);
            }
            return images && images.length ? { content: result, images } : result;
          }
          const siteMcpTool = siteMcpByName.get(name);
          if (siteMcpTool) {
            if (siteMcpTool.readOnly) {
              return runSiteMcpTool(
                name,
                args,
                settings.civitaiApiToken || undefined,
                signal
              );
            }
            let parsedArgs: Record<string, unknown>;
            try {
              parsedArgs = args ? JSON.parse(args) : {};
            } catch {
              return JSON.stringify({ error: 'Could not parse Site MCP tool arguments.' });
            }
            const card: ProposedAction = {
              kind: 'mcpTool',
              toolName: name,
              args: parsedArgs,
              title: siteMcpTool.title,
              destructive: siteMcpTool.destructive,
            };
            const record = createActionRecord(card, originTurnId);
            conversation!.actions!.push(record);
            conversation!.updatedAt = Date.now();
            await persistConversation(conversation!);
            appendActionCard(record);
            return JSON.stringify({
              status: 'proposed',
              actionId: record.id,
              note: 'The user must confirm this CivitAI action before it executes.',
            });
          }
          if (name === 'search_civitai_loras' && formContext?.modelVersionId) {
            try {
              const parsed = JSON.parse(args || '{}');
              if (parsed && typeof parsed === 'object' && !parsed.baseModel && !parsed.checkpointVersionId) {
                args = JSON.stringify({ ...parsed, checkpointVersionId: formContext.modelVersionId });
              }
            } catch { /* The tool reports malformed arguments. */ }
          }
          return (page.catalogTool ?? executeCivitaiTool)(name, args, settings.civitaiApiToken || undefined, signal);
        },
      })) {
        abortController.signal.throwIfAborted();
        if (chunk.toolActivity) {
          const index = toolActivity.findIndex((tool) => tool.id === chunk.toolActivity!.id);
          if (index < 0) toolActivity.push(chunk.toolActivity);
          else toolActivity[index] = chunk.toolActivity;
          updateLastAssistant(fullResponse, assistantMessageId, null, structuredClone(toolActivity));
          checkpointPartial();
          continue;
        }
        if (chunk.toolRoundLimit !== undefined) {
          const notice = `Tool limit reached (${chunk.toolRoundLimit} rounds). Further lookups have stopped for this reply.`;
          fullResponse = `${fullResponse.trimEnd()}\n\n${notice}\n\n`.trimStart();
          updateLastAssistant(fullResponse, assistantMessageId);
          notify(notice);
          checkpointPartial();
          continue;
        }
        if (chunk.toolStatus !== undefined) {
          // Separate presentation channel: never mix transient activity with model prose.
          updateLastAssistant(fullResponse, assistantMessageId, chunk.toolStatus);
          continue;
        }
        fullResponse += chunk.delta;
        updateLastAssistant(fullResponse, assistantMessageId);
        if (Date.now() - lastCheckpoint > 2000) {
          lastCheckpoint = Date.now();
          checkpointPartial();
        }
      }

      abortController.signal.throwIfAborted();
      // Save assistant message
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: fullResponse,
        toolActivity,
        timestamp: Date.now(),
      };
      conversation.messages.push(assistantMessage);
      conversation.updatedAt = Date.now();
      await persistConversation(conversation);
      void recordDebugEvent('chat', 'chat.response', {
        conversationId: conversation.id, turnId: originTurnId,
        messageId: assistantMessageId, textLength: fullResponse.length,
      });
    } catch (err) {
      for (const tool of toolActivity) {
        if (tool.status === 'running') tool.status = abortController.signal.aborted ? 'cancelled' : 'failed';
      }
      if (abortController.signal.reason === userStopReason) {
        fullResponse = `${fullResponse.trimEnd()}\n\nResponse stopped.`.trimStart();
        updateLastAssistant(fullResponse, assistantMessageId);
      } else if (!abortController.signal.aborted && !(err instanceof Error && err.name === 'AbortError')) {
        const message = sanitizeDiagnosticText(err instanceof Error ? err.message : String(err)).slice(0, 1500);
        fullResponse = `${fullResponse.trimEnd()}\n\nResponse failed: ${message}`.trimStart();
        updateLastAssistant(fullResponse, assistantMessageId);
        setError(message);
        recordChatFailure({ conversationId: conversation.id, turnId: originTurnId,
          provider: provider.type, model: provider.defaultModel, error: message });
      }
      void recordDebugEvent('chat', abortController.signal.aborted ? 'chat.cancelled' : 'chat.error', {
        conversationId: conversation.id, turnId: originTurnId,
        userRequested: abortController.signal.reason === userStopReason,
        error: err instanceof Error ? err.message : String(err), textLength: fullResponse.length,
      });
      // Keep the store consistent with what the panel shows: persist any partial
      // assistant output that streamed before the error/abort.
      if (fullResponse || toolActivity.length) {
        if (!conversation.messages.some((message) => message.id === assistantMessageId)) {
          conversation.messages.push({
            id: assistantMessageId,
            role: 'assistant',
            content: fullResponse,
            toolActivity,
            timestamp: Date.now(),
          });
        }
        conversation.updatedAt = Date.now();
        await persistConversation(conversation).catch(() => {});
      }
    } finally {
      if (activeStream === abortController) activeStream = null;
      updateLastAssistant(fullResponse, assistantMessageId, null, toolActivity);
      setStreaming(false);
    }
    } // end sendFlow
  }

  return {
    handleSendMessage,

    /** Keep the turn busy until cancellation cleanup has saved its partial response. */
    stop() {
      activeStream?.abort(userStopReason);
    },

    /** Abort any in-flight stream (panel closed / torn down). */
    abort() {
      activeStream?.abort();
      activeStream = null;
    },

    /** Whether a stream is currently in flight (used to gate external re-renders). */
    isBusy(): boolean {
      return activeStream !== null;
    },

    /** Replay the active saved conversation into a freshly mounted panel. */
    async restoreConversation(panel: ChatPanel) {
      const convId = await getActiveConversationId();
      if (!convId) return;
      const conv = await loadConversation(convId);
      // Guard the await gap: if the user cleared/switched conversations while we loaded,
      // rendering the stale transcript would resurrect it on top of the new state.
      if ((await getActiveConversationId()) !== convId) return;
      if (conv?.messages.length) {
        conv.actions ??= [];
        const recoveredInterruptedAction = normalizeInterruptedActions(conv.actions);
        const recoveredMessageIds = ensureMessageIds(conv.messages);
        const recoveredImageNumbers = ensureChatImageNumbers(conv.messages);
        if (recoveredMessageIds || recoveredImageNumbers) {
          conv.updatedAt = Date.now();
          await persistConversation(conv);
        }
        if (recoveredInterruptedAction) {
          conv.updatedAt = Date.now();
          await persistConversation(conv);
        }
        panel.renderConversation(conv.messages);
        panel.renderActions(conv.actions);
      }
    },

    /** Resolve once. Successful Apply finishes locally; failures can resume for explanation. */
    async handleResolveAction(
      actionId: string,
      decision: 'apply' | 'dismiss',
      updateLastAssistant?: ActionContinuationUi['updateLastAssistant'],
      setStreaming?: ActionContinuationUi['setStreaming'],
      setError?: ActionContinuationUi['setError'],
      appendActionCard?: ActionContinuationUi['appendActionCard'],
      notify?: ActionContinuationUi['notify']
    ): Promise<PageActionResult> {
      if (activeStream) {
        return { success: false, error: 'Wait for the current assistant response to finish.' };
      }
      if (actionInProgress()) {
        return { success: false, error: 'Wait for the current action to finish.' };
      }
      resolvingActions.add(actionId);
      try {
        const convId = await getActiveConversationId();
        const conversation = convId ? await loadConversation(convId) : null;
        const record = conversation?.actions?.find((candidate) => candidate.id === actionId);
        if (!conversation || !record) {
          return { success: false, error: 'This action no longer belongs to the active conversation.' };
        }
        if (isTerminalAction(record.status)) {
          return record.result
            ? { ...record.result, actionStatus: record.status }
            : {
            success: record.status === 'applied',
            error: `This action is already ${record.status}.`,
            actionStatus: record.status,
          };
        }
        if (record.status === 'applying') {
          return { success: false, unknown: true, error: 'This action may already be applying.' };
        }

        if (decision === 'dismiss') {
          record.status = 'dismissed';
          record.updatedAt = Date.now();
          record.result = { success: false, error: 'The user dismissed this proposed action.' };
          conversation.updatedAt = record.updatedAt;
          await persistConversation(conversation);
          if (updateLastAssistant && setStreaming && setError && appendActionCard) {
            const effectiveContext = await page.pageContext().catch(() => ({
              error: 'Page context unavailable after dismissal.',
            }));
            await handleSendMessage(
              actionResultMessage(record, effectiveContext),
              [],
              () => {},
              updateLastAssistant,
              setStreaming,
              setError,
              appendActionCard,
              notify,
              true,
              record.id,
              conversation.id
            );
          }
          return { ...record.result, actionStatus: record.status };
        }

        if (record.action.kind === 'question') {
          return { success: false, error: 'Choose one of the displayed answers.' };
        }

        // A Generate card can outlive the state in which it was proposed.
        // Recheck at confirmation, before persisting or submitting the mutation.
        if (record.action.kind === 'generate' && generateBlockers(conversation.actions ?? []).length) {
          return { success: false, error: 'Generate is blocked until earlier proposed edits are verified as applied.' };
        }

        record.status = 'applying';
        record.updatedAt = Date.now();
        conversation.updatedAt = record.updatedAt;
        await persistConversation(conversation);

        let result: PageActionResult;
        if (record.action.kind === 'mcpTool') {
          const settings = await loadSettings();
          try {
            const output = await runSiteMcpTool(
              record.action.toolName,
              JSON.stringify(record.action.args),
              settings.civitaiApiToken || undefined
            );
            let error: string | undefined;
            try {
              const envelope = JSON.parse(output) as { error?: unknown };
              if (typeof envelope.error === 'string') error = envelope.error;
            } catch {
              // A non-JSON MCP response is still useful output from a completed call.
            }
            result = error
              ? { success: false, error, output }
              : { success: true, error: null, output };
          } catch {
            result = {
              success: false,
              unknown: true,
              error: 'Lost contact while running the CivitAI action. It may or may not have completed.',
            };
          }
        } else {
          try {
            result = await page.applyAction(record.action);
          } catch {
            result = {
              success: false,
              unknown: true,
              error: 'Lost contact while applying the action. Check the page; it may or may not have applied.',
            };
          }
        }
        record.status = result.unknown ? 'unknown' : result.success ? 'applied' : 'failed';
        record.result = result;
        record.updatedAt = Date.now();
        conversation.updatedAt = record.updatedAt;
        if (record.status === 'applied') {
          conversation.messages.push({
            id: crypto.randomUUID(), role: 'user', internal: true, timestamp: Date.now(),
            content: actionResultMessage(record, { note: 'Applied by the user. Read current page state if needed on the next user turn.' }),
          });
        }
        await persistConversation(conversation);
        if (record.status !== 'applied' && updateLastAssistant && setStreaming && setError && appendActionCard) {
          const effectiveContext = await page.pageContext().catch(() => ({
            error: 'Page context unavailable after applying the action.',
          }));
          await handleSendMessage(
            actionResultMessage(record, effectiveContext),
            [],
            () => {},
            updateLastAssistant,
            setStreaming,
            setError,
            appendActionCard,
            notify,
            true,
            record.id,
            conversation.id
          );
        }
        return { ...result, actionStatus: record.status };
      } finally {
        resolvingActions.delete(actionId);
      }
    },

    /** Persist one visible ask_user selection, then resume the assistant exactly once. */
    async handleAnswerQuestion(
      actionId: string,
      optionIndex: number,
      updateLastAssistant?: ActionContinuationUi['updateLastAssistant'],
      setStreaming?: ActionContinuationUi['setStreaming'],
      setError?: ActionContinuationUi['setError'],
      appendActionCard?: ActionContinuationUi['appendActionCard'],
      notify?: ActionContinuationUi['notify']
    ): Promise<PageActionResult> {
      if (activeStream) {
        return { success: false, error: 'Wait for the current assistant response to finish.' };
      }
      if (actionInProgress()) {
        return { success: false, error: 'Wait for the current action to finish.' };
      }
      resolvingActions.add(actionId);
      try {
        const convId = await getActiveConversationId();
        const conversation = convId ? await loadConversation(convId) : null;
        const record = conversation?.actions?.find((candidate) => candidate.id === actionId);
        if (!conversation || !record || record.action.kind !== 'question') {
          return { success: false, error: 'This question no longer belongs to the active conversation.' };
        }
        if (record.status === 'applied' && record.answer) {
          return { success: true, error: null, actionStatus: 'applied' };
        }
        if (record.status !== 'pending') {
          return {
            success: false,
            error: `This question is already ${record.status}.`,
            actionStatus: record.status,
          };
        }
        const text = record.action.options[optionIndex];
        if (!Number.isInteger(optionIndex) || text === undefined) {
          return { success: false, error: 'Choose one of the displayed answers.' };
        }

        record.answer = { optionIndex, text };
        record.status = 'applied';
        record.result = { success: true, error: null };
        record.updatedAt = Date.now();
        conversation.updatedAt = record.updatedAt;
        await persistConversation(conversation);

        if (updateLastAssistant && setStreaming && setError && appendActionCard) {
          await handleSendMessage(
            userAnswerMessage(record),
            [],
            () => {},
            updateLastAssistant,
            setStreaming,
            setError,
            appendActionCard,
            notify,
            true,
            record.id,
            conversation.id
          );
        }
        return { success: true, error: null, actionStatus: 'applied' };
      } finally {
        resolvingActions.delete(actionId);
      }
    },

    /**
     * Apply/Append on a normal assistant prompt card is itself user confirmation. Route it
     * through the same persisted, verified action state machine as `propose_prompt`, but do
     * not render a redundant second confirmation card. Success finishes locally;
     * failures resume the model with verified diagnostics so it can explain what happened.
     */
    async handleApplyAssistantMessage(
      sourceMessageId: string,
      mode: 'replace' | 'append',
      updateLastAssistant?: ActionContinuationUi['updateLastAssistant'],
      setStreaming?: ActionContinuationUi['setStreaming'],
      setError?: ActionContinuationUi['setError'],
      appendActionCard?: ActionContinuationUi['appendActionCard'],
      notify?: ActionContinuationUi['notify']
    ): Promise<PageActionResult> {
      if (activeStream) {
        return { success: false, error: 'Wait for the current assistant response to finish.' };
      }
      if (actionInProgress()) {
        return { success: false, error: 'Wait for the current action to finish.' };
      }
      applyingAssistantMessage = true;
      try {
        const convId = await getActiveConversationId();
        const conversation = convId ? await loadConversation(convId) : null;
        if (!conversation) {
          return { success: false, error: 'This prompt no longer belongs to the active conversation.' };
        }
        conversation.actions ??= [];
        const existing = [...conversation.actions].reverse().find(
          (record) =>
            record.presentation === 'inline' &&
            record.sourceMessageId === sourceMessageId &&
            record.sourceApplyMode === mode
        );
        // Replacing after a definite failure is a fresh, explicit retry. Appending may
        // already have partially succeeded, so never append the same text twice.
        if (existing && (existing.status !== 'failed' || mode === 'append')) {
          if (existing.status === 'applying') {
            return {
              success: false,
              unknown: true,
              error: 'This prompt may already be applying.',
              actionStatus: existing.status,
            };
          }
          return existing.result
            ? { ...existing.result, actionStatus: existing.status }
            : {
                success: existing.status === 'applied',
                error: `This prompt action is already ${existing.status}.`,
                actionStatus: existing.status,
              };
        }
        const sourceMessage = conversation.messages.find(
          (message) => message.id === sourceMessageId && message.role === 'assistant'
        );
        if (!sourceMessage || typeof sourceMessage.content !== 'string') {
          return { success: false, error: 'This prompt no longer belongs to the active conversation.' };
        }
        if (!hasPromptPayload(sourceMessage.content)) {
          return { success: false, error: 'This message contains no prompt payload to apply.' };
        }
        const parsed = parseAssistantMessage(sourceMessage.content);
        if (!parsed.positivePrompt) {
          return { success: false, error: 'No prompt found in the response.' };
        }

        const form = await page.formState().catch(() => null);
        const available = form?.availableFields?.length
          ? new Set(form.availableFields)
          : undefined;
        const joinPrompt = (existing: string | undefined, addition: string) =>
          mode === 'append' && existing?.trim()
            ? `${existing.trim()}, ${addition}`
            : addition;
        const positive = joinPrompt(form?.prompt, parsed.positivePrompt);
        const negative = parsed.negativePrompt && (!available || available.has('negativePrompt'))
          ? joinPrompt(form?.negativePrompt, parsed.negativePrompt)
          : undefined;
        const paramFields: Array<keyof GenerationParams> = [
          'cfgScale',
          'steps',
          'sampler',
          'seed',
          'clipSkip',
          'aspectRatio',
          'duration',
          'resolution',
          'generateAudio',
        ];
        const params: GenerationParams = {};
        for (const field of paramFields) {
          const value = parsed.params?.[field];
          if (value !== undefined && (!available || available.has(field))) {
            (params as Record<string, unknown>)[field] = value;
          }
        }
        const action: Extract<ProposedAction, { kind: 'prompt' }> = {
          kind: 'prompt',
          positive,
          negative,
          params: Object.keys(params).length ? params : undefined,
        };
        const record = createActionRecord(action, sourceMessageId);
        if (existing?.status === 'failed') {
          record.supersedesActionId = existing.id;
          existing.supersededByActionId = record.id;
          existing.updatedAt = Date.now();
        }
        record.presentation = 'inline';
        record.sourceMessageId = sourceMessageId;
        record.sourceApplyMode = mode;
        record.status = 'applying';
        record.updatedAt = Date.now();
        conversation.actions.push(record);
        conversation.updatedAt = record.updatedAt;
        await persistConversation(conversation);

        let result: PageActionResult;
        try {
          result = await page.applyAction(action);
        } catch {
          result = {
            success: false,
            unknown: true,
            error: 'Lost contact while applying the prompt. Check the page; it may or may not have applied.',
          };
        }
        record.status = result.unknown ? 'unknown' : result.success ? 'applied' : 'failed';
        record.result = result;
        record.updatedAt = Date.now();
        conversation.updatedAt = record.updatedAt;
        await persistConversation(conversation);

        if (
          record.status !== 'applied' && updateLastAssistant && setStreaming && setError && appendActionCard &&
          (await getActiveConversationId()) === conversation.id
        ) {
          // Show the observed error immediately, even if the provider is unavailable.
          setError(result.error);
          const effectiveContext = await page.pageContext().catch(() => ({
            error: 'Page context unavailable after applying the prompt.',
          }));
          await handleSendMessage(
            actionResultMessage(record, effectiveContext), [], () => {},
            updateLastAssistant, setStreaming, setError, appendActionCard, notify,
            true, record.id, conversation.id
          );
        }
        return { ...result, actionStatus: record.status };
      } finally {
        applyingAssistantMessage = false;
      }
    },

    async handleNewConversation() {
      activeStream?.abort();
      activeStream = null;
      await setActiveConversationId(null);
    },

    async handleDeleteConversation(id: string) {
      await removeConversation(id);
    },
  };
}

/** What createChatController returns; handy for wiring into panel options. */
export type ChatController = ReturnType<typeof createChatController>;
