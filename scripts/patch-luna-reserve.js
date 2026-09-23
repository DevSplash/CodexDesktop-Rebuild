#!/usr/bin/env node
/**
 * Post-build patch: when Reserve is available, keep the compact effort slider
 * and let its effort control open the normal model list. That list keeps every
 * ordinary model and adds a separate gpt-reserve row. Upstream instead
 * replaces the picker with one Reserve row and sends that hidden selector for
 * every selection.
 *
 * Also keeps the gpt-reserve quota row visible under the remaining-usage menu
 * even when the current session model is an ordinary model. Upstream filters
 * additional rate limits to the selected model only.
 *
 * The bundle is minified and variable names change between releases, so this
 * patch intentionally matches the surrounding expression shape instead of
 * relying on a particular generated name.
 *
 * Usage:
 *   node scripts/patch-luna-reserve.js [mac-arm64|mac-x64|win]
 *   node scripts/patch-luna-reserve.js --check
 */
const fs = require("fs");
const path = require("path");
const { relPath, SRC_DIR } = require("./patch-util");

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
const MARKER = "/* Codex Luna Reserve picker patch */";
const CORE_MARKER = "/* Codex Luna Reserve core patch */";
const USAGE_MARKER = "/* Codex Luna Reserve usage patch */";
// Keep these names deliberately descriptive and stable. They are shared by
// the model-settings hook and the request/default-model paths in app-initial.
const CORE_SELECTION = "__codexLunaReserveSelectionByHost";
const CORE_MANUAL_SELECTION = "__codexLunaReserveManualSelectionByHost";
const PLATFORMS = ["mac-arm64", "mac-x64", "win"];
const BACKTICK = String.fromCharCode(96);
const SELECTOR_EXPR =
  `(?:${IDENT}|${BACKTICK}[^${BACKTICK}]*${BACKTICK}|"[^"]*"|'[^']*')`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\[\]\\]/g, "\\$&");
}

