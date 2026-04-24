const { EventEmitter } = require('events')
const db = require('./dbHandler')

class KeyRotator extends EventEmitter {
  constructor() {
    super()
    this.currentKeyForModel = { groq: {}, nvidia: {}, openrouter: {} }
    this.keys = { groq: [], nvidia: [], openrouter: [] }
  }

  init() {
    this.keys.groq = db.getKeysForProvider('groq')
    this.keys.nvidia = db.getKeysForProvider('nvidia')
    this.keys.openrouter = db.getKeysForProvider('openrouter')

    // Reset RPM-exhausted keys every 60 seconds
    setInterval(() => this.resetRPMExhausted(), 60 * 1000)

    // Schedule daily reset at midnight
    this.scheduleDailyReset()
  }

  getBestKey(provider, model) {
    // 1. Filter active keys
    const activeKeys = this.keys[provider].filter(k => k.is_active)
    if (activeKeys.length === 0) return null

    // 2. Check the current key for this model
    const currentKeyId = this.currentKeyForModel[provider][model]
    if (currentKeyId) {
      const state = db.getKeyModelState(provider, currentKeyId, model)
      if (state === null || state === undefined || state.status === 'ok') {
        const key = this.keys[provider].find(k => k.id === currentKeyId)
        if (key) {
          return { keyId: key.id, apiKey: key.api_key }
        }
      }
    }

    // 3. Current key is exhausted or unset — find the next available key
    for (let i = 0; i < activeKeys.length; i++) {
      const key = activeKeys[i]
      const state = db.getKeyModelState(provider, key.id, model)
      if (state === null || state === undefined || state.status === 'ok') {
        const fromKey = this.currentKeyForModel[provider][model]
        this.currentKeyForModel[provider][model] = key.id
        this.emit('key_rotated', {
          provider,
          model,
          fromKey,
          toKey: key.id,
          keyIndex: i + 1,
          totalKeys: activeKeys.length
        })
        return { keyId: key.id, apiKey: key.api_key }
      }
    }

    // 4. No available key found
    this.emit('all_keys_exhausted', { provider, model })
    return null
  }

  markExhausted(provider, keyId, model, type = 'rpm') {
    db.setKeyModelState(provider, keyId, model, {
      status: type === 'daily' ? 'daily_exhausted' : type === 'invalid' ? 'invalid' : 'rpm_exhausted',
      exhausted_at: new Date().toISOString()
    })
    this.emit('key_exhausted', { provider, keyId, model, type })
  }

  resetRPMExhausted() {
    db.resetRPMExhaustedKeys()
    this.emit('rpm_reset')
  }

  scheduleDailyReset() {
    const now = new Date()
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(0, 0, 0, 0)
    const msUntilMidnight = tomorrow.getTime() - Date.now()

    setTimeout(() => {
      db.resetDailyExhaustedKeys()
      this.emit('daily_reset')

      setInterval(() => {
        db.resetDailyExhaustedKeys()
        this.emit('daily_reset')
      }, 24 * 60 * 60 * 1000)
    }, msUntilMidnight)
  }

  getFullStatus() {
    const status = {}
    for (const provider of ['groq', 'nvidia', 'openrouter']) {
      status[provider] = this.keys[provider].map(key => ({
        keyId: key.id,
        keyIndex: key.key_index,
        label: key.label,
        isActive: key.is_active,
        models: db.getAllModelStatesForKey(provider, key.id)
      }))
    }
    return status
  }

  reloadKeys() {
    this.keys = {
      groq: db.getKeysForProvider('groq'),
      nvidia: db.getKeysForProvider('nvidia'),
      openrouter: db.getKeysForProvider('openrouter')
    }
  }
}

// Singleton export
const rotator = new KeyRotator()
module.exports = rotator