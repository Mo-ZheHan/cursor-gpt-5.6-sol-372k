'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  BACKGROUND_COMPLETION_DISPATCH,
  BACKGROUND_SUMMARY_MARKER,
  CHECKPOINT_MARKER,
  COMPOSER_CHAT_SERVICE_TOKEN,
  CONVERSATION_CHECKPOINT,
  MODEL_CATALOG_NORMALIZATION,
  MODEL_MARKER,
  MODEL_PARAMETER_RESOLUTION,
  SUBMISSION_ABORT_STATE,
  SUBMISSION_ENTRY,
  SUBMISSION_PENDING_QUESTIONNAIRE,
  SUMMARY_MARKER,
  UI_MARKER,
  alignContextLimit,
  disableLibraryValidation,
  executablePattern,
  inspect,
  mapContextLabel,
  needsSummarization,
  normalizeSubmissionParameters,
  patchWorkbenchSource,
  productChecksum,
} = require('../patch-cursor');

const MODEL_CATALOG =
  'return filter(models,localModels,feature.localMode)}' +
  'getModelPickerDisplayConfiguration';
const CHAT_SERVICE_TOKEN =
  'function createDecorator(name){return name}' +
  'const chatServiceToken=createDecorator("composerChatService");';
const CHECKPOINT =
  'handleConversationCheckpoint(checkpoint,composer,model,epoch){' +
  'if(epoch!==void 0&&epoch!==(composer.data._checkpointEpoch??0))return;' +
  'const details=checkpoint.tokenDetails,breakdown=details;' +
  'this.received=checkpoint}';
const MODEL_RESOLUTION =
  'resolveModelParametersForSubmission(modelId,selected,maxMode){' +
  'const model=this.getAvailableDefaultModels().find(' +
  'candidate=>candidate.name===modelId);' +
  'if(!model||!model.parameterDefinitions||' +
  'model.parameterDefinitions.length===0)return[];' +
  'const effective=selected&&selected.length>0?selected:' +
  'this.getModelParameterPreferences(modelId)?.parameters??[];' +
  'return resolve(model,effective,maxMode)?.parameterValues??[]}';
const SUBMISSION =
  'async submitChatMaybeAbortCurrent(id,text,options){' +
  'var disposables=[];try{' +
  'const composer=await this._composerDataService.getComposerHandleById(id);' +
  'this.events.push("precheck");' +
  'if(options?.blockSubmission){this.events.push("blocked");return}' +
  'const pendingQuestionnaire=composer.data.pendingQuestionnaire===true;' +
  'this._composerDataService.updateComposerDataSetStore(' +
  'composer,update=>update("status","generating"));' +
  'let humanBubble={bubbleId:"new-message",' +
  'conversationState:composer.data.conversationState},' +
  'requestState=composer.data.conversationState;' +
  'if(options.bubbleId){humanBubble=this._composerDataService.' +
  'getComposerBubbleUntracked(composer,options.bubbleId);' +
  'requestState=humanBubble.conversationState;' +
  'this._composerDataService.updateComposerDataSetStore(' +
  'composer,update=>update("conversationState",humanBubble.conversationState));' +
  'this.events.push("rollback")}' +
  'abortSpan.setAttribute("pendingQuestionnaire",pendingQuestionnaire),' +
  'this._structuredLogService.info("composer","Aborting current chat");' +
  'this.events.push("abort");' +
  'if(options.bubbleId===void 0){const current=' +
  'this._composerDataService.getComposerData(composer);' +
  'current&&(requestState=current.conversationState,' +
  'this._composerDataService.updateComposerBubbleSetStore(' +
  'composer,humanBubble.bubbleId,' +
  'update=>update("conversationState",requestState)))}abortSpan.end();' +
  'this.requestState=requestState;' +
  'this.statusAtStream=composer.data.status;' +
  'this.events.push("submit")}' +
  'finally{}}';
