"use strict";
// A browser boundary double for ownership tests. Real Chromium separately proves the
// sealed isolated world in browser-answer-routes.chromium.test.js.
function privacyPage(values = [], fields = []) {
  const data = { values, fields, names: [], filled: false, echoed: false, frames: 0 };
  const injected = { evaluate: async () => data };
  const utility = { delegate: { _client: { send: async method => method === "DOM.getDocument" ? { root: { nodeId: 1 } } : method === "DOM.querySelectorAll" ? { nodeIds: [] } : {} }, _contextId: 1 }, injectedScript: async () => injected };
  const frame = {};
  return { _connection: { toImpl: () => ({ _id: "fixture-frame", utilityContext: async () => utility }) }, mainFrame: () => frame, frames: () => [frame], locator: () => ({}) };
}
module.exports = { privacyPage };
