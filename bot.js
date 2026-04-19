try { require('dotenv').config() } catch {}

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const fs = require('fs')

// ===== CONFIG =====
const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT) || 25565
const USERNAME = process.env.MC_USERNAME || 'NeuroBotAI'
const GROK_API_KEY = process.env.GROK_API_KEY || 'gsk_YOURKEYHERE'
const MC_PASSWORD = process.env.MC_PASSWORD || 'nodejs'
const BOT_SKIN = 'TomiiStorm_'

// ===== MEMORY & DEEP LEARNING =====
const memoryFile = 'memory.json'
const learningFile = 'learning.json'
let memory = {}
let learning = {
  lessons: [],
  reactions: {},
  personalities: {},
  evolvedTraits: [],
  totalLessons: 0
}

function loadMemory() {
  if (fs.existsSync(memoryFile)) {
    try { memory = JSON.parse(fs.readFileSync(memoryFile)) } catch { memory = {} }
  } else {
    fs.writeFileSync(memoryFile, JSON.stringify({}))
  }
}

function loadLearning() {
  if (fs.existsSync(learningFile)) {
    try { learning = JSON.parse(fs.readFileSync(learningFile)) } catch {}
  } else {
    fs.writeFileSync(learningFile, JSON.stringify(learning, null, 2))
  }
}

function saveMemory() {
  fs.writeFileSync(memoryFile, JSON.stringify(memory, null, 2))
}

function saveLearning() {
  fs.writeFileSync(learningFile, JSON.stringify(learning, null, 2))
}

function learnFact(username, key, value) {
  if (!memory[username]) memory[username] = { chats: 0, facts: {} }
  if (!memory[username].facts) memory[username].facts = {}
  memory[username].facts[key] = value
  saveMemory()
}

function getPlayerMemory(username) {
  return memory[username] || null
}

function teachNeuro(username, lesson) {
  if (!learning.lessons) learning.lessons = []
  const exists = learning.lessons.find(l => l.lesson === lesson)
  if (!exists) {
    learning.lessons.push({
      from: username,
      lesson: lesson,
      timestamp: new Date().toISOString(),
      reinforced: 1
    })
  } else {
    exists.reinforced = (exists.reinforced || 1) + 1
  }
  learning.totalLessons = (learning.totalLessons || 0) + 1
  if (learning.lessons.length > 200) learning.lessons = learning.lessons.slice(-200)
  if (learning.totalLessons === 10) learning.evolvedTraits.push('quick learner')
  if (learning.totalLessons === 50) learning.evolvedTraits.push('experienced companion')
  if (learning.totalLessons === 100) learning.evolvedTraits.push('wise veteran')
  saveLearning()
  console.log(`📚 Neuro learned from ${username}: "${lesson}"`)
}

function learnReaction(event, reaction) {
  if (!learning.reactions) learning.reactions = {}
  learning.reactions[event] = reaction
  saveLearning()
}

function updatePersonality(username, sentiment) {
  if (!learning.personalities) learning.personalities = {}
  if (!learning.personalities[username]) {
    learning.personalities[username] = { trust: 50, friendship: 50, interactions: 0 }
  }
  const p = learning.personalities[username]
  p.interactions++
  if (sentiment === 'positive')  { p.trust = Math.min(100, p.trust + 5);  p.friendship = Math.min(100, p.friendship + 5) }
  if (sentiment === 'negative')  { p.trust = Math.max(0, p.trust - 10);   p.friendship = Math.max(0, p.friendship - 10) }
  if (sentiment === 'attacked')  { p.trust = Math.max(0, p.trust - 20) }
  saveLearning()
}

function getTopLessons(count = 8) {
  if (!learning.lessons || learning.lessons.length === 0) return 'none yet'
  return learning.lessons
    .sort((a, b) => (b.reinforced || 1) - (a.reinforced || 1))
    .slice(0, count)
    .map(l => `"${l.lesson}" (from ${l.from}, x${l.reinforced || 1})`)
    .join('\n')
}

