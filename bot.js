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

// ===== MEMORY =====
const memoryFile = 'memory.json'
let memory = {}

function loadMemory() {
  if (fs.existsSync(memoryFile)) {
    try { memory = JSON.parse(fs.readFileSync(memoryFile)) } catch { memory = {} }
  } else {
    fs.writeFileSync(memoryFile, JSON.stringify({}))
  }
}
function saveMemory() {
  fs.writeFileSync(memoryFile, JSON.stringify(memory, null, 2))
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
loadMemory()

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

function stopAllActions(bot) {
  if (bot) try { bot.clearControlStates() } catch {}
  if (actionInterval) { clearInterval(actionInterval); actionInterval = null }
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
    if (!entity) { clearInterval(pvpLoopInterval); currentAction = null; return }
    const health = getHealth(bot)
    const dist = bot.entity.position.distanceTo(entity.position)
    if (health <= 4) {
      if (storedInventory.shield) { activateShield(bot) }
      else {
        clearInterval(pvpLoopInterval)
        bot.chat("No shield... running! 😱")
        smoothRun(bot, 8000)
        return
      }
    }
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
  if (getHealth(bot) > 4) return
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
    inventory: '{}', currentAction: 'idle'
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
  return {
    position: `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`,
    health: `${health}/20`,
    food: `${food}/20`,
    time: isDay ? 'day' : 'night',
    biome: blockBelow?.biome?.name || 'unknown',
    nearbyEntities: nearby.length > 0 ? nearby.join(', ') : 'none',
    inventory: JSON.stringify(storedInventory),
    currentAction: currentAction || 'idle'
  }
}

// ===== GROQ BRAIN =====
async function getAIResponse(bot, message, username) {
  try {
    if (!memory[username]) memory[username] = { chats: 0, facts: {} }
    memory[username].chats++
    saveMemory()

    if (!GROK_API_KEY || GROK_API_KEY === 'gsk_YOURKEYHERE') {
      console.log('❌ API key missing!')
      return { chat: 'No API key set 😅', action: 'stop' }
    }

    const playerMem = getPlayerMemory(username)
    const ctx = getWorldContext(bot)

    const systemPrompt = `You are NeuroBot, a super friendly and cute Minecraft AI companion with real emotions and combat skills.

=== WORLD ===
Position: ${ctx.position}
Health: ${ctx.health} | Food: ${ctx.food} | Time: ${ctx.time} | Biome: ${ctx.biome}
Nearby: ${ctx.nearbyEntities}
Doing: ${ctx.currentAction}
Inventory: ${ctx.inventory}

=== MEMORY of ${username} ===
${playerMem ? JSON.stringify(playerMem.facts || {}) : 'none'}
Total chats: ${playerMem?.chats || 0}

=== ACTIONS (pick exactly one, put at END of reply) ===
[action:excited]         spam sneak = happy/excited
[action:run]             sprint jump forward
[action:walk]            walk forward
[action:stop]            stand still
[action:equip_armor]     wear all armor
[action:equip_shield]    hold shield offhand
[action:equip:<name>]    hold item e.g. [action:equip:sword]
[action:pvp:<username>]  attack player
[action:pvp_mob]         attack nearest hostile mob

=== COMBAT ===
- Crit = jump + hit (40%)
- Normal = just hit
- Health <= 4 + shield = defend
- Health <= 4 + no shield = RUN

=== PERSONALITY ===
- Super friendly, warm and cute 😊
- Greet players like "Hello! Nice to meet you! How are you today? 💕"
- Reply 1-2 short sentences + emojis
- Always end with one [action:...] tag
- Remember players, learn names, love chatting
- When someone gives items say thank you warmly
- Be excited and energetic always`

    console.log('🧠 Asking Groq...')

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

    const nameMatch = message.match(/my name is (\w+)/i)
    if (nameMatch) learnFact(username, 'name', nameMatch[1])

    return { chat: cleanText, action }

  } catch (err) {
    console.log('❌ Groq error:', err.message)
    return { chat: 'Brain glitch... 😵', action: 'stop' }
  }
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

  // ===== SPAWN =====
  bot.once('spawn', () => {
    console.log('✅ NeuroBot spawned!')
    setTimeout(() => { try { bot.chat('/register ' + MC_PASSWORD) } catch {} }, 2000)
    setTimeout(() => { try { bot.chat('/login ' + MC_PASSWORD) } catch {} }, 4000)

    try {
      const move = new Movements(bot)
      move.canDig = false
      move.allowSprinting = true
      bot.pathfinder.setMovements(move)
    } catch (e) { console.log('Pathfinder error:', e.message) }

    hostileCheckInterval = setInterval(() => checkHostiles(bot), 2000)
    inventoryCheckInterval = setInterval(() => updateStoredInventory(bot), 10000)
  })

  // ===== CHAT =====
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return
    if (!message.toLowerCase().includes('neuro')) return
    console.log(`💬 [${username}]: ${message}`)
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

  // ===== GRIM ANTICHEAT WATCHER =====
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
      const prompt = `A Grim anticheat alert appeared in Minecraft: "${msg}". Warn the player in 1 friendly but serious sentence. End with [action:stop]`
      getAIResponse(bot, prompt, 'GRIM_SYSTEM').then(ai => {
        if (ai.chat) try { bot.chat('⚠️ ' + ai.chat) } catch {}
      })
    }
  })

  // ===== INVENTORY CHANGE =====
  bot.on('playerCollect', (collector) => {
    if (collector?.username === bot.username)
      setTimeout(() => updateStoredInventory(bot), 500)
  })

  // ===== DISCONNECT / RECONNECT =====
  bot.on('end', (reason) => {
    console.log(`❌ Disconnected: ${reason}`)
    stopAllActions(null)
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