const BACKGROUND_COMPLETION =
  'async _maybeDispatchBackgroundCompletions(id){' +
  'const handle=this._composerDataService.getHandleIfLoaded(id);' +
  'if(!handle)return;' +
  'const data=this._composerDataService.getComposerData(handle);' +
  'if(data?.isNAL!==!0||data.chatGenerationUUID||' +
  'data.conversationActionManager||' +
  'data.status==="aborted"&&data.abortReason==="user")return;' +
  'const completions=this._backgroundWorkService.pull(id);' +
  'const dispatchable=completions,payloads=dispatchable.map(item=>item.payload);' +
  'prepare({composerDataHandle:handle,' +
  'composerDataService:this._composerDataService,completions:payloads});' +
  'try{const state=this._composerDataService.' +
  'getComposerData(handle)?.conversationState,action=state;' +
  'this.events.push("dispatch");' +
  'this._backgroundWorkService.ack(dispatchable)}' +
  'catch(error){this.events.push("recover");' +
  'this._backgroundWorkService.nack(dispatchable)}}';
const SETTLED =
  'options.onFinish?.(),' +
  'this._composerEventService.fireMaybeRunOnComposerSettled(' +
  '{composerId:id,traceParent:span.spanContext()}),';
function workbenchSource() {
  return (
    CHAT_SERVICE_TOKEN +
    'const abortSpan={setAttribute(){},end(){}};' +
    'function prepare(){}' +
    'class ComposerChatService{' +
    'async triggerManualSummarization(composer){' +
    'this.events.push("summarize");' +
    'composer.data.conversationState=composer.data.afterSummaryState??' +
    'composer.data.conversationState;' +
    'composer.data.contextUsagePercent=0;' +
    'composer.data.status="completed"}' +
    `${SUBMISSION}` +
    `${CHECKPOINT}` +
    `async finish(options,id,span){${SETTLED}this.done=true}` +
    '}' +
    'class ComposerAgentService{' +
    `${BACKGROUND_COMPLETION}` +
    '}' +
    `class ModelConfig{${MODEL_RESOLUTION}}` +
    `class Catalog{normalize(){${MODEL_CATALOG}(){}}`
  );
}

function modelConfig(modelId = 'gpt-5.6-sol', context = '272k') {
  return {
    selectedModels: [
      { modelId, parameters: [{ id: 'context', value: context }] },
    ],
  };
}

function conversationState(maxTokens = 1_000_000) {
  return {
    tokenDetails: {
      usedTokens: 371_126,
      maxTokens,
      breakdown: { totalUsedTokens: 340_000, maxTokens },
    },
  };
}

function tokenUsage(usedTokens, totalUsedTokens) {
  return {
    conversationState: {
      tokenDetails: {
        usedTokens,
        maxTokens: 372_000,
        breakdown: {
          totalUsedTokens,
          maxTokens: 372_000,
        },
      },
    },
  };
}

function preservesEveryByte(original, patched) {
  let offset = 0;
  for (const character of patched) {
    if (character === original[offset]) offset += 1;
  }
  return offset === original.length;
}

test('aligns only matching GPT-5.6 Sol conversation limits', () => {
  const config = modelConfig();
  const state = conversationState();
  const composer = { data: { modelConfig: config } };

  assert.equal(alignContextLimit(state, composer), state);
  assert.equal(state.tokenDetails.maxTokens, 372_000);
  assert.equal(state.tokenDetails.breakdown.maxTokens, 372_000);
  assert.equal(state.tokenDetails.usedTokens, 371_126);
  assert.equal(state.tokenDetails.breakdown.totalUsedTokens, 340_000);

  for (const other of [
    modelConfig('another-model'),
    modelConfig('gpt-5.6-sol', '1m'),
  ]) {
    const untouched = conversationState();
    assert.equal(
      alignContextLimit(untouched, { data: { modelConfig: other } }),
      untouched,
    );
    assert.equal(untouched.tokenDetails.maxTokens, 1_000_000);
    assert.equal(untouched.tokenDetails.breakdown.maxTokens, 1_000_000);
  }
});

test('injects each narrow change exactly once', () => {
  const native = workbenchSource();
  const first = patchWorkbenchSource(native);
  const second = patchWorkbenchSource(first.source);

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(preservesEveryByte(native, first.source), true);
  for (const marker of [
    MODEL_MARKER,
    CHECKPOINT_MARKER,
    SUMMARY_MARKER,
    BACKGROUND_SUMMARY_MARKER,
    UI_MARKER,
  ]) {
    assert.equal(first.source.split(marker).length - 1, 1);
  }
  assert.match(first.source, /selected\?\.modelId !== 'gpt-5\.6-sol'/);
  assert.match(first.source, /value: '1m'/);
  assert.equal(second.source, first.source);
});