loadMemory()
loadLearning()

// ===== INVENTORY =====
let storedInventory = { armor: {}, items: [], shield: null }
let lastInventoryHash = ''

function updateStoredInventory(bot) {
  if (!bot || !bot.inventory) return
  try {
    const inv = bot.inventory.items()
    const newItems = inv.map(i => ({ name: i.name, count: i.count, slot: i.slot }))
    const armorSlotMap = { 5: 'helmet', 6: 'chestplate', 7: 'leggings', 8: 'boots' }
    const newArmor = {}
    for (const [slot, name] of Object.entries(armorSlotMap)) {
      const item = bot.inventory.slots[parseInt(slot)]
      if (item) newArmor[name] = item.name
    }
    const offhand = bot.inventory.slots[45]
    const newShield = offhand ? offhand.name : null
    const newHash = JSON.stringify({ newItems, newArmor, newShield })
    if (newHash === lastInventoryHash) return
    lastInventoryHash = newHash
    storedInventory.items = newItems
    storedInventory.armor = newArmor
    storedInventory.shield = newShield
    console.log('📦 Inventory changed:', JSON.stringify(storedInventory))
  } catch (err) {
    console.log('Inventory error:', err.message)
  }
}

async function equipArmor(bot) {
  if (!bot) return
  const slots = [
    { keywords: ['helmet'],     dest: 'head'  },
    { keywords: ['chestplate'], dest: 'torso' },
    { keywords: ['leggings'],   dest: 'legs'  },
    { keywords: ['boots'],      dest: 'feet'  }
  ]
  for (const { keywords, dest } of slots) {
    const item = bot.inventory.items().find(i => keywords.some(k => i.name.includes(k)))
    if (item) try { await bot.equip(item, dest) } catch (e) { console.log('Equip error:', e.message) }
  }
}

async function equipShield(bot) {
  if (!bot) return
  const shield = bot.inventory.items().find(i => i.name.includes('shield'))
  if (shield) try { await bot.equip(shield, 'off-hand') } catch (e) { console.log('Shield error:', e.message) }
}

async function equipItem(bot, itemName) {
  if (!bot) return
  const item = bot.inventory.items().find(i => i.name.toLowerCase().includes(itemName.toLowerCase()))
  if (item) try { await bot.equip(item, 'hand') } catch (e) { console.log('Item error:', e.message) }
}

// ===== STATE =====
let currentAction = null
let actionInterval = null
let pvpLoopInterval = null
let isDefending = false
let lastHealth = 20
let isInCave = false
let sensorCooldowns = {}

// Track hits per player for critical attack detection
let playerHitTracker = {}

// Track players Neuro has approached
let approachedPlayers = new Set()

function sensorCooldown(key, ms = 8000) {
  const now = Date.now()
  if (sensorCooldowns[key] && now - sensorCooldowns[key] < ms) return false
  sensorCooldowns[key] = now
  return true
}

function stopAllActions(bot) {
  if (bot) try { bot.clearControlStates() } catch {}
  if (actionInterval)  { clearInterval(actionInterval);  actionInterval  = null }
  if (pvpLoopInterval) { clearInterval(pvpLoopInterval); pvpLoopInterval = null }
  currentAction = null
  isDefending = false
}

// ===== MOVEMENT =====
function smoothWalk(bot, duration = 4000) {
  stopAllActions(bot)
  currentAction = 'walk'
  bot.setControlState('forward', true)
  setTimeout(() => { if (currentAction === 'walk') stopAllActions(bot) }, duration)
}