function replaceMatch(source, match, replacement) {
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

function execAfter(source, regex, start) {
  const match = regex.exec(source.slice(start));
  if (!match) return null;
  match.index += start;
  return match;
}

function currentGateRegex() {
  return new RegExp(
    `(${IDENT})=(${IDENT})&&\\((${IDENT})\\|\\|(${IDENT})===(${SELECTOR_EXPR})\\)`,
    "g",
  );
}

function hasPickerContext(source) {
  return source.includes("modelsForPicker") || source.includes("additionalAvailableModels");
}

function hasReservePickerCandidate(source) {
  if (source.includes(MARKER) || source.includes("modelsForPicker")) return true;
  if (!source.includes("additionalAvailableModels")) return false;
  if (currentGateRegex().test(source)) return true;
  return new RegExp(
    `(${IDENT})&&\\((${IDENT})=(${IDENT})==null\\?\\[\\]:\\[\\{\\.\\.\\.(${IDENT}),model:(${IDENT})\\}\\]\\)`,
  ).test(source);
}

function findCurrentGate(source) {
  const gateRe = currentGateRegex();
  let gate;
  while ((gate = gateRe.exec(source))) {
    const nearby = source.slice(gate.index, gate.index + 60000);
    if (hasPickerContext(nearby)) return gate;
  }
  return null;
}

function legacyCollapseRegex() {
  return new RegExp(
    `(${IDENT})&&\\((${IDENT})=(${IDENT})==null\\?\\[\\]:\\[\\{\\.\\.\\.(${IDENT}),model:(${IDENT})\\}\\]\\)`,
    "g",
  );
}

function reserveListInsertion(listVar, reserveRowVar, reserveSelector) {
  // Keep the catalog row that supplied the Reserve display metadata. Insert the
  // wire-model copy immediately after that row so the two stay adjacent.
  return `${listVar}=(${listVar}??[]).filter(e=>e.model!==${reserveSelector}),${reserveRowVar}!=null&&${listVar}.splice(${listVar}.includes(${reserveRowVar})?${listVar}.indexOf(${reserveRowVar})+1:${listVar}.length,0,{...${reserveRowVar},model:${reserveSelector}})`;
}

function findLegacyCollapse(source) {
  const collapseRe = legacyCollapseRegex();
  let collapse;
  while ((collapse = collapseRe.exec(source))) {
    if (collapse[3] !== collapse[4]) continue;
    const nearby = source.slice(Math.max(0, collapse.index - 4000), collapse.index + 50000);
    if (hasPickerContext(nearby)) return collapse;
  }
  return null;
}

function patchCurrent(source) {
  const gate = findCurrentGate(source);
  if (!gate) return null;

  const [, forceVar, restrictedVar, reserveActiveVar, selectedVar, reserveSelector] = gate;

  let code = source;
  const changes = [];

  const gateMatch = new RegExp(
    `${escapeRegExp(forceVar)}=${escapeRegExp(restrictedVar)}&&\\(${escapeRegExp(
      reserveActiveVar,
    )}\\|\\|${escapeRegExp(selectedVar)}===${escapeRegExp(reserveSelector)}\\)`,
  ).exec(code);
  if (!gateMatch) return { detected: true, ok: false, reason: "force gate disappeared" };
  code = replaceMatch(
    code,
    gateMatch,
    `${forceVar}=${restrictedVar}&&${selectedVar}===${reserveSelector}`,
  );
  changes.push("stop forcing reserve mode when Reserve is merely available");

  const reserveIdsRe = new RegExp(
    `(${IDENT})=${escapeRegExp(forceVar)}\\?\\[(${IDENT}),(${IDENT})\\]:\\[\\]`,
    "g",
  );
  const reserveIds = reserveIdsRe.exec(code.slice(gate.index));
  if (!reserveIds) {
    return { detected: true, ok: false, reason: "reserve id list not found" };
  }
  const reserveIdsAbsolute = {
    index: gate.index + reserveIds.index,
    0: reserveIds[0],
    1: reserveIds[1],
    2: reserveIds[2],
    3: reserveIds[3],
  };
  code = replaceMatch(
    code,
    reserveIdsAbsolute,
    `${reserveIds[1]}=(${forceVar}||${reserveActiveVar})?[${reserveIds[2]},${reserveIds[3]}]:[]`,
  );
  changes.push("keep reserve entries in the model query while Reserve is active");

  // `forceVar` is the selected-Reserve state after the gate rewrite. The
  // availability flag only controls whether the Reserve row is present; it
  // must not switch the active model's reasoning options by itself.
  const modeExpr = forceVar;

  const collapseRe = new RegExp(
    `(${IDENT})=${escapeRegExp(restrictedVar)}\\?(${IDENT})\\?\\.filter\\((${IDENT})\\):\\2;${escapeRegExp(
      reserveActiveVar,
    )}&&\\(\\1=(${IDENT})==null\\?\\[\\]:\\[\\4\\]\\)`,
    "g",
  );
  const collapse = collapseRe.exec(code.slice(gate.index));
  if (!collapse) {
    return { detected: true, ok: false, reason: "reserve-only model list not found" };
  }
  const collapseAbsolute = {
    index: gate.index + collapse.index,
    0: collapse[0],
    1: collapse[1],
    2: collapse[2],
    3: collapse[3],
    4: collapse[4],
  };
  const listVar = collapse[1];
  const catalogVar = collapse[2];
  const filterVar = collapse[3];
  const reserveRowVar = collapse[4];
  // The upstream assignment below is the actual collapse point: it replaces
  // the normal catalog with `[reserveRow]`. Keep that catalog and append the
  // row instead, so provider-backed entries retain their original metadata.
  code = replaceMatch(
    code,
    collapseAbsolute,
    `${listVar}=${restrictedVar}?${catalogVar}?.filter(${filterVar}):${catalogVar};${reserveActiveVar}&&(${reserveListInsertion(listVar, reserveRowVar, reserveSelector)})`,
  );
  changes.push("preserve normal models and append the reserve row");

  // The upstream `Te` value is the display model used while the hidden
  // Reserve selector is active. Give the synthetic row its own wire model so
  // the ordinary Luna entry remains selectable and keeps its own settings.
  const selectedDisplayRe = new RegExp(
    `(${IDENT})=${escapeRegExp(forceVar)}\\?${escapeRegExp(
      reserveRowVar,
    )}\\?\\.model\\?\\?(${IDENT}):(${IDENT})`,
  );
  const selectedDisplay = selectedDisplayRe.exec(code.slice(gate.index));
  if (!selectedDisplay) {
    return { detected: true, ok: false, reason: "selected display model expression not found" };
  }
  const selectedDisplayAbsolute = {
    index: gate.index + selectedDisplay.index,
    0: selectedDisplay[0],
  };
  code = replaceMatch(
    code,
    selectedDisplayAbsolute,
    `${selectedDisplay[1]}=${forceVar}&&${selectedDisplay[3]}===${reserveSelector}?${reserveSelector}:${forceVar}?${reserveRowVar}?.model??${selectedDisplay[2]}:${selectedDisplay[3]}`,
  );
  changes.push("keep the synthetic Reserve row distinct from normal Luna");

  const reserveOnlyBranchRe = new RegExp(
    `${escapeRegExp(reserveActiveVar)}\\?(${IDENT})=(${IDENT})\\.map\\((${IDENT})\\):`,
    "g",
  );
  const reserveOnlyBranch = reserveOnlyBranchRe.exec(code.slice(gate.index));
  if (!reserveOnlyBranch) {
    return { detected: true, ok: false, reason: "reserve-only option branch not found" };
  }
  const branchAbsolute = {
    index: gate.index + reserveOnlyBranch.index,
    0: reserveOnlyBranch[0],
  };
  // This branch replaces the reasoning slider with one stop per catalog row.
  // Upstream only did that after collapsing the catalog to the Reserve model.
  // The expanded catalog must keep the normal per-model slider instead.
  code = replaceMatch(code, branchAbsolute, "");
  changes.push("keep the normal reasoning slider for Reserve and ordinary models");

  const translateRe = new RegExp(
    `function\\s+(${IDENT})\\(e\\)\\{return\\s*${escapeRegExp(
      reserveActiveVar,
    )}\\s*&&\\s*e===(${IDENT})\\?(${IDENT}):e\\}`,
    "g",
  );
  const translate = execAfter(code, translateRe, gate.index);
  if (!translate) {
    return { detected: true, ok: false, reason: "reserve model translation function not found" };
  }
  const translateReplacement = `function ${translate[1]}(e){return e}`;
  code = replaceMatch(code, translate, translateReplacement);
  changes.push("pass the synthetic Reserve wire model without remapping normal Luna");

  // The same flag also controls labels, service-tier controls, and the
  // experiment path. Those controls must follow the selected model (q), not
  // merely the availability of the reserve fallback (pe).
  const modeReplacements = [
    {
      re: new RegExp(`skipExperimentExposure:${escapeRegExp(reserveActiveVar)}\\|\\|`, "g"),
      replacement: `skipExperimentExposure:(${modeExpr})||`,
      label: "scope reserve-only picker behavior to the selected model",
    },
    {
      re: new RegExp(`!(${IDENT})&&!${escapeRegExp(reserveActiveVar)}&&(${IDENT})!=null&&`, "g"),
      replacement: (_match, left, right) => `!${left}&&!(${modeExpr})&&${right}!=null&&`,
      label: "restore service-tier indication for non-reserve selections",
    },
    {
      re: new RegExp(
        `!${escapeRegExp(reserveActiveVar)}&&!(${IDENT})&&(${IDENT})&&(${IDENT})\\.availableOptions\\.length>1`,
      "g",
      ),
      replacement: (_match, left, middle, right) =>
        `!(${modeExpr})&&!${left}&&${middle}&&${right}.availableOptions.length>1`,
      label: "restore service-tier choices for non-reserve selections",
    },
    {
      re: new RegExp(`openLabel:([^,]+)&&!${escapeRegExp(reserveActiveVar)}\\?`, "g"),
      replacement: (_match, prefix) => `openLabel:${prefix}&&!(${modeExpr})?`,
      label: "restore the normal effort label for non-reserve selections",
    },
    {
      re: new RegExp(`selectedLabel:${escapeRegExp(reserveActiveVar)}\\?`, "g"),
      replacement: `selectedLabel:(${modeExpr})?`,
      label: "show the selected model label instead of always showing Luna",
    },
    {
      re: new RegExp(`!(${IDENT})&&${escapeRegExp(reserveActiveVar)}\\?`, "g"),
      replacement: (_match, left) => `!${left}&&(${modeExpr})?`,
      label: "show the Luna marker only when Luna is selected",
    },
    {
      re: new RegExp(`displayName:${escapeRegExp(reserveActiveVar)}\\?(${IDENT})\\?\\.displayName:`, "g"),
      replacement: (_match, reserveDisplay) =>
        `displayName:(${modeExpr})?${reserveDisplay}?.displayName:`,
      label: "use the selected model name in the compact trigger",
    },
  ];

  for (const { re, replacement, label } of modeReplacements) {
    const match = execAfter(code, re, gate.index);
    if (!match) {
      return { detected: true, ok: false, reason: `mode-specific expression not found: ${label}` };
    }
    code = replaceMatch(
      code,
      match,
      typeof replacement === "function" ? replacement(...match) : replacement,
    );
    changes.push(label);
  }

  // The Reserve upsell is the compact slider's footer. Both views stay mounted,
  // and the model list is an absolutely positioned track, so a visible footer
  // paints over that list. Hide it only while the list is open. The React
  // compiler caches this element by footer identity; the view has to be part
  // of that cache key or switching views reuses the previous element.
  const menuFooterRe = new RegExp(
    `let (${IDENT});t\\[(\\d+)\\]===(${IDENT})\\?\\1=t\\[(\\d+)\\]:\\(\\1=\\3==null\\?null:\\(0,(${IDENT})\\.jsx\\)\\(${escapeRegExp(
      BACKTICK,
    )}div${escapeRegExp(BACKTICK)},\\{className:(${IDENT})\\.MenuFooter,children:\\3\\}\\),t\\[\\2\\]=\\3,t\\[\\4\\]=\\1\\)`,
  );
  const menuFooter = menuFooterRe.exec(code);
  if (!menuFooter) {
    return { detected: true, ok: false, reason: "model picker footer layout hook not found" };
  }
  const footerFunctionStart = code.lastIndexOf("function ", menuFooter.index);
  const footerFunctionPrefix = code.slice(footerFunctionStart, menuFooter.index);
  const advancedView = new RegExp(`[;,](${IDENT})=a===${escapeRegExp(BACKTICK)}advanced${escapeRegExp(BACKTICK)}`).exec(
    footerFunctionPrefix,
  );
  if (!advancedView) {
    return { detected: true, ok: false, reason: "model picker advanced-view state not found" };
  }
  const [, footerResult, footerSlot, footerValue, footerCacheSlot, footerRuntime, footerStyle] = menuFooter;
  const advancedVar = advancedView[1];
  code = replaceMatch(
    code,
    menuFooter,
    `let ${footerResult};t[${footerSlot}]?.[0]===${footerValue}&&t[${footerSlot}]?.[1]===${advancedVar}?${footerResult}=t[${footerCacheSlot}]:(${footerResult}=${footerValue}==null||${advancedVar}?null:(0,${footerRuntime}.jsx)(${BACKTICK}div${BACKTICK},{className:${footerStyle}.MenuFooter,children:${footerValue}}),t[${footerSlot}]=[${footerValue},${advancedVar}],t[${footerCacheSlot}]=${footerResult})`,
  );
  changes.push("hide the Reserve upsell footer while the normal model list is open");

  // Opening the menu stays on the compact slider. The effort control is what
  // enters the model list. Upstream disables that control whenever the upsell
  // footer exists, which is exactly the Reserve-available state.
  const effortToggleRe = new RegExp(
    `let (${IDENT})=(${IDENT})\\|\\|(${IDENT})!=null,(${IDENT})=`,
    "g",
  );
  const effortToggles = [];
  let effortToggle;
  while ((effortToggle = effortToggleRe.exec(code))) {
    const nearby = code.slice(effortToggle.index, effortToggle.index + 2500);
    if (!nearby.includes(`modelSelectionDisabled:${effortToggle[1]}`) || !nearby.includes("menuFooter:")) {
      continue;
    }
    effortToggles.push(effortToggle);
  }
  if (effortToggles.length !== 1) {
    return {
      detected: true,
      ok: false,
      reason: "model picker effort-toggle disable hook not found",
    };
  }
  code = replaceMatch(
    code,
    effortToggles[0],
    `let ${effortToggles[0][1]}=${effortToggles[0][2]},${effortToggles[0][4]}=`,
  );
  changes.push("keep the effort control able to open the model list while Reserve is available");

  // Older menu builds disable the same control inline when the footer is present.
  const legacyToggleRe = new RegExp(
    `modelSelectionDisabled:(${IDENT})\\|\\|(${IDENT})!=null`,
    "g",
  );
  const legacyToggles = [];
  let legacyToggle;
  while ((legacyToggle = legacyToggleRe.exec(code))) {
    const nearby = code.slice(Math.max(0, legacyToggle.index - 700), legacyToggle.index + 200);
    if (!nearby.includes(`menuFooter:${legacyToggle[2]}`)) continue;
    legacyToggles.push(legacyToggle);
  }
  if (legacyToggles.length !== 1) {
    return { detected: true, ok: false, reason: "legacy model-list toggle hook not found" };
  }
  code = replaceMatch(
    code,
    legacyToggles[0],
    `modelSelectionDisabled:${legacyToggles[0][1]}`,
  );
  changes.push("keep the legacy model-list toggle enabled while the Reserve footer is visible");

  const moonRe = new RegExp(
    `\\(0,${IDENT}\\.jsx\\)\\(${escapeRegExp(BACKTICK)}span${escapeRegExp(
      BACKTICK,
    )},\\{\"aria-hidden\":${escapeRegExp(BACKTICK)}true${escapeRegExp(BACKTICK)},children:(${IDENT})\\}\\)`,
  );
  const moon = execAfter(code, moonRe, gate.index);
  const optionLabelRe = new RegExp(
    `label:\\(0,(${IDENT})\\.jsx\\)\\((${IDENT}),\\{model:(${IDENT})\\.model,displayName:\\3\\.displayName,stripGptPrefix:!0\\}\\)`,
    "g",
  );
  const optionLabels = [];
  let optionLabelMatch;
  while ((optionLabelMatch = optionLabelRe.exec(code))) optionLabels.push(optionLabelMatch);
  if (!moon || optionLabels.length !== 1) {
    return { detected: true, ok: false, reason: "reserve model option label hook not found" };
  }
  const optionLabel = optionLabels[0];
  const [, labelRuntime, labelComponent, labelModel] = optionLabel;
  const reserveLabel = `label:${labelModel}.model===${reserveSelector}?(0,${labelRuntime}.jsx)(${BACKTICK}span${BACKTICK},{className:${BACKTICK}flex min-w-0 items-center gap-1${BACKTICK},children:[(0,${labelRuntime}.jsx)(${BACKTICK}span${BACKTICK},{\"aria-hidden\":${BACKTICK}true${BACKTICK},children:${moon[1]}}),(0,${labelRuntime}.jsx)(${labelComponent},{model:${labelModel}.model,displayName:${labelModel}.displayName,stripGptPrefix:!0})]}):(0,${labelRuntime}.jsx)(${labelComponent},{model:${labelModel}.model,displayName:${labelModel}.displayName,stripGptPrefix:!0})`;
  code = replaceMatch(code, optionLabel, reserveLabel);
  changes.push("mark the Reserve list row with the Reserve icon");

  // Refresh the memoized trigger objects when the selected model changes the
  // reserve-mode flag. Te usually changes at the same time, but tracking q is
  // required when a catalog row maps to the same display model.
  for (const needle of [`selectedLabel:(${modeExpr})?`, `displayName:(${modeExpr})?`]) {
    const needleIndex = code.indexOf(needle);
    if (needleIndex < 0) continue;
    const start = Math.max(gate.index, needleIndex - 1200);
    const segment = code.slice(start, needleIndex);
    const dependencyRe = new RegExp(`t\\[\\d+\\]!==${escapeRegExp(reserveActiveVar)}`, "g");
    let dependency;
    let candidate;
    while ((candidate = dependencyRe.exec(segment))) dependency = candidate;
    if (!dependency) continue;
    const absolute = { index: start + dependency.index, 0: dependency[0] };
    code = replaceMatch(code, absolute, dependency[0].replace(reserveActiveVar, forceVar));

    const dependencyIndex = dependency[0].match(/\[(\d+)\]/)?.[1];
    if (dependencyIndex == null) continue;
    const assignmentRe = new RegExp(
      `t\\[${dependencyIndex}\\]=${escapeRegExp(reserveActiveVar)}`,
    );
    const assignment = execAfter(code, assignmentRe, absolute.index);
    if (assignment) {
      code = replaceMatch(code, assignment, `t[${dependencyIndex}]=${forceVar}`);
    }
  }

  // The picker callback receives the display model, while Nt translates the
  // reserve row to the hidden wire model. Keep that translation for explicit
  // model changes as well as the state update path.
  const mapperName = translate[1];
  const mapperStart = code.indexOf(`function ${mapperName}(`, gate.index);
  const callbackWindowStart = Math.max(0, gate.index - 400);
  const callbackWindowEnd = mapperStart > callbackWindowStart ? mapperStart : gate.index + 3000;
  const callbackWindow = code.slice(callbackWindowStart, callbackWindowEnd);
  const callbackCallOffset = callbackWindow.indexOf("selectModelAndReasoningEffort");
  const callbackArgs = new RegExp(`(?:${IDENT}=)?function\\((${IDENT}),${IDENT}\\)\\{return`).exec(
    callbackWindow,
  );
  const callbackArg = callbackArgs?.[1];
  const modelObjectRe = callbackArg
    ? new RegExp(`\\{model:${escapeRegExp(callbackArg)}\\}`)
    : null;
  const modelObject = modelObjectRe
    ? modelObjectRe.exec(callbackWindow.slice(callbackCallOffset))
    : null;
  if (callbackCallOffset < 0 || !callbackArg || !modelObject) {
    return { detected: true, ok: false, reason: "reserve model callback mapping not found" };
  }
  const modelObjectStart = callbackWindowStart + callbackCallOffset + modelObject.index;
  const modelObjectAbsolute = { index: modelObjectStart, 0: modelObject[0] };
  code = replaceMatch(code, modelObjectAbsolute, `{model:${mapperName}(${callbackArg})}`);
  changes.push("map an explicitly selected reserve row to the hidden selector");

  return { detected: true, ok: true, code, changes, kind: "current" };
}

function patchLegacy(source) {
  const collapse = findLegacyCollapse(source);
  if (!collapse) return null;

  const reserveActiveVar = collapse[1];
  const listVar = collapse[2];
  const reserveRowVar = collapse[3];
  const internalReserveVar = collapse[5];
  const prefix = source.slice(Math.max(0, collapse.index - 4000), collapse.index);
  const assignmentRe = new RegExp(
    `${escapeRegExp(listVar)}=(${IDENT});${escapeRegExp(reserveActiveVar)}&&\\(`,
    "g",
  );
  let assignment;
  let candidate;
  while ((candidate = assignmentRe.exec(prefix))) assignment = candidate;
  const catalogVar = assignment ? assignment[1] : listVar;

  let code = source;
  const changes = [];
  const replacement =
    `${reserveActiveVar}&&(${listVar}=[...(${catalogVar}??[]).filter(e=>e!==${reserveRowVar}&&e.model!==${internalReserveVar}),...(${reserveRowVar}==null?[]:[{...${reserveRowVar},model:${internalReserveVar}}])])`;
  code = replaceMatch(code, collapse, replacement);
  changes.push("preserve normal models and append the legacy reserve row");

  const selectedModelRe = /e===([A-Za-z_$][A-Za-z0-9_$]*)\?t!=null/;
  const selectedModel = selectedModelRe.exec(source.slice(collapse.index, collapse.index + 50000));
  const selectedVar = selectedModel?.[1];
  if (!selectedVar) {
    return { detected: true, ok: false, reason: "legacy selected model variable not found" };
  }
  const modeExpr = `${reserveActiveVar}&&${selectedVar}===${internalReserveVar}`;

  const optionBranchRe = new RegExp(
    `if\\(${escapeRegExp(reserveActiveVar)}\\)(${IDENT})=(${IDENT})\\.map\\((${IDENT})\\);`,
    "g",
  );
  const optionBranch = execAfter(code, optionBranchRe, collapse.index);
  if (!optionBranch) {
    return { detected: true, ok: false, reason: "legacy reserve-only option branch not found" };
  }
  code = replaceMatch(
    code,
    optionBranch,
    `if(${modeExpr})${optionBranch[1]}=${optionBranch[2]}.map(${optionBranch[3]});`,
  );
  changes.push("scope the legacy reserve option renderer to the selected Reserve row");
  const modeReplacements = [
    {
      re: new RegExp(`skipExperimentExposure:${escapeRegExp(reserveActiveVar)}\\|\\|`, "g"),
      replacement: `skipExperimentExposure:(${modeExpr})||`,
      label: "scope legacy reserve-only behavior to the selected model",
    },
    {
      re: new RegExp(`!(${IDENT})&&!${escapeRegExp(reserveActiveVar)}&&`, "g"),
      replacement: (_match, left) => `!${left}&&!(${modeExpr})&&`,
      label: "restore legacy service-tier indication for non-reserve selections",
    },
    {
      re: new RegExp(`!${escapeRegExp(reserveActiveVar)}&&!(${IDENT})&&`, "g"),
      replacement: (_match, left) => `!(${modeExpr})&&!${left}&&`,
      label: "restore legacy service-tier choices for non-reserve selections",
    },
    {
      re: new RegExp(`openLabel:([^,]+)&&!${escapeRegExp(reserveActiveVar)}\\?`, "g"),
      replacement: (_match, prefix) => `openLabel:${prefix}&&!(${modeExpr})?`,
      label: "restore the legacy effort label for non-reserve selections",
    },
    {
      re: new RegExp(`selectedLabel:${escapeRegExp(reserveActiveVar)}\\?`, "g"),
      replacement: `selectedLabel:(${modeExpr})?`,
      label: "show the legacy selected model label",
    },
    {
      re: new RegExp(`!(${IDENT})&&${escapeRegExp(reserveActiveVar)}\\?`, "g"),
      replacement: (_match, left) => `!${left}&&(${modeExpr})?`,
      label: "show the legacy Luna marker only when selected",
    },
    {
      re: new RegExp(`displayName:${escapeRegExp(reserveActiveVar)}\\?(${IDENT})\\?\\.displayName:`, "g"),
      replacement: (_match, reserveDisplay) =>
        `displayName:(${modeExpr})?${reserveDisplay}?.displayName:`,
      label: "use the legacy selected model name in the trigger",
    },
  ];
  for (const { re, replacement, label } of modeReplacements) {
    const match = execAfter(code, re, collapse.index);
    if (!match) {
      return { detected: true, ok: false, reason: `legacy mode expression not found: ${label}` };
    }
    code = replaceMatch(
      code,
      match,
      typeof replacement === "function" ? replacement(...match) : replacement,
    );
    changes.push(label);
  }

  return { detected: true, ok: true, code, changes, kind: "legacy" };
}

function findCoreAtom(source) {
  const atomRe = new RegExp(
    `(${IDENT})=(${IDENT})\\((${IDENT}),e=>\\[\\]\\),(${IDENT})=(${IDENT})\\(\\3,`,
    "g",
  );
  let match;
  while ((match = atomRe.exec(source))) {
    const nearby = source.slice(match.index, match.index + 2200);
    if (nearby.includes("isLunaReserveActive")) {
      // Keep the minified atom APIs and their root symbol alongside the
      // match. They changed names in 26.917, while their expression shape
      // stayed stable.
      match.atomFactory = match[2];
      match.atomRoot = match[3];
      match.lifecycleVar = match[4];
      match.familyFactory = match[5];
      return match;
    }
  }
  return null;
}

function hasCoreCandidate(source) {
  return (
    source.includes(CORE_MARKER) ||
    (source.includes("waitForModelFallback") &&
      source.includes("isLunaReserveActive") &&
      source.includes("originalAdvancedModelSettings") &&
      source.includes("setModelAndReasoningEffortForNextTurn") &&
      source.includes("gpt-reserve"))
  );
}

function patchCore(source) {
  if (source.includes(CORE_MARKER)) {
    return { status: "already", code: source, changes: [], kind: "core" };
  }
  if (!hasCoreCandidate(source)) return null;

  let code = source;
  const changes = [];
  const reserveConstMatch = new RegExp(
    `(${IDENT})=${escapeRegExp(BACKTICK)}gpt-reserve${escapeRegExp(BACKTICK)}`,
  ).exec(code);
  if (!reserveConstMatch) {
    return { status: "error", code: source, reason: "Reserve model constant not found" };
  }
  const reserveConst = reserveConstMatch[1];

  // The original-model atom already exists for lifecycle restoration. Keep
  // separate per-host atoms so an explicit Reserve choice can be told apart
  // from availability. Availability itself must not replace the saved model.
  if (!new RegExp(`\\bvar\\s+${CORE_SELECTION}\\b`).test(code)) {
    code = `var ${CORE_SELECTION},${CORE_MANUAL_SELECTION};\n${code}`;
  } else if (!new RegExp(`\\bvar\\s+${CORE_MANUAL_SELECTION}\\b`).test(code)) {
    code = `var ${CORE_MANUAL_SELECTION};\n${code}`;
  }
  const atom = findCoreAtom(code);
  if (!atom) {
    return { status: "error", code: source, reason: "Reserve lifecycle atom family not found" };
  }
  code = replaceMatch(
    code,
    atom,
    `${atom[1]}=${atom.atomFactory}(${atom.atomRoot},e=>[]),${CORE_SELECTION}=${atom.atomFactory}(${atom.atomRoot},e=>new Set),${CORE_MANUAL_SELECTION}=${atom.atomFactory}(${atom.atomRoot},e=>new Set),${atom.lifecycleVar}=${atom.familyFactory}(${atom.atomRoot},`,
  );
  changes.push("track Reserve and manual model selection separately from availability");

  const forceRe = new RegExp(
    `if\\((${IDENT})\\)\\{let (${IDENT});n\\[\\d+\\]===_\\?\\2=n\\[\\d+\\]:\\(\\2=\\{\\.\\.\\._,model:${escapeRegExp(
      reserveConst,
    )}\\},n\\[\\d+\\]=_,n\\[\\d+\\]=\\2\\),_=\\2\\}`,
    "g",
  );
  let force;
  while ((force = forceRe.exec(code))) {
    const nearby = code.slice(Math.max(0, force.index - 2600), force.index);
    if (nearby.includes("waitForModelFallback") && nearby.includes("originalAdvancedModelSettings")) {
      break;
    }
  }
  if (!force) {
    return { status: "error", code: source, reason: "Reserve model state override not found" };
  }

  const functionStart = code.lastIndexOf("function ", force.index);
  const functionPrefix = code.slice(functionStart, force.index);
  const activeDecl = new RegExp(`\\{isLunaReserveActive:(${IDENT})\\}=(${IDENT})`).exec(
    functionPrefix,
  );
  const hookDecl = activeDecl
    ? new RegExp(`\\}=(${IDENT})\\(${escapeRegExp(atom.lifecycleVar)},`).exec(code)
    : null;
  const conversationDecl = new RegExp(`(${IDENT})=e===void 0\\?null:e`).exec(functionPrefix);
  const storeDecl = new RegExp(
    `,(${IDENT})=(${IDENT})\\(${escapeRegExp(atom.atomRoot)}\\),`,
  ).exec(functionPrefix);
  const reserveAtomDecl = /isLunaReserveActive:[A-Za-z_$][A-Za-z0-9_$]*\(([A-Za-z_$][A-Za-z0-9_$]*),[^)]*\),originalAdvancedModelSettings/.exec(
    code,
  );
  const fallbackDecl = new RegExp(
    `let (${IDENT})=${activeDecl?.[2] ?? ""}\\.originalAdvancedModelSettings\\?\\.model\\?\\?\\(${activeDecl?.[2] ?? ""}\\.modelSettings\\.model===${escapeRegExp(
      BACKTICK,
    )}gpt-reserve${escapeRegExp(BACKTICK)}\\?${activeDecl?.[2] ?? ""}\\.defaultAdvancedModel:${activeDecl?.[2] ?? ""}\\.modelSettings\\.model\\)`,
  ).exec(code.slice(force.index));
  if (!activeDecl || !hookDecl || !conversationDecl || !storeDecl || !reserveAtomDecl || !fallbackDecl) {
    return { status: "error", code: source, reason: "Reserve model hook variables not found" };
  }
  const activeVar = activeDecl[1];
  const dataVar = activeDecl[2];
  const conversationVar = conversationDecl[1];
  const storeVar = storeDecl[1];
  const fallbackVar = fallbackDecl[1];
  const reserveAtom = reserveAtomDecl[1];
  // Conversation key used by the selection atoms below. Declare it here because
  // the availability-driven model override is removed: restored/new sessions must
  // keep the saved or default model. In-memory manual flags do not survive a
  // restart, so any conditional override keyed only on isLunaReserveActive would
  // select Reserve again on every launch.
  const selectionKey = `${CORE_SELECTION}Key`;
  code = replaceMatch(
    code,
    force,
    `let ${selectionKey}=${conversationVar}??${BACKTICK}__default__${BACKTICK};`,
  );
  changes.push("keep the saved model for restored and new sessions while Reserve is available");

  // Selecting either the synthetic Reserve row or a normal model updates the
  // atom immediately; the underlying lifecycle code can still restore the
  // original model when the fallback window ends.
  const selectionUpdate =
    `(${storeVar}.set(${CORE_SELECTION},${dataVar}.hostId,t=>{let n=new Set(t??[]);return e===${reserveConst}?n.add(${selectionKey}):(n.delete(${selectionKey}),n)}),${storeVar}.set(${CORE_MANUAL_SELECTION},${dataVar}.hostId,t=>{let n=new Set(t??[]);return ${activeVar}?n.add(${selectionKey}):(n.delete(${selectionKey}),n)}))`;
  const callbackRe = new RegExp(
    `(${IDENT})=async\\(e,t,n\\)=>\\{(${IDENT})\\(${storeVar},${conversationVar},e\\);let i=${activeVar}&&e===${escapeRegExp(
      BACKTICK,
    )}gpt-reserve${escapeRegExp(BACKTICK)}\\?${fallbackVar}:e`,
  );
  const callback = callbackRe.exec(code.slice(functionStart));
  if (!callback) {
    return { status: "error", code: source, reason: "Reserve model selection callback not found" };
  }
  const callbackAbsolute = { index: functionStart + callback.index, 0: callback[0] };
  code = replaceMatch(
    code,
    callbackAbsolute,
    `${callback[0].replace(
      `${callback[2]}(${storeVar},${conversationVar},e);`,
      `${callback[2]}(${storeVar},${conversationVar},e);${selectionUpdate};`,
    ).replace(`let i=${activeVar}&&e===${escapeRegExp(BACKTICK)}gpt-reserve${escapeRegExp(BACKTICK)}?${fallbackVar}:e`, `let i=e`)}`,
  );
  changes.push("record explicit normal and Reserve model selections");

  const nextTurnRe = new RegExp(
    `(${IDENT})=\\(e,t,n\\)=>${dataVar}\\.setModelAndReasoningEffortForNextTurn\\(${activeVar}&&e===${escapeRegExp(
      BACKTICK,
    )}gpt-reserve${escapeRegExp(BACKTICK)}\\?${fallbackVar}:e,t,n\\)`,
  );
  const nextTurn = nextTurnRe.exec(code.slice(functionStart));
  if (!nextTurn) {
    return { status: "error", code: source, reason: "Reserve next-turn callback not found" };
  }
  const nextTurnAbsolute = { index: functionStart + nextTurn.index, 0: nextTurn[0] };
  code = replaceMatch(
    code,
    nextTurnAbsolute,
    `${nextTurn[1]}=(e,t,n)=>(${selectionUpdate},${dataVar}.setModelAndReasoningEffortForNextTurn(e,t,n))`,
  );
  changes.push("keep explicit Reserve selections on the gpt-reserve wire model");

  const restoreRe = new RegExp(`let (${IDENT})=a\\(${escapeRegExp(reserveAtom)},t\\);if\\(i&&!\\1\\)\\{`);
  const restore = restoreRe.exec(code);
  if (!restore) {
    return { status: "error", code: source, reason: "Reserve lifecycle restore watcher not found" };
  }
  code = replaceMatch(
    code,
    restore,
    `let ${restore[1]}=a(${reserveAtom},t);if(!${restore[1]}){e.set(${CORE_SELECTION},t,new Set);e.set(${CORE_MANUAL_SELECTION},t,new Set)}if(i&&!${restore[1]}){`,
  );
  changes.push("clear Reserve and manual selection state when the fallback window ends");

  const defaultModelRe = new RegExp(
    `\\(r===${escapeRegExp(BACKTICK)}tpp${escapeRegExp(BACKTICK)}\\|\\|r===${escapeRegExp(
      BACKTICK,
    )}flora${escapeRegExp(BACKTICK)}\\)&&n\\(${escapeRegExp(reserveAtom)},${escapeRegExp(BACKTICK)}local${escapeRegExp(
      BACKTICK,
    )}\\)\\?${escapeRegExp(reserveConst)}:e==null\\?n\\((${IDENT}),r\\)\\.slug:n\\((${IDENT}),e\\)\\.slug`,
    "g",
  );
  let defaultModelCount = 0;
  code = code.replace(defaultModelRe, (_match, emptyThreadModelLookup, conversationModelLookup) => {
    defaultModelCount++;
    // Same resolution as when Reserve limit-fallback has not been triggered:
    // empty composer → workspace default; restored thread → saved conversation model.
    return `e==null?n(${emptyThreadModelLookup},r).slug:n(${conversationModelLookup},e).slug`;
  });
  if (defaultModelCount === 0) {
    return { status: "error", code: source, reason: "Reserve default-model override not found" };
  }
  changes.push(
    `resolve ${defaultModelCount} restored-session and new-session model lookup(s) without forcing Reserve`,
  );

  const submitRe = new RegExp(
    `model:(${IDENT})===${escapeRegExp(BACKTICK)}tpp${escapeRegExp(BACKTICK)}&&(${IDENT})\\.get\\(${escapeRegExp(reserveAtom)},${escapeRegExp(
      BACKTICK,
    )}local${escapeRegExp(BACKTICK)}\\)\\?${escapeRegExp(BACKTICK)}gpt-reserve${escapeRegExp(
      BACKTICK,
    )}:(${IDENT})\\.slug`,
  );
  const submit = submitRe.exec(code);
  if (!submit) {
    if (!code.includes("async function dFr") || !code.includes("model:h,resumeAttemptCount")) {
      return { status: "error", code: source, reason: "Reserve submit override not found" };
    }
    changes.push("use the lifecycle-selected model in the refactored submission path");
  } else {
    // Do not force gpt-reserve merely because Reserve is available. Send whatever
    // model the session already resolved (saved, default, explicit Reserve, or
    // lifecycle fallback).
    code = replaceMatch(code, submit, `model:${submit[3]}.slug`);
    changes.push("send the saved model instead of forcing Reserve when a session starts");
  }

  return {
    status: "patched",
    code: `${CORE_MARKER}\n${code}`,
    changes,
    kind: "core",
  };
}

