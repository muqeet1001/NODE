const fs = require('fs')
const path = require('path')

// ── Project path confinement ──────────────────────────────────
let activeProjectPath = null

function setActiveProjectPath(projectPath) {
  activeProjectPath = path.resolve(projectPath)
}

function validateProjectPath(projectPath) {
  const resolved = path.resolve(projectPath)
  if (activeProjectPath === null) {
    activeProjectPath = resolved
    return true
  }
  return resolved === activeProjectPath
}

// ── Error sanitization ────────────────────────────────────
function sanitizeError(err) {
  console.error('[FileSystem]', err)
  switch (err.code) {
    case 'ENOENT': return 'File not found'
    case 'EACCES':
    case 'EPERM': return 'Access denied'
    case 'EEXIST': return 'File already exists'
    default: return 'File operation failed'
  }
}

// Private helper: get .nord folder path
function getNordPath(projectPath) {
  return path.join(projectPath, '.nord')
}

// Create .nord folder
function createNordFolder(projectPath) {
  try {
    const nordPath = getNordPath(projectPath)
    fs.mkdirSync(nordPath, { recursive: true })
    return { success: true, path: nordPath }
  } catch (err) {
    return { success: false, error: sanitizeError(err) }
  }
}

// Private helper: sanitize filename
function sanitizeFilename(filename) {
  // Allow alphanumeric, dots, underscores, hyphens
  const validPattern = /^[a-zA-Z0-9._-]+$/
  
  // Check basic pattern
  if (!validPattern.test(filename)) {
    return null
  }
  
  // Reject absolute paths
  if (path.isAbsolute(filename)) {
    return null
  }
  
  // Reject traversal sequences
  if (filename.includes('..')) {
    return null
  }
  
  // Reject special path segments
  const normalized = path.normalize(filename)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('..')) {
    return null
  }
  
  return filename
}

// Private helper: validate a relative path with subdirectories
function validateRelativePath(relativePath) {
  if (path.isAbsolute(relativePath)) return false
  const segments = relativePath.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false
    if (!/^[a-zA-Z0-9._-]+$/.test(seg)) return false
  }
  return true
}

