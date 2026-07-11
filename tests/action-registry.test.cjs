"use strict";

const assert = require("node:assert/strict");
const registry = require("../shared/action-registry.js");

const commands = registry.listCommandActions();
const actionNames = commands.map((entry) => entry.action);
const lifecycleValues = new Set(Object.values(registry.LIFECYCLES));
const scopeValues = new Set(Object.values(registry.SCOPES));
const controlValues = new Set(registry.CONTROL_TYPES);

assert.equal(commands.length, 63, "the public command matrix must contain 63 commands");
assert.equal(new Set(actionNames).size, 63, "every public command must have a unique action");

for (const entry of commands) {
  assert.equal(entry.command, true, entry.action + " must be a public command");
  assert.ok(lifecycleValues.has(entry.lifecycle), entry.action + " has an invalid lifecycle");
  assert.ok(scopeValues.has(entry.scope), entry.action + " has an invalid scope");
  assert.equal(typeof entry.pageDock, "boolean", entry.action + " must declare pageDock");
  assert.equal(typeof entry.stateful, "boolean", entry.action + " must declare stateful");
  assert.ok(Array.isArray(entry.controls), entry.action + " must declare controls");
  assert.equal(Object.isFrozen(entry.controls), true, entry.action + " controls must be immutable");
  assert.equal(new Set(entry.controls).size, entry.controls.length, entry.action + " controls must be unique");
  for (const control of entry.controls) {
    assert.ok(controlValues.has(control), entry.action + " has an invalid control: " + control);
  }

  const hasHandler = entry.scripts.length > 0 || Boolean(entry.internalPage) || entry.disabled;
  assert.ok(hasHandler, entry.action + " needs an execution handler or an explicit disabled reason");
  if (entry.disabled) {
    assert.equal(entry.lifecycle, registry.LIFECYCLES.UNSUPPORTED);
    assert.ok(entry.errorCode, entry.action + " must expose a disabled error code");
    assert.ok(entry.disabledReason, entry.action + " must expose a disabled reason");
  }
}

const stateful = registry.listStatefulActions();
assert.equal(stateful.length, 25, "the activity matrix must contain 25 persistent commands");
assert.equal(
  stateful.every((entry) => entry.controls.length > 0),
  true,
  "every persistent command must expose a close, recovery, or management control"
);

const dictator = registry.getAction("ACTIVATE_VISUAL_DICTATOR");
assert.equal(dictator.lifecycle, registry.LIFECYCLES.REVERSIBLE);
assert.deepEqual(dictator.controls, ["disable", "undo", "restoreAll", "manage"]);
assert.equal(dictator.pageDock, true);

const mediaSniffer = registry.getAction("EXTRACT_MEDIA");
assert.equal(mediaSniffer.lifecycle, registry.LIFECYCLES.INTERACTIVE);
assert.equal(mediaSniffer.scope, registry.SCOPES.TAB);
assert.equal(mediaSniffer.stateful, true);
assert.deepEqual(mediaSniffer.controls, ["disable", "manage"]);
assert.equal(mediaSniffer.pageDock, true);

const mediaBridge = registry.getAction("WO_MEDIA_SNIFFER");
assert.ok(mediaBridge, "WO_MEDIA_SNIFFER must be registered");
assert.equal(mediaBridge.command, false);
assert.equal(mediaBridge.mainWorld, true);
assert.equal(actionNames.includes("WO_MEDIA_SNIFFER"), false);

const activeActionsGet = registry.getAction("WO_ACTIVE_ACTIONS_GET");
assert.ok(activeActionsGet, "WO_ACTIVE_ACTIONS_GET must be registered");
assert.equal(activeActionsGet.command, false);
assert.equal(activeActionsGet.lifecycle, registry.LIFECYCLES.SYSTEM);

const globalPrivacy = registry.getAction("GLOBAL_PRIVACY_MODE");
assert.ok(globalPrivacy, "GLOBAL_PRIVACY_MODE must be registered");
assert.equal(globalPrivacy.command, false);
assert.equal(globalPrivacy.lifecycle, registry.LIFECYCLES.TOGGLE);
assert.equal(globalPrivacy.scope, registry.SCOPES.GLOBAL);
assert.equal(globalPrivacy.stateful, true);
assert.deepEqual(globalPrivacy.controls, ["disable"]);

const translateRestore = registry.getAction("WO_PAGE_TRANSLATE_RESTORE");
assert.equal(translateRestore.stateful, true);
assert.deepEqual(translateRestore.controls, ["restoreAll"]);
assert.equal(translateRestore.scope, registry.SCOPES.PAGE);
assert.equal(translateRestore.pageDock, true);

const domMonitor = registry.getAction("DOM_MONITOR_ADD");
assert.equal(domMonitor.scope, registry.SCOPES.DURABLE);
assert.equal(domMonitor.pageDock, true);

const unsupported = registry.getAction("JS_INJECTOR");
assert.equal(unsupported.errorCode, registry.ERROR_CODES.UNSUPPORTED_MV3_CSP);

console.log("Action registry contract passed: 63 commands, 25 persistent actions.");