function migratePatchedCurrent(source) {
  if (!source.includes(MARKER)) return null;

  let code = source;
  const changes = [];
  const appendRe = new RegExp(
    `(${IDENT})=\\[\\.\\.\\.\\(\\1\\?\\?\\[\\]\\)\\.filter\\(e=>e!==(${IDENT})\\),\\.\\.\\.\\(\\2==null\\?\\[\\]:\\[\\2\\]\\)\\]`,
  );
  const append = appendRe.exec(code);
  if (!append) return null;
  const listVar = append[1];
  const reserveRowVar = append[2];
  const reserveSelector = `${BACKTICK}gpt-reserve${BACKTICK}`;
  code = replaceMatch(
    code,
    append,
    reserveListInsertion(listVar, reserveRowVar, reserveSelector),
  );
  changes.push("migrate the old Reserve row to a distinct synthetic wire model");

  const displayRe = new RegExp(
    `(${IDENT})=(${IDENT})\\?${escapeRegExp(reserveRowVar)}\\?\\.model\\?\\?(${IDENT}):(${IDENT})`,
  );
  const display = displayRe.exec(code);
  if (!display) return { status: "error", code: source, reason: "old Reserve display expression not found" };
  code = replaceMatch(
    code,
    display,
    `${display[1]}=${display[2]}&&${display[4]}===${reserveSelector}?${reserveSelector}:${display[2]}?${reserveRowVar}?.model??${display[3]}:${display[4]}`,
  );
  changes.push("migrate the old selected-model display expression");

  // Match the complete old helper separately because the optional chaining
  // token is easier to express without relying on a broad dot wildcard.
  const oldTranslateRe = new RegExp(
    `function\\s+(${IDENT})\\(e\\)\\{return(${IDENT})&&e===${escapeRegExp(
      reserveRowVar,
    )}\\?\\.model\\?(${IDENT}):e\\}`,
  );
  const oldTranslate = oldTranslateRe.exec(code);
  if (!oldTranslate) {
    return { status: "error", code: source, reason: "old Reserve translation helper not found" };
  }
  code = replaceMatch(code, oldTranslate, `function ${oldTranslate[1]}(e){return e}`);
  changes.push("migrate the old model translation helper");

  return { status: "patched", code, changes, kind: "current-migration" };
}