test('aligns checkpoints in the native handler', () => {
  const patched = patchWorkbenchSource(workbenchSource()).source;
  const sandbox = vm.createContext({
    composer: {
      data: {
        modelConfig: modelConfig(),
      },
    },
    checkpoint: conversationState(),
  });

  vm.runInContext(patched, sandbox);
  vm.runInContext('instance=new ComposerChatService()', sandbox);
  vm.runInContext(
    'instance.handleConversationCheckpoint(checkpoint,composer,undefined,undefined)',
    sandbox,
  );
  assert.equal(sandbox.checkpoint.tokenDetails.maxTokens, 372_000);
  assert.equal(sandbox.checkpoint.tokenDetails.breakdown.maxTokens, 372_000);
});

test('selects only matching 372K context for summarization', () => {
  for (const data of [
    {
      modelConfig: modelConfig(),
      contextUsagePercent: 90,
    },
    {
      modelConfig: modelConfig(),
      ...tokenUsage(0, 366_328),
    },
    {
      modelConfig: modelConfig(),
      ...tokenUsage(340_000, 0),
    },
  ]) {
    assert.equal(needsSummarization(data), true);
  }
  for (const data of [
    {
      modelConfig: modelConfig(),
      contextUsagePercent: 89.99,
    },
    {
      modelConfig: modelConfig('another-model'),
      contextUsagePercent: 100,
    },
    {
      modelConfig: modelConfig('gpt-5.6-sol', '1m'),
      contextUsagePercent: 100,
    },
    {
      modelConfig: modelConfig(),
      ...tokenUsage(32_803, 352_998),
    },
    {
      modelConfig: modelConfig(),
      ...tokenUsage(0, 0),
      contextUsagePercent: 100,
    },
  ]) {
    assert.equal(needsSummarization(data), false);
  }
});

test('summarizes each submission at its native state boundary', async () => {
  const source = patchWorkbenchSource(workbenchSource()).source;
  const sandbox = vm.createContext({ events: [] });
  vm.runInContext(source, sandbox);
  vm.runInContext(
    'instance=new ComposerChatService();instance.events=events',
    sandbox,
  );
  const composer = {
    data: {
      modelConfig: modelConfig(),
    },
  };
  sandbox.instance._composerDataService = {
    getComposerHandleById: async () => composer,
    getComposerData: ({ data }) => data,
    getComposerBubbleUntracked: ({ data }, bubbleId) => data.bubbles[bubbleId],
    updateComposerBubbleSetStore: (handle, bubbleId, callback) =>
      callback((key, value) => {
        handle.data.bubbles ??= {};
        handle.data.bubbles[bubbleId] ??= { bubbleId };
        handle.data.bubbles[bubbleId][key] = value;
      }),
    updateComposerDataSetStore: (handle, callback) =>
      callback((key, value) => {
        handle.data[key] = value;
      }),
  };
  sandbox.instance._structuredLogService = { info() {} };
  async function submit(data, options = {}) {
    sandbox.events.length = 0;
    composer.data = {
      modelConfig: modelConfig(),
      ...data,
    };
    await sandbox.instance.submitChatMaybeAbortCurrent('composer', '', options);
    return [...sandbox.events];
  }

  const measured = { contextUsagePercent: 90 };
  const persisted = tokenUsage(0, 366_328);
  for (const data of [
    { status: 'completed', ...measured },
    { status: 'aborted', ...persisted },
    { status: 'aborted', abortReason: 'user', ...persisted },
  ]) {
    assert.deepEqual(
      await submit(data),
      ['summarize', 'precheck', 'abort', 'submit'],
    );
    assert.equal(sandbox.instance.statusAtStream, 'generating');
  }
  for (const [data, expected, options] of [
    [
      { status: 'generating', ...persisted },
      ['precheck', 'abort', 'submit'],
    ],
    [
      { status: 'completed', contextUsagePercent: 89.99 },
      ['precheck', 'abort', 'submit'],
    ],
    [
      { status: 'completed', ...persisted },
      ['summarize', 'precheck', 'blocked'],
      { blockSubmission: true },
    ],
    [
      { status: 'completed', pendingQuestionnaire: true, ...persisted },
      ['summarize', 'precheck', 'abort', 'submit'],
    ],
  ]) {
    assert.deepEqual(await submit(data, options), expected);
  }

  const beforeSummary = tokenUsage(0, 366_328).conversationState;
  const afterSummary = tokenUsage(32_803, 352_998).conversationState;
  const bubble = { bubbleId: 'failed-turn', conversationState: beforeSummary };
  const bubbleSubmission = {
    status: 'aborted',
    contextUsagePercent: 0,
    conversationState: {},
    afterSummaryState: afterSummary,
    bubbles: { [bubble.bubbleId]: bubble },
  };
  assert.deepEqual(
    await submit(bubbleSubmission, { bubbleId: bubble.bubbleId }),
    ['precheck', 'rollback', 'abort', 'summarize', 'submit'],
  );
  assert.equal(sandbox.instance.requestState, afterSummary);
  assert.equal(bubble.conversationState, afterSummary);
  assert.equal(composer.data.status, 'generating');
  assert.equal(needsSummarization(composer.data), false);

  assert.deepEqual(
    await submit(
      {
        ...bubbleSubmission,
        conversationState: beforeSummary,
        bubbles: { [bubble.bubbleId]: bubble },
      },
      { bubbleId: bubble.bubbleId },
    ),
    ['precheck', 'rollback', 'abort', 'submit'],
  );
  assert.equal(sandbox.instance.requestState, afterSummary);

  assert.equal(source.includes(SETTLED), true);
});

