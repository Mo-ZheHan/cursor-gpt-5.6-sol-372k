'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OFFICIAL_APP = '/Applications/Cursor.app';
const DEFAULT_APP = '/Applications/Cursor 372K.app';
const MODEL_MARKER = '/* cursor-gpt-5.6-sol-372k:model */';
const CHECKPOINT_MARKER = '/* cursor-gpt-5.6-sol-372k:checkpoint */';
const SUMMARY_MARKER = '/* cursor-gpt-5.6-sol-372k:summary */';
const BACKGROUND_SUMMARY_MARKER =
  '/* cursor-gpt-5.6-sol-372k:background-summary */';
const UI_MARKER = '/* cursor-gpt-5.6-sol-372k:ui */';
const PATCH_MARKERS = [
  MODEL_MARKER,
  CHECKPOINT_MARKER,
  SUMMARY_MARKER,
  BACKGROUND_SUMMARY_MARKER,
  UI_MARKER,
];
const MODEL_PARAMETER_RESOLUTION =
  /(resolveModelParametersForSubmission\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{const ([A-Za-z_$][\w$]*)=this\.getAvailableDefaultModels\(\)\.find\(([A-Za-z_$][\w$]*)=>\6\.name===\2\);if\(!\5\|\|!\5\.parameterDefinitions\|\|\5\.parameterDefinitions\.length===0\)return\[\];const ([A-Za-z_$][\w$]*)=\3&&\3\.length>0\?\3:this\.getModelParameterPreferences\(\2\)\?\.parameters\?\?\[\];return )(([A-Za-z_$][\w$]*)\(\5,\7,\4\)\?\.parameterValues\?\?\[\])(?=\})/;
const CONVERSATION_CHECKPOINT =
  /(handleConversationCheckpoint\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(\5!==void 0&&\5!==\(\3\.data\._checkpointEpoch\?\?0\)\)return;)(?=const ([A-Za-z_$][\w$]*)=\2\.tokenDetails,)/;