function hasUsageCandidate(source) {
  return (
    source.includes(USAGE_MARKER) ||
    (source.includes("additional_rate_limits") &&
      source.includes("activeLimitName") &&
      source.includes("selectedModel") &&
      source.includes("limitName==null"))
  );
}

function findUsageFilter(source) {
  // Upstream builds the remaining-usage list from core + additional_rate_limits,
  // then keeps only the core row and the additional limit that matches the
  // selected model (or active limit name). Match the filter shape rather than
  // the minified helper name so gpt-reserve stays listed while an ordinary
  // model is selected.
  const filterRe = new RegExp(
    `return (${IDENT})\\?(${IDENT})\\.filter\\((${IDENT})=>\\3\\.limitName==null\\|\\|(${IDENT})\\(\\3\\.limitName\\)===\\1\\):\\2\\.filter\\(\\3=>\\3\\.limitName==null\\)`,
  );
  const match = filterRe.exec(source);
  if (!match) return null;
  const nearby = source.slice(Math.max(0, match.index - 500), match.index + match[0].length + 200);
  if (!nearby.includes("activeLimitName") || !nearby.includes("selectedModel")) return null;
  if (!nearby.includes("additional_rate_limits") && !source.includes("additional_rate_limits")) {
    // The builder that pushes additional_rate_limits lives just above this helper.
    const ahead = source.slice(Math.max(0, match.index - 1200), match.index);
    if (!ahead.includes("additional_rate_limits")) return null;
  }
  return match;
}

