const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('aster', {
  getState: call('state:get'),
  saveSettings: call('settings:save'),

  projectInfo: call('project:info'),
  openNotes: call('project:openNotes'),
  openMemory: call('project:openMemory'),
  listProcesses: call('procs:list'),
  stopProcess: call('procs:stop'),
  openProcessLog: call('procs:log'),
  ollamaOverview: call('ollama:overview'),
  colibriStatus: call('colibri:status'),
  colibriStop: call('colibri:stop'),
  colibriPickFolder: call('colibri:pickFolder'),
  setupPlan: call('setup:plan'),
  setupApply: call('setup:apply'),
  setupDismiss: call('setup:dismiss'),
  pullModel: call('ollama:pull'),
  cancelPull: call('ollama:cancelPull'),

  listConversations: call('conv:list'),
  getConversation: call('conv:get'),
  renameConversation: call('conv:rename'),
  starConversation: call('conv:star'),
  deleteConversation: call('conv:delete'),
  setConversationModel: call('conv:setModel'),
  pickFolder: call('conv:pickFolder'),
  pickFolderDraft: call('conv:pickFolderDraft'),
  searchConversations: call('conv:search'),
  createPreview: call('preview:create'),

  send: call('chat:send'),
  regenerate: call('chat:regenerate'),
  edit: call('chat:edit'),
  stop: call('chat:stop'),
  approve: call('chat:approve'),

  openConfig: call('config:open'),
  revealConfig: call('config:reveal'),
  reloadConfig: call('config:reload'),
  importClaudeDesktop: call('config:import'),
  restartServer: call('mcp:restart'),
  mcpStatus: call('mcp:status'),

  getUsage: call('usage:get'),
  resetPermissions: call('permissions:reset'),
  setTitleBar: call('window:titlebar'),
  openExternal: call('app:openExternal'),
  revealData: call('app:revealData'),

  on(channel, fn) {
    const allowed = ['chat:event', 'mcp:status', 'config:changed', 'procs:changed', 'ollama:pull'];
    if (!allowed.includes(channel)) throw new Error(`unknown channel ${channel}`);
    const listener = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
