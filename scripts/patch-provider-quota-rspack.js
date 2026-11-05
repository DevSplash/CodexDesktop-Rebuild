/** Adapt the provider-aware quota patch to Rspack's ESM chunk/module tables. */
const { parse } = require("acorn");

function walk(node, visit, root = node, ownScope = false) {
  if (!node?.type || ownScope && node !== root && /Function/.test(node.type)) return;
  visit(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) for (const item of child) walk(item, visit, root, ownScope);
    else if (child?.type) walk(child, visit, root, ownScope);
  }
}

function findNodes(root, predicate, ownScope = false) {
  const result = [];
  walk(root, node => { if (predicate(node)) result.push(node); }, root, ownScope);
  return result;
}

function parseModule(source) {
  return parse(source, { ecmaVersion: "latest", sourceType: "module" });
}

function key(node) {
  return node?.name ?? node?.value;
}

function unique(items, label) {
  const values = [...new Set(items)];
  if (values.length !== 1) throw new Error(`${label} is ambiguous/missing (${values.length})`);
  return values[0];
}

function readModules(file) {
  const ast = parseModule(file.source);
  const table = ast.body.flatMap(node => node.type === "ExportNamedDeclaration"
    ? node.declaration?.declarations ?? [] : [])
    .find(node => node.id?.name === "__webpack_modules__")?.init;
  if (table?.type !== "ObjectExpression") throw new Error(`Rspack module table missing: ${file.name}`);
  return table.properties.filter(node => /Function/.test(node.value?.type)).map(node => ({
    file,
    id: key(node.key),
    requireName: node.value.params[2]?.name,
    exportsName: node.value.params[1]?.name,
    start: node.value.body.start + 1,
    end: node.value.body.end - 1,
    source: file.source.slice(node.value.body.start + 1, node.value.body.end - 1),
  }));
}

function bindings(module) {
  const ast = parseModule(module.source);
  const imports = new Map();
  const exports = new Map();
  walk(ast, node => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" &&
      node.init?.type === "CallExpression" && node.init.callee.name === module.requireName &&
      typeof node.init.arguments[0]?.value === "string") {
      imports.set(node.id.name, node.init.arguments[0].value);
    }
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression" ||
      node.callee.object.name !== module.requireName || key(node.callee.property) !== "d" ||
      node.arguments[0]?.name !== module.exportsName) return;
    // Rspack emits both getter exports (second argument) and direct-value
    // exports (third argument). Neither form is an ES import/export statement.
    for (const object of node.arguments.slice(1)) {
      if (object.type !== "ObjectExpression") continue;
      for (const prop of object.properties) {
        const exported = prop.value?.type === "ArrowFunctionExpression" ? prop.value.body : prop.value;
        if (exported?.type === "Identifier") exports.set(exported.name, key(prop.key));
      }
    }
  }, ast, true);
  function origin(node) {
    if (node?.type !== "MemberExpression" || node.computed || !imports.has(node.object.name)) return null;
    return JSON.stringify([imports.get(node.object.name), key(node.property)]);
  }
  function reference(originKey) {
    const [id, name] = JSON.parse(originKey);
    const alias = [...imports].find(([, imported]) => imported === id)?.[0];
    return alias ? `${alias}[${JSON.stringify(name)}]` : null;
  }
  return { ast, exports, origin, reference };
}

function patchRspackFiles(files, { patchSource, quotaAtoms }) {
  const modules = files.filter(file => /\bexport\s+(?:const|let|var)\s+__webpack_modules__\s*=/.test(file.source) &&
    (file.source.includes("hardBlocked") || file.source.includes("model_provider") ||
      file.source.includes("authenticatedAccountId") && file.source.includes("windowMinutes") ||
      file.source.includes("submitDisabled") && file.source.includes("resolvedConfig")))
    .flatMap(readModules)
    .filter(module => module.source.includes("hardBlocked") || module.source.includes("model_provider") ||
      module.source.includes("authenticatedAccountId") && module.source.includes("windowMinutes") ||
      module.source.includes("submitDisabled") && module.source.includes("resolvedConfig"));
  const hostAtoms = [];
  const providerAtoms = [];
  const accountAtoms = [];
  const parsed = new Map();
  for (const module of modules) {
    const data = bindings(module);
    parsed.set(module, data);
    for (const node of findNodes(data.ast, node => node.type === "VariableDeclarator" &&
      node.init?.type === "CallExpression")) {
      if (node.init.arguments.some(arg => arg.type === "ArrowFunctionExpression" &&
        arg.body.type === "MemberExpression" && key(arg.body.property) === "hardBlocked" &&
        arg.body.object.type === "CallExpression") && data.exports.has(node.id.name)) {
        hostAtoms.push(JSON.stringify([module.id, data.exports.get(node.id.name)]));
      }
    }
    for (const name of quotaAtoms(data.ast, module.source)) {
      if (data.exports.has(name)) accountAtoms.push(JSON.stringify([module.id, data.exports.get(name)]));
    }
    for (const node of findNodes(data.ast, node => node.type === "LogicalExpression" &&
      node.operator === "??" && node.left.type === "CallExpression" &&
      node.left.arguments.length === 2 && node.right.type === "MemberExpression" &&
      key(node.right.property) === "model_provider")) {
      const origin = data.origin(node.left.arguments[0]);
      if (origin) providerAtoms.push(origin);
    }
  }
  const host = unique(hostAtoms, "Rspack host quota atom");
  const provider = unique(providerAtoms, "Rspack saved-thread provider atom");
  const account = unique(accountAtoms, "Rspack account quota atom");
  const composers = modules.filter(module => {
    const data = parsed.get(module);
    return data.reference(host) && data.ast.body.some(node => node.type === "FunctionDeclaration" &&
      findNodes(node, child => child.type === "Property" && key(child.key) === "submitDisabled", true).length &&
      findNodes(node, child => child.type === "MemberExpression" && key(child.property) === "resolvedConfig").length);
  });
  unique(composers.map(module => module.id), "Rspack composer module");
  const updates = new Map();
  const changes = [];
  for (const module of composers) {
    const data = parsed.get(module);
    const references = [host, provider, account].map(origin => data.reference(origin));
    if (references.some(ref => !ref)) throw new Error("Rspack composer quota/provider imports missing");
    const result = patchSource(module.source, { rspackReferences: references });
    if (result.status === "error") throw new Error(`${module.file.name}: ${result.reason}`);
    if (result.status === "already") continue;
    const edits = updates.get(module.file) ?? [];
    edits.push({ start: module.start, end: module.end, code: result.code });
    updates.set(module.file, edits);
    changes.push(...result.changes);
  }
  // A module can be emitted into several async chunks. Patch every copy;
  // otherwise the first loaded chunk can restore the unpatched behavior.
  const outputs = [];
  for (const [file, edits] of updates) {
    let code = file.source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      code = code.slice(0, edit.start) + edit.code + code.slice(edit.end);
    }
    parseModule(code);
    outputs.push({ file, code });
  }
  return { outputs, changes: [...new Set(changes)], copies: composers.length };
}

module.exports = { patchRspackFiles };