function patchUsage(source) {
  if (source.includes(USAGE_MARKER)) {
    return { status: "already", code: source, changes: [], kind: "usage" };
  }
  if (!hasUsageCandidate(source)) return null;

  const filter = findUsageFilter(source);
  if (!filter) {
    return { status: "error", code: source, reason: "remaining-usage rate-limit filter not found" };
  }

  const activeVar = filter[1];
  const listVar = filter[2];
  const itemVar = filter[3];
  const normalizeVar = filter[4];
  const reserveLiteral = `${BACKTICK}gpt-reserve${BACKTICK}`;
  const keepReserve = `||${normalizeVar}(${itemVar}.limitName)===${reserveLiteral}`;
  const replacement =
    `return ${activeVar}?${listVar}.filter(${itemVar}=>${itemVar}.limitName==null||${normalizeVar}(${itemVar}.limitName)===${activeVar}${keepReserve}):${listVar}.filter(${itemVar}=>${itemVar}.limitName==null${keepReserve})`;

  const code = replaceMatch(source, filter, replacement);
  return {
    status: "patched",
    code: `${USAGE_MARKER}\n${code}`,
    changes: [
      "keep the gpt-reserve remaining-usage row visible while an ordinary model is selected",
    ],
    kind: "usage",
  };
}