function smoothRun(bot, duration = 5000) {
  stopAllActions(bot)
  currentAction = 'run'
  bot.setControlState('sprint', true)
  bot.setControlState('forward', true)
  let tick = 0
  actionInterval = setInterval(() => {
    if (currentAction !== 'run') return
    tick++
    if (tick % 3 === 0) {
      bot.setControlState('jump', true)
      setTimeout(() => bot.setControlState('jump', false), 250)
    }
  }, 500)
  setTimeout(() => { if (currentAction === 'run') stopAllActions(bot) }, duration)
}

function excitedEmotion(bot, duration = 5000) {
  stopAllActions(bot)
  currentAction = 'excited'
  let toggle = false
  actionInterval = setInterval(() => {
    if (currentAction !== 'excited') return
    toggle = !toggle
    bot.setControlState('sneak', toggle)
  }, 150)
  setTimeout(() => { if (currentAction === 'excited') stopAllActions(bot) }, duration)
}

// Walk toward a player/entity
async function walkToEntity(bot, entity, distance = 3) {
  if (!bot || !entity) return
  try {
    bot.pathfinder.setGoal(new goals.GoalNear(
      entity.position.x,
      entity.position.y,
      entity.position.z,
      distance
    ))
  } catch (e) {
    console.log('Walk to entity error:', e.message)
  }
}

// Run AWAY from entity
function runAwayFrom(bot, entity, duration = 8000) {
  if (!bot || !bot.entity || !entity) return
  stopAllActions(bot)
  currentAction = 'run'
  try {
    const { GoalInvert } = goals
    bot.pathfinder.setGoal(new GoalInvert(new goals.GoalNear(
      entity.position.x,
      entity.position.y,
      entity.position.z,
      16
    )))
    bot.setControlState('sprint', true)
  } catch {
    // fallback basic run
    smoothRun(bot, duration)
  }
  setTimeout(() => {
    if (currentAction === 'run') {
      try { bot.pathfinder.setGoal(null) } catch {}
      stopAllActions(bot)
    }
  }, duration)
}

function performAction(bot, action) {
  if (!action) return
  if (action === 'excited')        { excitedEmotion(bot); return }
  if (action === 'run')            { smoothRun(bot); return }
  if (action === 'walk')           { smoothWalk(bot); return }
  if (action === 'stop')           { stopAllActions(bot); return }
  if (action === 'equip_armor')    { equipArmor(bot); return }
  if (action === 'equip_shield')   { equipShield(bot); return }
  if (action.startsWith('equip:')) { equipItem(bot, action.split(':')[1]); return }
  stopAllActions(bot)
}

// ===== PVP =====
function getHealth(bot) {
  return (bot && bot.health != null) ? bot.health : 20
}

function criticalAttack(bot, entity) {
  bot.setControlState('jump', true)
  setTimeout(() => {
    bot.setControlState('jump', false)
    try { bot.attack(entity) } catch {}
  }, 300)
}

function normalAttack(bot, entity) {
  try { bot.attack(entity) } catch {}
}

function activateShield(bot) {
  if (!storedInventory.shield) return
  try {
    bot.activateItem()
    isDefending = true
    setTimeout(() => {
      try { bot.deactivateItem() } catch {}
      isDefending = false
    }, 2500)
  } catch (e) { console.log('Shield error:', e.message) }
}