// Write file to a nested path inside .nord folder
function writeFileNested(projectPath, relativePath, content) {
  if (!validateRelativePath(relativePath)) {
    return { success: false, error: 'Invalid path' }
  }

  try {
    const fullPath = path.join(projectPath, '.nord', relativePath)
    const dirPath = path.dirname(fullPath)
    fs.mkdirSync(dirPath, { recursive: true })
    fs.writeFileSync(fullPath, content, 'utf-8')
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// Read file from a nested path inside .nord folder
function readFileNested(projectPath, relativePath) {
  if (!validateRelativePath(relativePath)) {
    return { success: false, error: 'Invalid path' }
  }

  try {
    const fullPath = path.join(projectPath, '.nord', relativePath)
    const content = fs.readFileSync(fullPath, 'utf-8')
    return content
  } catch (err) {
    if (err.code === 'ENOENT') return null
    return { success: false, error: sanitizeError(err) }
  }
}

// Write file to .nord folder
function writeFile(projectPath, filename, content) {
  // Validate filename
  const sanitized = sanitizeFilename(filename)
  if (!sanitized) {
    return { success: false, error: 'Invalid filename' }
  }

  // Ensure .nord folder exists
  const folderResult = createNordFolder(projectPath)
  if (!folderResult.success) {
    return folderResult
  }

  try {
    const filePath = path.join(getNordPath(projectPath), sanitized)
    fs.writeFileSync(filePath, content, 'utf-8')
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// Read file from .nord folder
function readFile(projectPath, filename) {
  // Validate filename
  const sanitized = sanitizeFilename(filename)
  if (!sanitized) {
    return { success: false, error: 'Invalid filename' }
  }

  try {
    const filePath = path.join(getNordPath(projectPath), sanitized)
    const content = fs.readFileSync(filePath, 'utf-8')
    return content
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null // File not found
    }
    // For other errors, return error object
    return { success: false, error: err.message }
  }
}

// List files in .nord folder
function listFiles(projectPath, recursive = false) {
  try {
    const nordPath = getNordPath(projectPath)

    if (!recursive) {
      const files = fs.readdirSync(nordPath)
      // Filter to only files (not directories)
      const fileList = files.filter(name => {
        try {
          const filePath = path.join(nordPath, name)
          return fs.statSync(filePath).isFile()
        } catch {
          return false
        }
      })
      return fileList
    }

    // Recursive walk
    const results = []
    function walk(dir, prefix) {
      const entries = fs.readdirSync(dir)
      for (const entry of entries) {
        const fullEntry = path.join(dir, entry)
        const relativeName = prefix ? prefix + '/' + entry : entry
        try {
          const stat = fs.statSync(fullEntry)
          if (stat.isFile()) {
            results.push(relativeName)
          } else if (stat.isDirectory()) {
            walk(fullEntry, relativeName)
          }
        } catch {
          // skip inaccessible entries
        }
      }
    }
    walk(nordPath, '')
    return results
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [] // Folder doesn't exist yet
    }
    // For other errors, return error object
    return { success: false, error: err.message }
  }
}

// Delete file from .nord folder
function deleteFile(projectPath, filename) {
  // Validate filename
  const sanitized = sanitizeFilename(filename)
  if (!sanitized) {
    return { success: false, error: 'Invalid filename' }
  }

  try {
    const filePath = path.join(getNordPath(projectPath), sanitized)
    fs.unlinkSync(filePath)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// ── Design-specific helpers ──────────────────────────────────

// Write file to .nord/design/ folder
function writeDesignFile(projectPath, filename, content) {
  return writeFileNested(projectPath, 'design/' + filename, content)
}

// Read file from .nord/design/ folder
function readDesignFile(projectPath, filename) {
  return readFileNested(projectPath, 'design/' + filename)
}

// List all files in .nord/design/ recursively
function listDesignAssets(projectPath) {
  try {
    const designPath = path.join(projectPath, '.nord', 'design')
    if (!fs.existsSync(designPath)) return []

    const results = []
    function walk(dir, prefix) {
      const entries = fs.readdirSync(dir)
      for (const entry of entries) {
        const fullEntry = path.join(dir, entry)
        const relativeName = prefix ? prefix + '/' + entry : entry
        try {
          const stat = fs.statSync(fullEntry)
          if (stat.isFile()) {
            results.push(relativeName)
          } else if (stat.isDirectory()) {
            walk(fullEntry, relativeName)
          }
        } catch {
          // skip inaccessible entries
        }
      }
    }
    walk(designPath, '')
    return results
  } catch (err) {
    if (err.code === 'ENOENT') return []
    return { success: false, error: sanitizeError(err) }
  }
}

// Register IPC handlers
function registerFileHandlers(ipcMain) {
  // createNordFolder handler
  ipcMain.handle('fs:createNordFolder', async (event, projectPath) => {
    if (!validateProjectPath(projectPath)) return { success: false, error: 'Access denied: invalid project path' }
    try {
      const result = createNordFolder(projectPath)
      return result
    } catch (err) {
      return { success: false, error: sanitizeError(err) }
    }
  })

  // writeFile handler
  ipcMain.handle('fs:writeFile', async (event, projectPath, filename, content) => {
    if (!validateProjectPath(projectPath)) return { success: false, error: 'Access denied: invalid project path' }
    try {
      const result = writeFile(projectPath, filename, content)
      return result
    } catch (err) {
      return { success: false, error: sanitizeError(err) }
    }
  })

  // readFile handler
  ipcMain.handle('fs:readFile', async (event, projectPath, filename) => {
    if (!validateProjectPath(projectPath)) return { success: false, error: 'Access denied: invalid project path' }
    try {
      const result = readFile(projectPath, filename)
      // readFile returns string, null, or { success: false, error }
      if (result && typeof result === 'object' && result.success === false) {
        return result // Error object
      }
      return result // String or null
    } catch (err) {
      return { success: false, error: sanitizeError(err) }
    }
  })

  // listFiles handler
  ipcMain.handle('fs:listFiles', async (event, projectPath, recursive) => {
    if (!validateProjectPath(projectPath)) return { success: false, error: 'Access denied: invalid project path' }
    try {
      const result = listFiles(projectPath, recursive)
      // listFiles returns array, [], or { success: false, error }
      return result
    } catch (err) {
      return { success: false, error: sanitizeError(err) }
    }
  })

  // writeFileNested handler
  ipcMain.handle('fs:writeFileNested', async (event, projectPath, relativePath, content) => {
    if (!validateProjectPath(projectPath)) return { success: false, error: 'Access denied: invalid project path' }
    try {
      return writeFileNested(projectPath, relativePath, content)
    } catch (err) {
      return { success: false, error: sanitizeError(err) }
    }
  })

  // readFileNested handler
  ipcMain.handle('fs:readFileNested', async (event, projectPath, relativePath) => {
    if (!validateProjectPath(projectPath)) return { success: false, error: 'Access denied: invalid project path' }
    try {
      const result = readFileNested(projectPath, relativePath)
      if (result && typeof result === 'object' && result.success === false) {
        return result
      }
      return result // String or null
    } catch (err) {
      return { success: false, error: sanitizeError(err) }
    }
  })

  // deleteFile handler
  ipcMain.handle('fs:deleteFile', async (event, projectPath, filename) => {
    if (!validateProjectPath(projectPath)) return { success: false, error: 'Access denied: invalid project path' }
    try {
      const result = deleteFile(projectPath, filename)
      return result
    } catch (err) {
      return { success: false, error: sanitizeError(err) }
    }
  })

  // ── Design-specific IPC handlers ─────────────────────

  ipcMain.handle('fs:writeDesignFile', async (event, projectPath, filename, content) => {
    if (!validateProjectPath(projectPath)) return { success: false, error: 'Access denied: invalid project path' }
    try {
      return writeDesignFile(projectPath, filename, content)
    } catch (err) {
      return { success: false, error: sanitizeError(err) }
    }
  })

  ipcMain.handle('fs:readDesignFile', async (event, projectPath, filename) => {
    if (!validateProjectPath(projectPath)) return { success: false, error: 'Access denied: invalid project path' }
    try {
      const result = readDesignFile(projectPath, filename)
      if (result && typeof result === 'object' && result.success === false) {
        return result
      }
      return result
    } catch (err) {
      return { success: false, error: sanitizeError(err) }
    }
  })

  ipcMain.handle('fs:listDesignAssets', async (event, projectPath) => {
    if (!validateProjectPath(projectPath)) return { success: false, error: 'Access denied: invalid project path' }
    try {
      return listDesignAssets(projectPath)
    } catch (err) {
      return { success: false, error: sanitizeError(err) }
    }
  })

  // Set active project path (resets confinement guard)
  ipcMain.handle('fs:setActiveProject', async (event, projectPath) => {
    try {
      setActiveProjectPath(projectPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: sanitizeError(err) }
    }
  })
}

// Export all functions
module.exports = {
  createNordFolder,
  writeFile,
  readFile,
  writeFileNested,
  readFileNested,
  listFiles,
  deleteFile,
  writeDesignFile,
  readDesignFile,
  listDesignAssets,
  registerFileHandlers,
  setActiveProjectPath
}