function patchSource(source) {
  if (source.includes(MARKER)) {
    return migratePatchedCurrent(source) ?? { status: "already", code: source, changes: [] };
  }

  const current = patchCurrent(source);
  if (current) {
    if (!current.ok) return { status: "error", reason: current.reason, code: source };
    return {
      status: "patched",
      code: `${MARKER}\n${current.code}`,
      changes: current.changes,
      kind: current.kind,
    };
  }

  const legacy = patchLegacy(source);
  if (legacy) {
    if (!legacy.ok) return { status: "error", reason: legacy.reason, code: source };
    return {
      status: "patched",
      code: `${MARKER}\n${legacy.code}`,
      changes: legacy.changes,
      kind: legacy.kind,
    };
  }

  return { status: "none", code: source, changes: [] };
}

function findTargets(platform) {
  const platforms = platform ? [platform] : PLATFORMS;
  const targets = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const file of fs.readdirSync(assetsDir)) {
      if (!file.endsWith(".js")) continue;
      const filePath = path.join(assetsDir, file);
      const source = fs.readFileSync(filePath, "utf8");
      if (hasReservePickerCandidate(source)) {
        targets.push({ kind: "picker", platform: plat, path: filePath, source });
      }
    }
  }
  return targets;
}

function findCoreTargets(platform) {
  const platforms = platform ? [platform] : PLATFORMS;
  const targets = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const file of fs.readdirSync(assetsDir)) {
      if (!file.endsWith(".js")) continue;
      const filePath = path.join(assetsDir, file);
      const source = fs.readFileSync(filePath, "utf8");
      if (hasCoreCandidate(source)) {
        targets.push({ kind: "core", platform: plat, path: filePath, source });
      }
    }
  }
  return targets;
}