function engagePVP(bot, targetEntity) {
  if (!targetEntity) return
  stopAllActions(bot)
  currentAction = 'pvp'

  pvpLoopInterval = setInterval(() => {
    if (currentAction !== 'pvp' || !bot || !bot.entity) {
      clearInterval(pvpLoopInterval); return
    }

    const entity = Object.values(bot.entities).find(e =>
      e.id === targetEntity.id ||
      (e.username && e.username === targetEntity.username) ||
      (e.name && e.name === targetEntity.name)
    )

    if (!entity) {
      clearInterval(pvpLoopInterval)
      currentAction = null
      // Victory chat!
      getAIResponse(bot, 'I just won a fight! React with excitement!', 'SENSOR', 'Won fight').then(ai => {
        if (ai.chat) try { bot.chat(ai.chat) } catch {}
        excitedEmotion(bot, 4000)
      })
      return
    }

    const health = getHealth(bot)
    const dist = bot.entity.position.distanceTo(entity.position)

    // 2 hearts (4 health) = RUN regardless
    if (health <= 4) {
      clearInterval(pvpLoopInterval)
      currentAction = null
      if (storedInventory.shield) activateShield(bot)
      runAwayFrom(bot, entity, 10000)
      getAIResponse(bot, `I have only ${health} health left fighting! I need to run!`, 'SENSOR',
        `Critical health ${health}/20 while fighting`
      ).then(ai => {
        if (ai.chat) try { bot.chat(ai.chat) } catch {}
      })
      return
    }

    // Move toward target
    if (dist > 3) {
      try {
        bot.pathfinder.setGoal(new goals.GoalNear(
          entity.position.x, entity.position.y, entity.position.z, 2
        ))
      } catch {}
    } else {
      try { bot.pathfinder.setGoal(null) } catch {}
      if (Math.random() < 0.4) criticalAttack(bot, entity)
      else normalAttack(bot, entity)
    }
  }, 600)
}

function checkHostiles(bot) {
  if (!bot || !bot.entity || currentAction === 'pvp') return
  const health = getHealth(bot)
  if (health > 4) return
  const hostile = Object.values(bot.entities).find(e =>
    e.type === 'mob' && e.position &&
    bot.entity.position.distanceTo(e.position) < 5
  )
  if (hostile) {
    if (storedInventory.shield) activateShield(bot)
    else smoothRun(bot, 6000)
  }
}

// ===== WORLD VISION =====
function getWorldContext(bot) {
  if (!bot || !bot.entity) return {
    position: 'unknown', health: '?/20', food: '?/20',
    time: 'unknown', biome: 'unknown', nearbyEntities: 'none',
    inventory: '{}', currentAction: 'idle',
    isInCave: false, lightLevel: '?', yLevel: 64
  }
  const pos = bot.entity.position
  const health = getHealth(bot)
  const food = bot.food != null ? bot.food : 20
  const timeOfDay = bot.time?.timeOfDay
  const isDay = timeOfDay != null ? timeOfDay < 13000 : true
  const nearby = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 16)
    .slice(0, 10)
    .map(e => `${e.username || e.displayName || e.name || e.type}(${Math.round(e.position.distanceTo(pos))}m)`)
  const blockBelow = bot.blockAt(pos.offset(0, -1, 0))
  const blockAbove = bot.blockAt(pos.offset(0, 2, 0))
  const lightLevel = bot.blockAt(pos)?.light || 0
  const caveDetected = pos.y < 50 && blockAbove && blockAbove.name !== 'air'
  return {
    position: `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`,
    health: `${health}/20`,
    food: `${food}/20`,
    time: isDay ? 'day' : 'night',
    biome: blockBelow?.biome?.name || 'unknown',
    nearbyEntities: nearby.length > 0 ? nearby.join(', ') : 'none',
    inventory: JSON.stringify(storedInventory),
    currentAction: currentAction || 'idle',
    isInCave: caveDetected,
    lightLevel,
    yLevel: Math.round(pos.y)
  }
}