test('uses native chat summarization inside background recovery', async () => {
  const source = patchWorkbenchSource(workbenchSource()).source;
  const sandbox = vm.createContext({ events: [] });
  vm.runInContext(source, sandbox);
  vm.runInContext(
    'chatService=new ComposerChatService();chatService.events=events;' +
      'instance=new ComposerAgentService();instance.events=events',
    sandbox,
  );
  const chatServiceToken = vm.runInContext('chatServiceToken', sandbox);
  sandbox.instance._instantiationService = {
    invokeFunction: (callback) => callback({
      get: (token) => {
        assert.equal(token, chatServiceToken);
        return sandbox.chatService;
      },
    }),
  };
  const composer = {
    data: {
      isNAL: true,
      modelConfig: modelConfig(),
      status: 'aborted',
      abortReason: 'error',
      contextUsagePercent: 90,
      conversationState: {},
    },
  };
  sandbox.instance._composerDataService = {
    getHandleIfLoaded: () => composer,
    getComposerData: ({ data }) => data,
  };
  sandbox.instance._backgroundWorkService = {
    pull: () => {
      sandbox.events.push('pull');
      return [{ payload: { taskId: 'task' } }];
    },
    ack: () => sandbox.events.push('ack'),
    nack: () => sandbox.events.push('nack'),
  };

  await sandbox.instance._maybeDispatchBackgroundCompletions('composer');
  assert.deepEqual(
    [...sandbox.events],
    ['pull', 'summarize', 'dispatch', 'ack'],
  );

  sandbox.events.length = 0;
  composer.data.contextUsagePercent = 90;
  sandbox.chatService.triggerManualSummarization = async () => {
    sandbox.events.push('summarize');
    throw new Error('summary failed');
  };
  await sandbox.instance._maybeDispatchBackgroundCompletions('composer');
  assert.deepEqual([...sandbox.events], ['pull', 'summarize', 'recover', 'nack']);
});

test('overrides only GPT-5.6 Sol submissions selected at 272k', () => {
  const selected = [
    { id: 'context', value: '272k' },
    { id: 'reasoning', value: 'max' },
    { id: 'fast', value: 'false' },
  ];
  const resolved = [
    { id: 'context', value: '272k' },
    { id: 'reasoning', value: 'max' },
    { id: 'fast', value: 'false' },
  ];
  const normalized = normalizeSubmissionParameters(
    'gpt-5.6-sol',
    selected,
    resolved,
  );

  assert.equal(normalized[0].value, '1m');
  assert.equal(resolved[0].value, '272k');
  assert.deepEqual(normalized.slice(1), resolved.slice(1));
  const maxMode = [{ id: 'context', value: '1m' }];
  assert.equal(
    normalizeSubmissionParameters('gpt-5.6-sol', selected, maxMode),
    maxMode,
  );
  assert.equal(
    normalizeSubmissionParameters(
      'gpt-5.6-sol',
      [{ id: 'context', value: '1m' }],
      resolved,
    ),
    resolved,
  );
  assert.equal(
    normalizeSubmissionParameters('another-model', selected, resolved),
    resolved,
  );
});