function findUsageTargets(platform) {
  const platforms = platform ? [platform] : PLATFORMS;
  const targets = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const file of fs.readdirSync(assetsDir)) {
      if (!file.endsWith(".js")) continue;
      const filePath = path.join(assetsDir, file);
      const source = fs.readFileSync(filePath, "utf8");
      if (hasUsageCandidate(source)) {
        targets.push({ kind: "usage", platform: plat, path: filePath, source });
      }
    }
  }
  return targets;
}

function applyPatchKind(kind, source) {
  if (kind === "core") return patchCore(source);
  if (kind === "usage") return patchUsage(source);
  return patchSource(source);
}

function hasCandidateKind(kind, source) {
  if (kind === "picker") return hasReservePickerCandidate(source);
  if (kind === "usage") return hasUsageCandidate(source);
  return hasCoreCandidate(source);
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((arg) => PLATFORMS.includes(arg));
  const targets = [...findTargets(platform), ...findCoreTargets(platform), ...findUsageTargets(platform)];

  if (targets.length === 0) {
    console.log("  [skip] No Luna Reserve bundle found");
    return;
  }

  // One Electron asset can match picker, core, and usage at once. Targets were
  // pre-loaded from disk, so writing each kind separately let the later write
  // replace the earlier patch with a stale copy (usage wiped the saved-model
  // core fix and Reserve got selected again). Chain kinds per file, then write once.
  const byPath = new Map();
  for (const target of targets) {
    const group = byPath.get(target.path) ?? [];
    group.push(target);
    byPath.set(target.path, group);
  }

  let patched = 0;
  let failed = 0;
  for (const [filePath, group] of byPath) {
    let source = fs.readFileSync(filePath, "utf8");
    let fileChanged = false;
    const platformLabel = group[0].platform;

    console.log(`  [${platformLabel}] ${relPath(filePath)}`);

    for (const target of group) {
      const result = applyPatchKind(target.kind, source);
      if (result.status === "none") {
        if (hasCandidateKind(target.kind, source)) {
          console.error(
            `    [x] contains Reserve ${target.kind} logic but no supported patch shape`,
          );
          failed++;
        }
        continue;
      }
      if (result.status === "already") {
        console.log(`    [ok] Luna Reserve ${target.kind} patch already applied`);
        source = result.code;
        continue;
      }
      if (result.status === "error") {
        console.error(`    [x] ${result.reason}`);
        failed++;
        continue;
      }

      for (const change of result.changes) console.log(`    * ${change}`);
      source = result.code;
      fileChanged = true;
    }

    if (!fileChanged) continue;
    if (!isCheck) {
      fs.writeFileSync(filePath, source, "utf8");
      patched++;
    } else {
      console.log("    [?] dry-run; no file written");
    }
  }

  if (failed > 0) process.exit(1);
  console.log(`  [ok] ${patched} bundle(s) patched`);
}

if (require.main === module) main();

module.exports = {
  MARKER,
  CORE_MARKER,
  USAGE_MARKER,
  patchSource,
  patchCurrent,
  patchLegacy,
  patchCore,
  patchUsage,
  hasCoreCandidate,
  hasUsageCandidate,
};