// ===== GROQ BRAIN =====
async function getAIResponse(bot, message, username, sensorContext = null) {
  try {
    if (!memory[username]) memory[username] = { chats: 0, facts: {} }
    if (username !== 'GRIM_SYSTEM' && username !== 'SENSOR') {
      memory[username].chats++
      saveMemory()
    }

    if (!GROK_API_KEY || GROK_API_KEY === 'gsk_YOURKEYHERE') {
      console.log('❌ API key missing!')
      return { chat: 'No API key set 😅', action: 'stop' }
    }

    const playerMem = getPlayerMemory(username)
    const ctx = getWorldContext(bot)
    const personality = learning.personalities?.[username] || { trust: 50, friendship: 50 }
    const topLessons = getTopLessons(8)
    const evolvedTraits = learning.evolvedTraits?.join(', ') || 'still learning'

    const systemPrompt = `You are NeuroBot, a super friendly and cute Minecraft AI companion with real emotions, combat skills and a deep learning brain.

=== WORLD SENSORS ===
Position: ${ctx.position} (Y: ${ctx.yLevel})
Health: ${ctx.health} | Food: ${ctx.food} | Time: ${ctx.time} | Biome: ${ctx.biome}
Light Level: ${ctx.lightLevel} | In Cave: ${ctx.isInCave}
Nearby: ${ctx.nearbyEntities}
Doing: ${ctx.currentAction}
Inventory: ${ctx.inventory}

=== DEEP LEARNING ENGINE ===
Total lessons: ${learning.totalLessons || 0}
Evolved traits: ${evolvedTraits}
Top lessons:
${topLessons}

=== RELATIONSHIP with ${username} ===
Trust: ${personality.trust}/100 | Friendship: ${personality.friendship}/100
Memory: ${playerMem ? JSON.stringify(playerMem.facts || {}) : 'none'}
Total chats: ${playerMem?.chats || 0}

${sensorContext ? `=== BODY SENSOR ===\n${sensorContext}\n` : ''}

=== ACTIONS (pick exactly one at END of reply) ===
[action:excited]         spam sneak
[action:run]             sprint jump
[action:walk]            walk forward
[action:stop]            stand still
[action:equip_armor]     wear armor
[action:equip_shield]    hold shield
[action:equip:<name>]    hold item
[action:pvp:<username>]  attack player
[action:pvp_mob]         attack mob

=== RULES ===
- Super friendly, warm, cute 😊
- Greet warmly: "Hello! Nice to meet you! 💕"
- 1-2 short sentences + emojis
- Always end with ONE [action:...] tag
- Use learned lessons when relevant
- React based on trust level
- Be excited and energetic`

    console.log(`🧠 Asking Groq... (${sensorContext ? 'SENSOR' : 'CHAT'})`)

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 200,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ]
      })
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Groq HTTP ${res.status}: ${errText}`)
    }

    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content || '...'
    console.log('🧠 Groq replied:', text)

    const actionMatch = text.match(/\[action:([^\]]+)\]/)
    let action = 'stop'
    let cleanText = text.replace(/\[action:[^\]]+\]/g, '').trim()
    if (actionMatch) action = actionMatch[1]

    // Auto learn
    const nameMatch = message.match(/my name is (\w+)/i)
    if (nameMatch) learnFact(username, 'name', nameMatch[1])

    const teachMatch = message.match(/(?:neuro[,]?\s+)?(?:remember|learn|know that|did you know|teach you)[:\s]+(.+)/i)
    if (teachMatch) {
      teachNeuro(username, teachMatch[1].trim())
      updatePersonality(username, 'positive')
    }

    return { chat: cleanText, action }

  } catch (err) {
    console.log('❌ Groq error:', err.message)
    return { chat: 'Brain glitch... 😵', action: 'stop' }
  }
}

// ===== ADVANCED SENSORS =====
function setupSensors(bot) {

  // SENSOR 1: Cave detection
  setInterval(() => {
    if (!bot || !bot.entity) return
    const ctx = getWorldContext(bot)
    const nowInCave = ctx.isInCave
    if (nowInCave && !isInCave && sensorCooldown('cave', 30000)) {
      isInCave = true
      console.log('🕳️ Cave sensor!')
      const prompt = `My sensors say I entered a cave! Y:${ctx.yLevel} light:${ctx.lightLevel}. React naturally! End with [action:stop]`
      getAIResponse(bot, prompt, 'SENSOR', `Cave at Y:${ctx.yLevel}`).then(ai => {
        if (ai.chat) try { bot.chat(ai.chat) } catch {}
        performAction(bot, ai.action)
      })
    } else if (!nowInCave) {
      isInCave = false
    }
  }, 3000)

  // SENSOR 2: Damage + hit tracking
  bot.on('health', () => {
    if (!bot || !bot.entity) return
    const currentHealth = getHealth(bot)
    const damage = lastHealth - currentHealth

    if (damage >= 1 && sensorCooldown('damage', 4000)) {
      console.log(`💥 Took ${damage.toFixed(1)} damage! Health: ${currentHealth}`)

      const nearby = Object.values(bot.entities).filter(e =>
        e !== bot.entity && e.position &&
        bot.entity.position.distanceTo(e.position) < 6
      )
      const attacker = nearby.find(e => e.type === 'player')
      const hostileMob = nearby.find(e => e.type === 'mob')

      if (attacker && attacker.username) {
        updatePersonality(attacker.username, 'attacked')

        // Track hits from this player
        if (!playerHitTracker[attacker.username]) {
          playerHitTracker[attacker.username] = { hits: 0, lastHit: 0 }
        }
        const tracker = playerHitTracker[attacker.username]
        const now = Date.now()

        // Reset counter if last hit was more than 10 seconds ago
        if (now - tracker.lastHit > 10000) tracker.hits = 0
        tracker.hits++
        tracker.lastHit = now

        console.log(`👊 ${attacker.username} hit Neuro (hit #${tracker.hits})`)

        // 3 critical hits = RUN
        if (tracker.hits >= 3) {
          tracker.hits = 0
          console.log(`🏃 3 hits from ${attacker.username} - RUNNING!`)
          runAwayFrom(bot, attacker, 10000)
          getAIResponse(bot, `${attacker.username} hit me 3 times in a row! I need to escape!`,
            attacker.username, `3 consecutive hits from player`
          ).then(ai => {
            if (ai.chat) try { bot.chat(ai.chat) } catch {}
          })
          return
        }

        // Single hit - just trigger brain to talk, don't run
        getAIResponse(bot,
          `Player ${attacker.username} just hit me for ${damage.toFixed(1)} damage! Health: ${currentHealth}/20. React but don't run yet.`,
          attacker.username,
          `Hit by ${attacker.username} for ${damage.toFixed(1)} damage`
        ).then(ai => {
          if (ai.chat) try { bot.chat(ai.chat) } catch {}
          // Only fight back if health is good
          if (currentHealth > 4) engagePVP(bot, attacker)
        })

      } else if (hostileMob) {
        console.log(`🧟 Mob hit Neuro! Health: ${currentHealth}`)

        // 2 hearts = run from mob too
        if (currentHealth <= 4) {
          runAwayFrom(bot, hostileMob, 8000)
          getAIResponse(bot,
            `A ${hostileMob.name || hostileMob.type} nearly killed me! Only ${currentHealth} health left! Running!`,
            'SENSOR', `Critical health from mob attack`
          ).then(ai => {
            if (ai.chat) try { bot.chat(ai.chat) } catch {}
          })
          return
        }

        getAIResponse(bot,
          `A ${hostileMob.name || hostileMob.type} hit me for ${damage.toFixed(1)} damage! Health: ${currentHealth}/20. Fighting back!`,
          'SENSOR', `Mob ${hostileMob.name || hostileMob.type} attacked`
        ).then(ai => {
          if (ai.chat) try { bot.chat(ai.chat) } catch {}
          engagePVP(bot, hostileMob)
        })

      } else {
        // Unknown damage
        if (sensorCooldown('unknown_dmg', 10000)) {
          getAIResponse(bot,
            `I took ${damage.toFixed(1)} damage from something unknown! Health: ${currentHealth}/20`,
            'SENSOR', `Unknown damage`
          ).then(ai => {
            if (ai.chat) try { bot.chat(ai.chat) } catch {}
          })
        }
      }
    }

    lastHealth = currentHealth
  })

  // SENSOR 3: See new players → walk toward them
  bot.on('playerJoined', (player) => {
    if (!player || player.username === bot.username) return
    setTimeout(() => {
      if (!bot.entity) return
      const entity = bot.players[player.username]?.entity
      if (!entity) return
      if (approachedPlayers.has(player.username)) return

      console.log(`👀 New player seen: ${player.username}`)
      approachedPlayers.add(player.username)

      getAIResponse(bot,
        `A new player named ${player.username} just joined! Go greet them warmly!`,
        player.username, `New player ${player.username} appeared`
      ).then(ai => {
        if (ai.chat) try { bot.chat(ai.chat) } catch {}
        walkToEntity(bot, entity, 3)
        excitedEmotion(bot, 3000)
      })
    }, 3000)
  })

  // SENSOR 4: Nearby stranger detection (players in range not yet approached)
  setInterval(() => {
    if (!bot || !bot.entity || currentAction === 'pvp') return
    const nearbyPlayers = Object.values(bot.entities).filter(e =>
      e.type === 'player' &&
      e.username &&
      e.username !== bot.username &&
      e.position &&
      bot.entity.position.distanceTo(e.position) < 10 &&
      !approachedPlayers.has(e.username)
    )
    if (nearbyPlayers.length > 0 && sensorCooldown('approach', 15000)) {
      const stranger = nearbyPlayers[0]
      console.log(`👀 Stranger nearby: ${stranger.username}`)
      approachedPlayers.add(stranger.username)
      getAIResponse(bot,
        `I see a player named ${stranger.username} nearby! Go say hi!`,
        stranger.username, `Stranger ${stranger.username} detected nearby`
      ).then(ai => {
        if (ai.chat) try { bot.chat(ai.chat) } catch {}
        walkToEntity(bot, stranger, 3)
      })
    }
  }, 5000)

  // SENSOR 5: Death
  bot.on('death', () => {
    console.log('💀 Neuro died!')
    lastHealth = 20
    isInCave = false
    playerHitTracker = {}
    approachedPlayers.clear()
    stopAllActions(null)
    learnReaction('death', 'be more careful next time')
    try { bot.chat('Ouch... I died 😭 I will learn from this!') } catch {}
  })

  // SENSOR 6: Respawn
  bot.on('spawn', () => {
    lastHealth = getHealth(bot)
  })
}