test('presents only GPT-5.6 Sol native 272k as 372K', () => {
  const model = {
    name: 'gpt-5.6-sol',
    tooltipData: { markdownContent: '272k context window' },
    tooltipDataForMaxMode: { markdownContent: '1M context window' },
    parameterDefinitions: [
      {
        id: 'context',
        parameterType: {
          enumParameter: {
            values: [
              { value: '272k', displayName: '272K' },
              { value: '1m', displayName: '1M' },
            ],
          },
        },
      },
      {
        id: 'unrelated',
        parameterType: {
          enumParameter: {
            values: [{ value: '272k', displayName: '272K' }],
          },
        },
      },
    ],
    variants: [
      {
        parameterValues: [{ id: 'context', value: '272k' }],
        tooltipData: { markdownContent: '272k context window' },
      },
      {
        parameterValues: [{ id: 'context', value: '1m' }],
        tooltipData: { markdownContent: '1m context window' },
      },
    ],
  };
  const mapped = mapContextLabel(model);

  assert.notEqual(mapped, model);
  assert.equal(
    model.parameterDefinitions[0].parameterType.enumParameter.values[0]
      .displayName,
    '272K',
  );
  assert.equal(
    mapped.parameterDefinitions[0].parameterType.enumParameter.values[0].value,
    '272k',
  );
  assert.equal(
    mapped.parameterDefinitions[0].parameterType.enumParameter.values[0]
      .displayName,
    '372K',
  );
  assert.equal(
    mapped.parameterDefinitions[0].parameterType.enumParameter.values[1]
      .displayName,
    '1M',
  );
  assert.equal(
    mapped.parameterDefinitions[1].parameterType.enumParameter.values[0]
      .displayName,
    '272K',
  );
  assert.equal(mapped.parameterDefinitions[1], model.parameterDefinitions[1]);
  assert.equal(mapped.tooltipData.markdownContent, '372k context window');
  assert.equal(mapped.tooltipDataForMaxMode, model.tooltipDataForMaxMode);
  assert.equal(
    mapped.variants[0].tooltipData.markdownContent,
    '372k context window',
  );
  assert.equal(
    mapped.variants[1].tooltipData.markdownContent,
    '1m context window',
  );
  assert.equal(mapped.variants[1], model.variants[1]);
  assert.equal(mapContextLabel(mapped), mapped);
  const otherModel = { ...model, name: 'another-model' };
  assert.equal(mapContextLabel(otherModel), otherModel);
});

test('refuses missing, duplicate, and incomplete injection points', () => {
  assert.throws(
    () => patchWorkbenchSource('no model resolution'),
    /Expected one model submission parameter resolution, found 0/,
  );
  assert.throws(
    () =>
      patchWorkbenchSource(`${MODEL_RESOLUTION}${MODEL_CATALOG}`),
    /Expected one conversation checkpoint handler, found 0/,
  );
  assert.throws(
    () =>
      patchWorkbenchSource(
        `${MODEL_RESOLUTION}${CHECKPOINT}${MODEL_CATALOG}`,
      ),
    /Expected one chat submission entry, found 0/,
  );
  for (const [missing, error] of [
    [
      'abortSpan.setAttribute("pendingQuestionnaire",pendingQuestionnaire),',
      /Expected one pending questionnaire state, found 0/,
    ],
    [
      'if(options.bubbleId===void 0)',
      /Expected one chat submission state after abort, found 0/,
    ],
  ]) {
    assert.throws(
      () => patchWorkbenchSource(workbenchSource().replace(missing, '')),
      error,
    );
  }
  assert.throws(
    () =>
      patchWorkbenchSource(
        `${CHAT_SERVICE_TOKEN}${MODEL_RESOLUTION}${CHECKPOINT}${SUBMISSION}` +
          `${MODEL_CATALOG}${MODEL_CATALOG}`,
      ),
    /Expected one background completion dispatch, found 0/,
  );
  assert.throws(
    () =>
      patchWorkbenchSource(
        `${CHAT_SERVICE_TOKEN}${MODEL_RESOLUTION}${CHECKPOINT}${SUBMISSION}` +
          `${BACKGROUND_COMPLETION}${MODEL_CATALOG}${MODEL_CATALOG}`,
      ),
    /Expected one model catalog normalization, found 2/,
  );
  assert.throws(
    () => patchWorkbenchSource(`${MODEL_MARKER} partial`),
    /incomplete or duplicate context override marker/,
  );
  const patched = patchWorkbenchSource(workbenchSource()).source;
  assert.throws(
    () => patchWorkbenchSource(`${patched}${UI_MARKER}`),
    /incomplete or duplicate context override marker/,
  );
});