const SUBMISSION_ENTRY =
  /(async submitChatMaybeAbortCurrent\(([A-Za-z_$][\w$]*),[A-Za-z_$][\w$]*,([A-Za-z_$][\w$]*)\)\{var [A-Za-z_$][\w$]*=\[\];try\{)/;
const BACKGROUND_COMPLETION_DISPATCH =
  /([A-Za-z_$][\w$]*\(\{composerDataHandle:([A-Za-z_$][\w$]*),composerDataService:this\._composerDataService,completions:[A-Za-z_$][\w$]*\}\);try\{)(?=const [A-Za-z_$][\w$]*=this\._composerDataService\.getComposerData\(\2\)\?\.conversationState,)/;
const COMPOSER_CHAT_SERVICE_TOKEN =
  /([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\("composerChatService"\)/;
const MODEL_CATALOG_NORMALIZATION =
  /(return [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\.localMode\))(?=\}getModelPickerDisplayConfiguration)/;
const WORKBENCH_FILES = [
  {
    relativePath: 'out/vs/workbench/workbench.desktop.main.js',
    checksumKey: 'vs/workbench/workbench.desktop.main.js',
  },
  {
    relativePath: 'out/vs/workbench/workbench.glass.main.js',
  },
];
const HELPER_BUNDLES = [
  'Contents/Frameworks/Cursor Helper.app',
  'Contents/Frameworks/Cursor Helper (GPU).app',
  'Contents/Frameworks/Cursor Helper (Plugin).app',
  'Contents/Frameworks/Cursor Helper (Renderer).app',
];

function sha256(bytes, encoding = 'hex') {
  return crypto.createHash('sha256').update(bytes).digest(encoding);
}

function productChecksum(bytes) {
  return sha256(bytes, 'base64').replace(/=+$/, '');
}

function markerCounts(source) {
  return PATCH_MARKERS.map((marker) => source.split(marker).length - 1);
}

function matchUnique(source, pattern, description) {
  const matches = [...source.matchAll(new RegExp(pattern.source, 'g'))];
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${description}, found ${matches.length}. Cursor may be incompatible.`,
    );
  }
  return matches[0];
}

function replaceUnique(source, pattern, description, replacement) {
  matchUnique(source, pattern, description);
  return source.replace(pattern, replacement);
}

function inlineFunction(fn) {
  return `(${fn.toString().replace(/\n\s*/g, '')})`;
}

function mapContextLabel(model) {
  if (model.name !== 'gpt-5.6-sol') return model;

  const definition = model.parameterDefinitions?.find(
    ({ id }) => id === 'context',
  );
  const values = definition?.parameterType?.enumParameter?.values;
  if (
    !values?.some(
      ({ value, displayName }) =>
        value === '272k' && displayName !== '372K',
    )
  ) {
    return model;
  }

  const is372KVariant = (variant) =>
    variant.parameterValues?.some(
      ({ id, value }) => id === 'context' && value === '272k',
    );
  const relabelTooltip = (tooltipData) => {
    const markdown = tooltipData?.markdownContent;
    return typeof markdown !== 'string' || !markdown.includes('272k context window')
      ? tooltipData
      : {
          ...tooltipData,
          markdownContent: markdown.replaceAll(
            '272k context window',
            '372k context window',
          ),
        };
  };

  return {
    ...model,
    tooltipData: relabelTooltip(model.tooltipData),
    parameterDefinitions: model.parameterDefinitions.map((item) =>
      item !== definition
        ? item
        : {
            ...item,
            parameterType: {
              ...item.parameterType,
              enumParameter: {
                ...item.parameterType.enumParameter,
                values: values.map((option) =>
                  option.value === '272k'
                    ? { ...option, displayName: '372K' }
                    : option,
                ),
              },
            },
          },
    ),
    variants: model.variants?.map((variant) =>
      is372KVariant(variant)
        ? { ...variant, tooltipData: relabelTooltip(variant.tooltipData) }
        : variant,
    ),
  };
}

function normalizeSubmissionParameters(modelId, selected, resolved) {
  if (
    modelId !== 'gpt-5.6-sol' ||
    !selected?.some(
      ({ id, value }) => id === 'context' && value === '272k',
    )
  ) {
    return resolved;
  }

  const index = resolved.findIndex(
    ({ id, value }) => id === 'context' && value === '272k',
  );
  return index < 0
    ? resolved
    : resolved.map((parameter, current) =>
        current === index ? { ...parameter, value: '1m' } : parameter,
      );
}

function alignContextLimit(state, composer) {
  const selected = composer.data.modelConfig?.selectedModels?.[0];
  if (
    selected?.modelId !== 'gpt-5.6-sol' ||
    !selected.parameters?.some(
      ({ id, value }) => id === 'context' && value === '272k',
    )
  ) return state;

  if (state?.tokenDetails) state.tokenDetails.maxTokens = 372_000;
  if (state?.tokenDetails?.breakdown) {
    state.tokenDetails.breakdown.maxTokens = 372_000;
  }

  return state;
}

function needsSummarization(data) {
  const selected = data?.modelConfig?.selectedModels?.[0];
  return (
    data?.contextUsagePercent >= 90 &&
    selected?.modelId === 'gpt-5.6-sol' &&
    selected.parameters?.some(
      ({ id, value }) => id === 'context' && value === '272k',
    )
  );
}

function patchWorkbenchSource(source) {
  const state = markerState(markerCounts(source));
  if (state === 'patched') {
    return { source, changed: false };
  }
  if (state !== 'native') {
    throw new Error('Found an incomplete or duplicate context override marker.');
  }
  const needsSummary = inlineFunction(needsSummarization);

  let patched = replaceUnique(
    source,
    MODEL_PARAMETER_RESOLUTION,
    'model submission parameter resolution',
    (
      _resolution,
      prefix,
      modelId,
      _selected,
      _maxMode,
      _model,
      _candidate,
      effective,
      resolved,
      _resolver,
    ) =>
      `${prefix}${MODEL_MARKER}${inlineFunction(normalizeSubmissionParameters)}(` +
      `${modelId},${effective},${resolved})`,
  );

  patched = replaceUnique(
    patched,
    CONVERSATION_CHECKPOINT,
    'conversation checkpoint handler',
    (
      _checkpoint,
      prefix,
      checkpoint,
      composer,
      _model,
      _epoch,
      _details,
    ) =>
      `${prefix}${CHECKPOINT_MARKER}${inlineFunction(alignContextLimit)}(` +
      `${checkpoint},${composer});`,
  );
  patched = replaceUnique(
    patched,
    SUBMISSION_ENTRY,
    'chat submission entry',
    (_submission, entry, composerId, options) =>
      `${entry}if(!${options}?.bubbleId){const composer=` +
      `await this._composerDataService.getComposerHandleById(${composerId});` +
      `if(composer.data.status==="completed"&&${needsSummary}(composer.data))` +
      `await ${SUMMARY_MARKER}this.triggerManualSummarization(composer)}`,
  );
  const [, chatServiceToken] = matchUnique(
    patched,
    COMPOSER_CHAT_SERVICE_TOKEN,
    'composer chat service token',
  );
  patched = replaceUnique(
    patched,
    BACKGROUND_COMPLETION_DISPATCH,
    'background completion dispatch',
    (_background, entry, composer) =>
      `${entry}if(${needsSummary}(${composer}.data))await ` +
      `${BACKGROUND_SUMMARY_MARKER}this._instantiationService.` +
      `invokeFunction(accessor=>accessor.get(${chatServiceToken})).` +
      `triggerManualSummarization(${composer});`,
  );
  patched = replaceUnique(
    patched,
    MODEL_CATALOG_NORMALIZATION,
    'model catalog normalization',
    (_catalog, catalog) =>
      `${catalog}.map(${UI_MARKER}${inlineFunction(mapContextLabel)})`,
  );

  return { source: patched, changed: true };
}

function appPaths(appPath = DEFAULT_APP) {
  const appRoot = path.join(appPath, 'Contents', 'Resources', 'app');
  return {
    appPath,
    appRoot,
    productPath: path.join(appRoot, 'product.json'),
  };
}

function writeAtomic(filePath, contents) {
  const temporaryPath = `${filePath}.372k-patch-${process.pid}`;
  const mode = fs.statSync(filePath).mode;
  fs.writeFileSync(temporaryPath, contents, { mode });
  fs.renameSync(temporaryPath, filePath);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} exited with status ${result.status}.`,
    );
  }
}

function readEntitlements(bundlePath) {
  const result = spawnSync(
    '/usr/bin/codesign',
    ['-d', '--entitlements', '-', '--xml', bundlePath],
    { encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unable to read entitlements from ${bundlePath}.`);
  }

  const output = `${result.stdout}\n${result.stderr}`;
  const start = output.indexOf('<?xml');
  const end = output.lastIndexOf('</plist>');
  if (start === -1 || end === -1) {
    throw new Error(`No XML entitlements found for ${bundlePath}.`);
  }
  return output.slice(start, end + '</plist>'.length);
}

function disableLibraryValidation(entitlements) {
  const key = 'com.apple.security.cs.disable-library-validation';
  if (entitlements.includes(`<key>${key}</key>`)) return entitlements;
  const offset = entitlements.lastIndexOf('</dict>');
  if (offset === -1) {
    throw new Error('Malformed application entitlements.');
  }
  return (
    `${entitlements.slice(0, offset)}<key>${key}</key><true/>` +
    entitlements.slice(offset)
  );
}

function signBundle(bundlePath, entitlementsPath) {
  run('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--preserve-metadata=identifier,flags,runtime',
    '--entitlements',
    entitlementsPath,
    bundlePath,
  ]);
}

function signAndVerify(appPath) {
  const bundles = [
    ...HELPER_BUNDLES.map((relative) => path.join(appPath, relative)),
    appPath,
  ];
  const signingDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cursor-372k-signing-'),
  );
  const entitlementFiles = new Map();

  try {
    for (const bundlePath of bundles) {
      const entitlements = disableLibraryValidation(readEntitlements(bundlePath));
      const entitlementPath = path.join(
        signingDirectory,
        `${sha256(bundlePath).slice(0, 16)}.plist`,
      );
      fs.writeFileSync(entitlementPath, entitlements);
      entitlementFiles.set(bundlePath, entitlementPath);
    }

    run('/usr/bin/codesign', [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--preserve-metadata=identifier,entitlements,flags,runtime',
      appPath,
    ]);
    for (const bundlePath of bundles) {
      signBundle(bundlePath, entitlementFiles.get(bundlePath));
    }
    run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appPath]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  } finally {
    fs.rmSync(signingDirectory, { recursive: true, force: true });
  }
}

function inspect(appPath = DEFAULT_APP) {
  const paths = appPaths(appPath);
  const product = JSON.parse(fs.readFileSync(paths.productPath, 'utf8'));
  const files = [];

  for (const entry of WORKBENCH_FILES) {
    const filePath = path.join(paths.appRoot, entry.relativePath);
    const bytes = fs.readFileSync(filePath);
    const source = bytes.toString('utf8');
    const counts = markerCounts(source);
    const checksum = entry.checksumKey
      ? productChecksum(bytes) === product.checksums?.[entry.checksumKey]
      : true;
    files.push({ filePath, markerCounts: counts, checksum });
  }

  const states = files.map(({ markerCounts }) => markerState(markerCounts));
  return {
    version: product.version,
    state: states.every((state) => state === 'patched')
      ? 'patched'
      : states.every((state) => state === 'native')
        ? 'native'
        : 'partial',
    checksum: files.every((file) => file.checksum),
    files,
  };
}

function markerState(markerCounts) {
  if (markerCounts.every((count) => count === 1)) return 'patched';
  if (markerCounts.every((count) => count === 0)) return 'native';
  return 'partial';
}

function status(appPath = DEFAULT_APP) {
  const result = inspect(appPath);
  for (const file of result.files) {
    console.log(`${markerState(file.markerCounts).padEnd(7)} ${file.filePath}`);
    if (!file.checksum) console.log('  checksum mismatch');
  }
  console.log(
    `Cursor ${result.version}: ${result.state}; checksum ${result.checksum ? 'ok' : 'mismatch'}.`,
  );
  return result;
}

function patchApp(appPath) {
  const paths = appPaths(appPath);
  const product = JSON.parse(fs.readFileSync(paths.productPath, 'utf8'));

  for (const entry of WORKBENCH_FILES) {
    const filePath = path.join(paths.appRoot, entry.relativePath);
    const result = patchWorkbenchSource(fs.readFileSync(filePath, 'utf8'));
    if (!result.changed) {
      throw new Error(`Expected a native workbench file: ${filePath}`);
    }
    writeAtomic(filePath, result.source);

    if (entry.checksumKey) {
      if (!(entry.checksumKey in (product.checksums ?? {}))) {
        throw new Error(`Missing product checksum: ${entry.checksumKey}`);
      }
      product.checksums[entry.checksumKey] = productChecksum(result.source);
    }
  }

  writeAtomic(paths.productPath, `${JSON.stringify(product, null, 2)}\n`);
  signAndVerify(appPath);

  const result = inspect(appPath);
  if (result.state !== 'patched' || !result.checksum) {
    throw new Error('Installed override failed its integrity check.');
  }
  return result;
}

function validateSource(appPath) {
  run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath,
  ]);

  const result = inspect(appPath);
  if (result.state !== 'native' || !result.checksum) {
    throw new Error(`${appPath} must be an intact, native Cursor application.`);
  }

  const paths = appPaths(appPath);
  for (const entry of WORKBENCH_FILES) {
    patchWorkbenchSource(
      fs.readFileSync(path.join(paths.appRoot, entry.relativePath), 'utf8'),
    );
  }
  return result;
}

function executablePattern(appPath) {
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Cursor');
  return `^${executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`;
}

function assertClosed(appPath) {
  if (!fs.existsSync(appPath)) return;
  const result = spawnSync('/bin/ps', ['-axo', 'command='], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unable to determine whether ${appPath} is running.`);
  }
  const pattern = new RegExp(executablePattern(appPath));
  if (result.stdout.split('\n').some((command) => pattern.test(command.trim()))) {
    throw new Error(`Quit ${appPath} before installing.`);
  }
}

function replaceApp(stagingPath, targetPath) {
  const previousPath = `${targetPath}.previous-${process.pid}`;
  fs.rmSync(previousPath, { recursive: true, force: true });
  const hadTarget = fs.existsSync(targetPath);
  if (hadTarget) fs.renameSync(targetPath, previousPath);

  try {
    fs.renameSync(stagingPath, targetPath);
  } catch (error) {
    if (hadTarget) fs.renameSync(previousPath, targetPath);
    throw error;
  }

  if (hadTarget) fs.rmSync(previousPath, { recursive: true, force: true });
}

function install(sourcePath = OFFICIAL_APP, targetPath = DEFAULT_APP) {
  if (process.platform !== 'darwin') {
    throw new Error('The application installer currently supports macOS only.');
  }

  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  if (source === target) {
    throw new Error('Source and target applications must be different.');
  }

  assertClosed(target);
  const sourceStatus = validateSource(source);

  const stagingPath = `${target}.installing-${process.pid}`;
  fs.rmSync(stagingPath, { recursive: true, force: true });
  try {
    run('/usr/bin/ditto', [source, stagingPath]);
    patchApp(stagingPath);
    replaceApp(stagingPath, target);
  } finally {
    fs.rmSync(stagingPath, { recursive: true, force: true });
  }

  const result = status(target);
  console.log(`Installed Cursor ${sourceStatus.version} at ${target}.`);
  return result;
}

function main(argv = process.argv.slice(2)) {
  const [command = 'status', firstPath, secondPath] = argv;
  if (command === 'install' && argv.length <= 3) {
    return install(firstPath ?? OFFICIAL_APP, secondPath ?? DEFAULT_APP);
  }
  if (command === 'status' && argv.length <= 2) {
    const result = status(firstPath ?? DEFAULT_APP);
    if (result.state !== 'patched' || !result.checksum) process.exitCode = 1;
    return result;
  }
  throw new Error(
    'Usage: node patch-cursor.js install [source.app] [target.app]\n' +
      '       node patch-cursor.js status [target.app]',
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  BACKGROUND_COMPLETION_DISPATCH,
  BACKGROUND_SUMMARY_MARKER,
  CHECKPOINT_MARKER,
  COMPOSER_CHAT_SERVICE_TOKEN,
  CONVERSATION_CHECKPOINT,
  DEFAULT_APP,
  MODEL_MARKER,
  MODEL_CATALOG_NORMALIZATION,
  MODEL_PARAMETER_RESOLUTION,
  OFFICIAL_APP,
  SUBMISSION_ENTRY,
  SUMMARY_MARKER,
  UI_MARKER,
  disableLibraryValidation,
  executablePattern,
  alignContextLimit,
  inlineFunction,
  inspect,
  install,
  mapContextLabel,
  normalizeSubmissionParameters,
  patchApp,
  patchWorkbenchSource,
  productChecksum,
  status,
  needsSummarization,
  validateSource,
};