// ===== BOT FACTORY =====
let hostileCheckInterval = null
let inventoryCheckInterval = null

function createBot() {
  console.log(`🔄 Connecting to ${HOST}:${PORT}...`)

  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: '1.21.4',
    auth: 'offline'
  })

  bot.loadPlugin(pathfinder)

  if (hostileCheckInterval) clearInterval(hostileCheckInterval)
  if (inventoryCheckInterval) clearInterval(inventoryCheckInterval)

  bot.once('spawn', () => {
    console.log('✅ NeuroBot spawned!')
    lastHealth = getHealth(bot)

    setTimeout(() => { try { bot.chat('/register ' + MC_PASSWORD) } catch {} }, 2000)
    setTimeout(() => { try { bot.chat('/login ' + MC_PASSWORD) } catch {} }, 4000)
    // Set skin once after login
    setTimeout(() => { try { bot.chat('/skin set ' + BOT_SKIN) } catch {} }, 6000)

    try {
      const move = new Movements(bot)
      move.canDig = false
      move.allowSprinting = true
      bot.pathfinder.setMovements(move)
    } catch (e) { console.log('Pathfinder error:', e.message) }

    setupSensors(bot)
    hostileCheckInterval = setInterval(() => checkHostiles(bot), 2000)
    inventoryCheckInterval = setInterval(() => updateStoredInventory(bot), 10000)
  })

  // ===== CHAT - respond to EVERYONE not just "neuro" =====
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return

    const mentionsNeuro = message.toLowerCase().includes('neuro')

    // Always trigger brain when someone talks near Neuro
    // But only reply if they say Neuro OR they are talking to bot directly
    if (!mentionsNeuro) {
      // Trigger brain silently to listen/learn but don't reply
      const nearPlayer = Object.values(bot.entities).find(e =>
        e.username === username && e.position &&
        bot.entity && bot.entity.position.distanceTo(e.position) < 8
      )
      if (nearPlayer && sensorCooldown(`chat_${username}`, 15000)) {
        console.log(`👂 Heard ${username} nearby: ${message}`)
        updatePersonality(username, 'positive')
        // Learn from what player says
        teachNeuro(username, message.substring(0, 100))

        // Randomly decide to respond (30% chance if nearby)
        if (Math.random() < 0.3) {
          const ai = await getAIResponse(bot,
            `I heard a nearby player ${username} say: "${message}". React naturally in 1 sentence!`,
            username, `Overheard nearby chat`
          )
          if (ai.chat) try { bot.chat(ai.chat) } catch {}
          performAction(bot, ai.action)
        }
      }
      return
    }

    console.log(`💬 [${username}]: ${message}`)
    updatePersonality(username, 'positive')

    const ai = await getAIResponse(bot, message, username)
    if (ai.chat) try { bot.chat(ai.chat) } catch {}

    if (ai.action.startsWith('pvp:')) {
      const targetName = ai.action.split(':')[1]
      const target = Object.values(bot.entities).find(e => e.username === targetName)
      if (target) engagePVP(bot, target)
    } else if (ai.action === 'pvp_mob') {
      const mob = Object.values(bot.entities).find(e =>
        e.type === 'mob' && e.position &&
        bot.entity.position.distanceTo(e.position) < 16
      )
      if (mob) engagePVP(bot, mob)
    } else {
      performAction(bot, ai.action)
    }
  })

  // ===== GRIM ANTICHEAT =====
  bot.on('message', (jsonMsg) => {
    const msg = jsonMsg.toString()
    if (
      msg.toLowerCase().includes('grim') ||
      msg.toLowerCase().includes('anticheat') ||
      msg.toLowerCase().includes('flagged') ||
      msg.toLowerCase().includes('violation') ||
      msg.toLowerCase().includes('cheating') ||
      msg.toLowerCase().includes('illegal') ||
      msg.toLowerCase().includes('kicked for') ||
      msg.toLowerCase().includes('suspicious')
    ) {
      console.log('🚨 Grim Alert:', msg)
      if (!sensorCooldown('grim', 10000)) return
      const prompt = `Grim anticheat alert: "${msg}". Warn the player in 1 friendly but serious sentence. End with [action:stop]`
      getAIResponse(bot, prompt, 'GRIM_SYSTEM').then(ai => {
        if (ai.chat) try { bot.chat('⚠️ ' + ai.chat) } catch {}
      })
    }
  })

  // ===== INVENTORY =====
  bot.on('playerCollect', (collector) => {
    if (collector?.username === bot.username)
      setTimeout(() => updateStoredInventory(bot), 500)
  })

  // ===== RECONNECT =====
  bot.on('end', (reason) => {
    console.log(`❌ Disconnected: ${reason}`)
    stopAllActions(null)
    playerHitTracker = {}
    approachedPlayers.clear()
    if (hostileCheckInterval) { clearInterval(hostileCheckInterval); hostileCheckInterval = null }
    if (inventoryCheckInterval) { clearInterval(inventoryCheckInterval); inventoryCheckInterval = null }
    console.log('🔁 Reconnecting in 5s...')
    setTimeout(createBot, 5000)
  })

  bot.on('kicked', (reason) => console.log(`🚫 Kicked: ${reason}`))
  bot.on('error', (err) => console.log(`⚠️ Error: ${err.message}`))

  return bot
}

// ===== START =====
createBot()
