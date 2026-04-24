const { contextBridge, ipcRenderer } = require('electron')

// ── IPC Channel Allowlists ─────────────────────────────────
const ALLOWED_INVOKE_CHANNELS = new Set([
  'db:getKey', 'db:setKey', 'db:saveProject', 'db:getProject',
  'db:getAllProjects', 'db:deleteProject', 'db:updateProjectPhase',
  'db:saveConversation', 'db:getConversations', 'db:saveAgentRun',
  'db:updateAgentRun', 'db:saveModelConfig', 'db:getModelConfig',
  'fs:createNordFolder', 'fs:writeFile', 'fs:readFile', 'fs:listFiles',
  'fs:writeFileNested', 'fs:readFileNested', 'fs:deleteFile', 'fs:setActiveProject',
  'fs:writeDesignFile', 'fs:readDesignFile', 'fs:listDesignAssets',
  'api:call', 'api:abort', 'agents:run',
  'design:generate-tokens', 'design:validate-tokens', 'design:generate-standards',
  'design:evaluate', 'design:classify-failure', 'design:generate-variants',
  'design:select-variant',
  'mcp:status', 'mcp:execute', 'mcp:capabilities', 'mcp:check-stitch',
  'plan:architect', 'plan:validate', 'plan:run-cli', 'plan:classify-failure',
  'build:frontend', 'build:validate-frontend', 'build:classify-frontend-failure',
  'build:backend', 'build:validate-backend', 'build:classify-backend-failure',
  'integration:api-connector', 'integration:data-flow', 'integration:auth-flow',
  'integration:validate', 'integration:classify-failure',
  'keys:add', 'keys:remove', 'keys:getStatus', 'keys:getAll',
  'cto:process-task', 'dialog:openFolder',
  'security:validate',
  'final:validate',
])

const ALLOWED_EVENT_CHANNELS = new Set([
  'api:chunk', 'agents:update', 'plan:architect-update',
  'build:progress', 'integration:progress',
  'rotator:key_rotated', 'rotator:key_exhausted',
  'rotator:all_exhausted', 'rotator:rpm_reset',
])

// Map to store wrapper functions for each callback
const callbackWrappers = new WeakMap()

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => {
    if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
      throw new Error(`Blocked IPC channel: ${channel}`)
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel, callback) => {
    if (!ALLOWED_EVENT_CHANNELS.has(channel)) {
      throw new Error(`Blocked IPC channel: ${channel}`)
    }
    // Create wrapper that strips the event parameter
    const wrapper = (event, ...args) => callback(...args)
    // Store mapping from original callback to wrapper
    callbackWrappers.set(callback, wrapper)
    // Register the wrapper
    ipcRenderer.on(channel, wrapper)
    // Return cleanup function that removes the wrapper
    return () => {
      ipcRenderer.removeListener(channel, wrapper)
      callbackWrappers.delete(callback)
    }
  },
  off: (channel, callback) => {
    if (!ALLOWED_EVENT_CHANNELS.has(channel)) {
      throw new Error(`Blocked IPC channel: ${channel}`)
    }
    // Get the wrapper for this callback
    const wrapper = callbackWrappers.get(callback)
    if (wrapper) {
      // Remove the wrapper, not the original callback
      ipcRenderer.removeListener(channel, wrapper)
      callbackWrappers.delete(callback)
    }
  }
})