test('computes Cursor checksum format without base64 padding', () => {
  assert.equal(
    productChecksum(Buffer.from('cursor')),
    'RqTuvSDYgez8DstU9tg0ZST62xQ3JtJWsaBFMD/Gdxc',
  );
});

test('adds the narrow library-validation entitlement once', () => {
  const original =
    '<plist><dict><key>nested</key><dict></dict>' +
    '<key>allow-jit</key><true/></dict></plist>';
  const patched = disableLibraryValidation(original);

  assert.match(
    patched,
    /<key>com\.apple\.security\.cs\.disable-library-validation<\/key><true\/>/,
  );
  assert.equal(disableLibraryValidation(patched), patched);
  assert.match(
    patched,
    /<dict><\/dict><key>allow-jit<\/key><true\/><key>com\.apple\.security/,
  );
  assert.throws(
    () => disableLibraryValidation('<plist/>'),
    /Malformed application entitlements/,
  );
});

test('matches the native workbench shapes', () => {
  assert.match(MODEL_RESOLUTION, MODEL_PARAMETER_RESOLUTION);
  assert.match(CHECKPOINT, CONVERSATION_CHECKPOINT);
  assert.match(SUBMISSION, SUBMISSION_ENTRY);
  assert.match(SUBMISSION, SUBMISSION_PENDING_QUESTIONNAIRE);
  assert.match(SUBMISSION, SUBMISSION_ABORT_STATE);
  assert.match(BACKGROUND_COMPLETION, BACKGROUND_COMPLETION_DISPATCH);
  assert.match(workbenchSource(), COMPOSER_CHAT_SERVICE_TOKEN);
  assert.match(MODEL_CATALOG, MODEL_CATALOG_NORMALIZATION);
});

test('uses a process pattern scoped to the copied application', () => {
  const pattern = executablePattern('/Applications/Cursor 372K.app');
  const matcher = new RegExp(pattern);

  assert.match('/Applications/Cursor 372K.app/Contents/MacOS/Cursor', matcher);
  assert.match(
    '/Applications/Cursor 372K.app/Contents/MacOS/Cursor --flag',
    matcher,
  );
  assert.doesNotMatch('/Applications/Cursor.app/Contents/MacOS/Cursor', matcher);
  assert.doesNotMatch(
    '/Applications/Cursor 372K.app/Contents/MacOS/CursorHelper',
    matcher,
  );
});

test('classifies native, patched, and partial application states', (t) => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-372k-test-'));
  const appRoot = path.join(appPath, 'Contents', 'Resources', 'app');
  const workbenchRoot = path.join(appRoot, 'out', 'vs', 'workbench');
  const desktopPath = path.join(workbenchRoot, 'workbench.desktop.main.js');
  const glassPath = path.join(workbenchRoot, 'workbench.glass.main.js');
  const productPath = path.join(appRoot, 'product.json');
  const native = workbenchSource();
  const patched = patchWorkbenchSource(native).source;

  t.after(() => fs.rmSync(appPath, { recursive: true, force: true }));
  fs.mkdirSync(workbenchRoot, { recursive: true });

  function writeFixture(desktop, glass) {
    fs.writeFileSync(desktopPath, desktop);
    fs.writeFileSync(glassPath, glass);
    fs.writeFileSync(
      productPath,
      JSON.stringify({
        version: 'test',
        checksums: {
          'vs/workbench/workbench.desktop.main.js': productChecksum(desktop),
        },
      }),
    );
  }

  writeFixture(native, native);
  assert.equal(inspect(appPath).state, 'native');

  writeFixture(patched, patched);
  assert.equal(inspect(appPath).state, 'patched');

  writeFixture(patched, `${patched}${UI_MARKER}`);
  assert.equal(inspect(appPath).state, 'partial');
});
