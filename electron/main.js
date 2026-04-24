const { app, BrowserWindow, Menu, ipcMain, dialog, session } = require('electron')
const path = require('path')
const { initStore, registerDbHandlers } = require('./ipc/dbHandler')
const { registerApiHandlers } = require('./ipc/apiCaller')
const { registerAgentHandlers } = require('./ipc/agentRunner')
const { registerFileHandlers, setActiveProjectPath } = require('./ipc/fileSystem')
const { registerCtoHandlers } = require('./ipc/ctoEngine')
const { generateDesignTokens, validateTokens, generateStandards } = require('./services/designTokenEngine')
const { evaluateDesign, classifyFailureSource } = require('./services/designCritic')
const { generateVariants, selectBestVariant } = require('./services/variantGenerator')
const { checkMCPStatus, executeMCP, getMCPCapabilities, getStitchCapabilities } = require('./services/mcpManager')
const { validatePlan, classifyPlanFailure } = require('./services/planValidator')
const { runCLI } = require('./services/cliExecutor')
const { runArchitectAgent } = require('./agents/architectAgent')
const { runFrontendBuilder } = require('./agents/frontendBuilder')
const { runBackendBuilder } = require('./agents/backendBuilder')
const { validateFrontend, classifyFrontendFailure } = require('./services/frontendValidator')
const { validateBackend, classifyBackendFailure } = require('./services/backendValidator')
const { runApiConnectorAgent } = require('./agents/apiConnectorAgent')
const { runDataFlowAgent } = require('./agents/dataFlowAgent')
const { runAuthFlowAgent } = require('./agents/authFlowAgent')
const { validateIntegration, classifyIntegrationFailure } = require('./services/integrationValidator')
const { runSecurityChecks } = require('./services/securityValidator')
const { runFinalValidation } = require('./services/finalValidator')
const rotator = require('./ipc/keyRotator')
const { addKey, removeKey, getKeysForProvider } = require('./ipc/dbHandler')

Menu.setApplicationMenu(null)

let mainWindow = null

function createWindow() {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.whenReady().then(async () => {
  await initStore()

  registerDbHandlers(ipcMain)

  // ── CSP Headers ────────────────────────────────────────────
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = isDev
      ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:* https://api.groq.com https://integrate.api.nvidia.com https://openrouter.ai; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.groq.com https://integrate.api.nvidia.com https://openrouter.ai; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'"
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })

  mainWindow = createWindow()

  // Initialize key rotator (loads keys from DB, starts timers)
  rotator.init()

  registerApiHandlers(ipcMain, mainWindow)
  registerAgentHandlers(ipcMain, mainWindow)
  registerFileHandlers(ipcMain)
  registerCtoHandlers(ipcMain)

  ipcMain.handle('design:generate-tokens', async (event, input) => {
    try {
      return await generateDesignTokens(input)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('design:validate-tokens', async (event, tokens) => {
    try {
      return validateTokens(tokens)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('design:generate-standards', async (event, { tokens, projectPath }) => {
    try {
      return await generateStandards(tokens, projectPath)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('design:evaluate', async (event, input) => {
    try {
      return await evaluateDesign(input)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('design:classify-failure', async (event, issues) => {
    try {
      return classifyFailureSource(issues)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('design:generate-variants', async (event, input) => {
    try {
      return await generateVariants(input)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('design:select-variant', async (event, variants) => {
    try {
      return await selectBestVariant(variants)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('mcp:status', async () => {
    try {
      return await checkMCPStatus()
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('mcp:execute', async (event, { task, context }) => {
    try {
      return await executeMCP(task, context)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('mcp:capabilities', async () => {
    try {
      return await getMCPCapabilities()
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('mcp:check-stitch', async () => {
    try {
      return await getStitchCapabilities()
    } catch (err) {
      return { error: err.message }
    }
  })

  // ── Stage 3 Planning handlers ────────────────────────────
  ipcMain.handle('plan:architect', async (event, input) => {
    try {
      const onChunk = (token) => {
        mainWindow.webContents.send('plan:architect-update', { token })
      }
      return await runArchitectAgent({ ...input, onChunk })
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('plan:validate', async (event, input) => {
    try {
      return await validatePlan(input)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('plan:run-cli', async (event, input) => {
    try {
      return await runCLI(input)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('plan:classify-failure', async (event, issues) => {
    try {
      return classifyPlanFailure(issues)
    } catch (err) {
      return { error: err.message }
    }
  })

  // ── Stage 5 Build handlers ───────────────────────────────
  ipcMain.handle('build:frontend', async (event, input) => {
    try {
      const onChunk = (token) => {
        mainWindow.webContents.send('build:progress', { token, type: 'frontend' })
      }
      return await runFrontendBuilder({ ...input, onChunk })
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('build:validate-frontend', async (event, input) => {
    try {
      return await validateFrontend(input)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('build:classify-frontend-failure', async (event, issues) => {
    try {
      return classifyFrontendFailure(issues)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('build:backend', async (event, input) => {
    try {
      const onChunk = (token) => {
        mainWindow.webContents.send('build:progress', { token, type: 'backend' })
      }
      return await runBackendBuilder({ ...input, onChunk })
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('build:validate-backend', async (event, input) => {
    try {
      return await validateBackend(input)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('build:classify-backend-failure', async (event, issues) => {
    try {
      return classifyBackendFailure(issues)
    } catch (err) {
      return { error: err.message }
    }
  })

  // ── Stage 6 Integration handlers ────────────────────────
  ipcMain.handle('integration:api-connector', async (event, input) => {
    try {
      const onChunk = (token) => {
        mainWindow.webContents.send('integration:progress', { token, type: 'apiConnector' })
      }
      return await runApiConnectorAgent({ ...input, onChunk })
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('integration:data-flow', async (event, input) => {
    try {
      const onChunk = (token) => {
        mainWindow.webContents.send('integration:progress', { token, type: 'dataFlow' })
      }
      return await runDataFlowAgent({ ...input, onChunk })
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('integration:auth-flow', async (event, input) => {
    try {
      const onChunk = (token) => {
        mainWindow.webContents.send('integration:progress', { token, type: 'authFlow' })
      }
      return await runAuthFlowAgent({ ...input, onChunk })
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('integration:validate', async (event, input) => {
    try {
      return await validateIntegration(input)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('integration:classify-failure', async (event, issues) => {
    try {
      return classifyIntegrationFailure(issues)
    } catch (err) {
      return { error: err.message }
    }
  })

  // Key management IPC handlers
  ipcMain.handle('keys:add', async (event, provider, apiKey, label) => {
    try {
      const id = addKey(provider, apiKey, label)
      rotator.reloadKeys()
      return { success: true, data: id }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('keys:remove', async (event, keyId) => {
    try {
      removeKey(keyId)
      rotator.reloadKeys()
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('keys:getStatus', async () => {
    return rotator.getFullStatus()
  })

  ipcMain.handle('keys:getAll', async (event, provider) => {
    return getKeysForProvider(provider)
  })

  // Forward rotator events to renderer
  rotator.on('key_rotated', (data) => mainWindow.webContents.send('rotator:key_rotated', data))
  rotator.on('key_exhausted', (data) => mainWindow.webContents.send('rotator:key_exhausted', data))
  rotator.on('all_keys_exhausted', (data) => mainWindow.webContents.send('rotator:all_exhausted', data))
  rotator.on('rpm_reset', () => mainWindow.webContents.send('rotator:rpm_reset'))

  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  // ── Security validator ─────────────────────────────────────
  ipcMain.handle('security:validate', async () => {
    try {
      return runSecurityChecks();
    } catch (err) {
      return { secure: false, issues: [err.message], checks: {} };
    }
  });

  // ── Final production validator ─────────────────────────────
  ipcMain.handle('final:validate', async () => {
    try {
      return await runFinalValidation();
    } catch (err) {
      return { ready: false, issues: [err.message], checks: {} };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
