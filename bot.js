try { require('dotenv').config() } catch {}

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear, GoalInvert } = goals
const fs = require('fs')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ===== CONFIG =====
const HOST         = process.env.MC_HOST       || 'localhost'
const PORT         = parseInt(process.env.MC_PORT) || 25565
const USERNAME     = process.env.MC_USERNAME   || 'NeuroBotAI'
const GROK_API_KEY = process.env.GROK_API_KEY  || ''
const MC_PASSWORD  = process.env.MC_PASSWORD   || 'nodejs'
const MC_VERSION   = process.env.MC_VERSION    || '1.21.4'
const BOT_SKIN     = process.env.BOT_SKIN      || 'TomiiStorm_'

if (!GROK_API_KEY) {
  console.log('❌ No API key! Run: export GROK_API_KEY=gsk_yourkey')
  process.exit(1)
}

// ===== MEMORY =====
const memoryFile   = 'memory.json'
const learningFile = 'learning.json'
let memory = {}
let learning = {
  lessons: [], reactions: {}, personalities: {},
  evolvedTraits: [], totalLessons: 0
}

function loadMemory() {
  if (fs.existsSync(memoryFile)) {
    try { memory = JSON.parse(fs.readFileSync(memoryFile)) } catch { memory = {} }
  } else { fs.writeFileSync(memoryFile, JSON.stringify({})) }
}

function loadLearning() {
  if (fs.existsSync(learningFile)) {
    try { learning = JSON.parse(fs.readFileSync(learningFile)) } catch {}
  } else { fs.writeFileSync(learningFile, JSON.stringify(learning, null, 2)) }
}

function saveMemory() { fs.writeFileSync(memoryFile, JSON.stringify(memory, null, 2)) }
function saveLearning() { fs.writeFileSync(learningFile, JSON.stringify(learning, null, 2)) }

function learnFact(username, key, value) {
  if (!memory[username]) memory[username] = { chats: 0, facts: {} }
  if (!memory[username].facts) memory[username].facts = {}
  memory[username].facts[key] = value
  saveMemory()
}

function getPlayerMemory(username) { return memory[username] || null }

function teachNeuro(username, lesson) {
  if (!learning.lessons) learning.lessons = []
  const exists = learning.lessons.find(l => l.lesson === lesson)
  if (!exists) {
    learning.lessons.push({ from: username, lesson, timestamp: new Date().toISOString(), reinforced: 1 })
  } else { exists.reinforced = (exists.reinforced || 1) + 1 }
  learning.totalLessons = (learning.totalLessons || 0) + 1
  if (learning.lessons.length > 200) learning.lessons = learning.lessons.slice(-200)
  if (learning.totalLessons === 10)  learning.evolvedTraits.push('quick learner')
  if (learning.totalLessons === 50)  learning.evolvedTraits.push('experienced companion')
  if (learning.totalLessons === 100) learning.evolvedTraits.push('wise veteran')
  saveLearning()
}

function learnReaction(event, reaction) {
  if (!learning.reactions) learning.reactions = {}
  learning.reactions[event] = reaction
  saveLearning()
}

function updatePersonality(username, sentiment) {
  if (!learning.personalities) learning.personalities = {}
  if (!learning.personalities[username])
    learning.personalities[username] = { trust: 50, friendship: 50, interactions: 0 }
  const p = learning.personalities[username]
  p.interactions++
  if (sentiment === 'positive') { p.trust = Math.min(100, p.trust + 5);  p.friendship = Math.min(100, p.friendship + 5) }
  if (sentiment === 'negative') { p.trust = Math.max(0, p.trust - 10);   p.friendship = Math.max(0, p.friendship - 10) }
  if (sentiment === 'attacked') { p.trust = Math.max(0, p.trust - 20) }
  saveLearning()
}

function getTopLessons(count = 5) {
  if (!learning.lessons || learning.lessons.length === 0) return 'none'
  return learning.lessons
    .sort((a, b) => (b.reinforced || 1) - (a.reinforced || 1))
    .slice(0, count)
    .map(l => `"${l.lesson}"(${l.from})`)
    .join(', ')
}

loadMemory()
loadLearning()

// ===== PVP COACH STATE =====
let pvpCoachSessions  = {}
let playerStateTracker = {}

function getPvpSession(username) {
  if (!pvpCoachSessions[username])
    pvpCoachSessions[username] = { active: false, step: 0, waitingForPlayer: false }
  return pvpCoachSessions[username]
}

function cleanupCoachState() {
  pvpCoachSessions   = {}
  playerStateTracker = {}
}

// ===== INVENTORY =====
let storedInventory   = { armor: {}, items: [], shield: null }
let lastInventoryHash = ''

function updateStoredInventory(bot) {
  if (!bot || !bot.inventory) return
  try {
    const inv      = bot.inventory.items()
    const newItems = inv.map(i => ({ name: i.name, count: i.count, slot: i.slot }))
    const armorSlotMap = { 5: 'helmet', 6: 'chestplate', 7: 'leggings', 8: 'boots' }
    const newArmor = {}
    for (const [slot, name] of Object.entries(armorSlotMap)) {
      const item = bot.inventory.slots[parseInt(slot)]
      if (item) newArmor[name] = item.name
    }
    const offhand   = bot.inventory.slots[45]
    const newShield = offhand ? offhand.name : null
    const newHash   = JSON.stringify({ newItems, newArmor, newShield })
    if (newHash === lastInventoryHash) return
    lastInventoryHash      = newHash
    storedInventory.items  = newItems
    storedInventory.armor  = newArmor
    storedInventory.shield = newShield
    console.log('📦 Inventory:', JSON.stringify(storedInventory))
  } catch (err) { console.log('Inventory error:', err.message) }
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
    if (item) try { await bot.equip(item, dest) } catch {}
  }
}

async function equipShield(bot) {
  if (!bot) return
  const shield = bot.inventory.items().find(i => i.name.includes('shield'))
  if (shield) try { await bot.equip(shield, 'off-hand') } catch {}
}

async function equipItem(bot, itemName) {
  if (!bot) return
  const item = bot.inventory.items().find(i => i.name.toLowerCase().includes(itemName.toLowerCase()))
  if (item) try { await bot.equip(item, 'hand') } catch {}
}

// ===== STATE =====
let currentAction    = null
let actionInterval   = null
let pvpLoopInterval  = null
let isDefending      = false
let lastHealth       = 20
let isInCave         = false
let sensorCooldowns  = {}
let playerHitTracker = {}
let approachedPlayers = new Set()
let sensorIntervals  = []
let botInstance      = null

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
  isDefending   = false
}

function clearSensorIntervals() {
  sensorIntervals.forEach(id => clearInterval(id))
  sensorIntervals = []
}

// ===== KNOCKBACK FIX =====
// When hit, bot stumbles backward naturally
function applyKnockback(bot, attackerEntity) {
  if (!bot || !bot.entity || !attackerEntity) return
  try {
    // Face away from attacker and stumble back
    const dx = bot.entity.position.x - attackerEntity.position.x
    const dz = bot.entity.position.z - attackerEntity.position.z
    const angle = Math.atan2(dz, dx)

    // Move backward briefly to simulate knockback
    bot.setControlState('back', true)
    setTimeout(() => {
      try { bot.setControlState('back', false) } catch {}
    }, 300)
  } catch (e) { console.log('Knockback error:', e.message) }
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

function excitedEmotion(bot, duration = 4000) {
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

async function walkToEntity(bot, entity, distance = 3) {
  if (!bot || !entity || !entity.position) return
  try {
    bot.pathfinder.setGoal(new GoalNear(
      entity.position.x, entity.position.y, entity.position.z, distance
    ))
  } catch (e) { console.log('Walk error:', e.message) }
}

function runAwayFrom(bot, entity, duration = 8000) {
  if (!bot || !bot.entity || !entity || !entity.position) return
  stopAllActions(bot)
  currentAction = 'run'
  try {
    bot.pathfinder.setGoal(new GoalInvert(new GoalNear(
      entity.position.x, entity.position.y, entity.position.z, 20
    )))
    bot.setControlState('sprint', true)
  } catch { smoothRun(bot, duration) }
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

// ===== PVP DEMOS =====
async function demoCriticalHit(bot) {
  for (let i = 0; i < 2; i++) {
    bot.setControlState('jump', true)
    await sleep(400)
    bot.setControlState('jump', false)
    await sleep(300)
  }
}

async function demoStrafe(bot) {
  bot.setControlState('forward', true)
  bot.setControlState('sprint', true)
  await sleep(500)
  bot.setControlState('left', true)
  await sleep(400)
  bot.setControlState('left', false)
  bot.setControlState('right', true)
  await sleep(400)
  bot.setControlState('right', false)
  bot.setControlState('forward', false)
  bot.setControlState('sprint', false)
}

async function demoWTap(bot) {
  for (let i = 0; i < 4; i++) {
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    await sleep(300)
    bot.setControlState('forward', false)
    await sleep(150)
  }
  bot.clearControlStates()
}

async function demoJumpSprint(bot) {
  for (let i = 0; i < 3; i++) {
    bot.setControlState('sprint', true)
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    await sleep(300)
    bot.setControlState('jump', false)
    await sleep(200)
    bot.setControlState('forward', false)
    await sleep(200)
    bot.setControlState('forward', true)
    await sleep(300)
  }
  bot.clearControlStates()
}

async function demoShieldBlock(bot) {
  if (storedInventory.shield) {
    try { bot.activateItem() } catch {}
    await sleep(2000)
    try { bot.deactivateItem() } catch {}
  }
}

async function handleDemoAction(bot, action, username) {
  if (action === 'demo_crit')    { await demoCriticalHit(bot); return }
  if (action === 'demo_strafe')  {
    const e = username ? Object.values(bot.entities).find(x => x.username === username) : null
    if (e) await walkToEntity(bot, e, 4)
    await sleep(800)
    await demoStrafe(bot)
    return
  }
  if (action === 'demo_wtap')    { await demoWTap(bot);        return }
  if (action === 'demo_sprint')  { await demoJumpSprint(bot);  return }
  if (action === 'demo_shield')  { await demoShieldBlock(bot); return }
  if (action.startsWith('goto:')) {
    const t = Object.values(bot.entities).find(e => e.username === action.split(':')[1])
    if (t) await walkToEntity(bot, t, 3)
    return
  }
  performAction(bot, action)
}

// ===== OBSERVE PLAYER =====
function observePlayer(bot, username) {
  const player = Object.values(bot.entities).find(e =>
    e.type === 'player' && e.username === username
  )
  if (!player || !player.position) return null
  const vel         = player.velocity || { x: 0, y: 0, z: 0 }
  const horizSpeed  = Math.sqrt(vel.x * vel.x + vel.z * vel.z)
  const isSprinting = horizSpeed > 0.18
  const isJumping   = vel.y > 0.1
  const isFalling   = vel.y < -0.1
  const isMoving    = horizSpeed > 0.05
  let isSneaking    = false
  try {
    if (player.metadata && Array.isArray(player.metadata))
      isSneaking = player.metadata[6] === 5
  } catch {}
  const heldItem = player.heldItem ? player.heldItem.name : 'nothing'
  const distance = bot.entity ? bot.entity.position.distanceTo(player.position) : 0
  const moves = []
  if (isSneaking)                moves.push('sneaking')
  if (isSprinting && !isJumping) moves.push('sprinting')
  if (isJumping)                 moves.push('jumping')
  if (isSprinting && isJumping)  moves.push('sprint-jumping')
  if (isFalling && isSprinting)  moves.push('potential crit!')
  if (!isMoving)                 moves.push('standing still')
  if (heldItem !== 'nothing')    moves.push(`holding ${heldItem}`)
  return { isSneaking, isSprinting, isJumping, isFalling, isMoving, heldItem, distance, detectedMoves: moves.length > 0 ? moves : ['idle'] }
}

// ===== PVP =====
function getHealth(bot) { return (bot && bot.health != null) ? bot.health : 20 }

function criticalAttack(bot, entity) {
  bot.setControlState('jump', true)
  setTimeout(() => {
    bot.setControlState('jump', false)
    try { bot.attack(entity) } catch {}
  }, 300)
}

function normalAttack(bot, entity) { try { bot.attack(entity) } catch {} }

function activateShield(bot) {
  if (!storedInventory.shield) return
  try {
    bot.activateItem()
    isDefending = true
    setTimeout(() => {
      try { bot.deactivateItem() } catch {}
      isDefending = false
    }, 2500)
  } catch {}
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
      getAIResponse(bot, 'I just won the fight!', 'SENSOR').then(async ai => {
        if (ai.reply) try { bot.chat(ai.reply) } catch {}
        excitedEmotion(bot, 4000)
      })
      return
    }
    const health = getHealth(bot)
    const dist   = bot.entity.position.distanceTo(entity.position)
    if (health <= 4) {
      clearInterval(pvpLoopInterval)
      currentAction = null
      if (storedInventory.shield) activateShield(bot)
      runAwayFrom(bot, entity, 10000)
      getAIResponse(bot, `Only ${health} health! Running!`, 'SENSOR').then(async ai => {
        if (ai.reply) try { bot.chat(ai.reply) } catch {}
      })
      return
    }
    if (dist > 3) {
      try { bot.pathfinder.setGoal(new GoalNear(entity.position.x, entity.position.y, entity.position.z, 2)) } catch {}
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
    position: 'unknown', health: '?/20', food: '?/20', time: 'unknown',
    biome: 'unknown', nearbyEntities: 'none', inventory: '{}',
    currentAction: 'idle', isInCave: false, lightLevel: '?', yLevel: 64
  }
  const pos       = bot.entity.position
  const health    = getHealth(bot)
  const food      = bot.food != null ? bot.food : 20
  const timeOfDay = bot.time?.timeOfDay
  const isDay     = timeOfDay != null ? timeOfDay < 13000 : true
  const nearby    = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 16)
    .slice(0, 8)
    .map(e => `${e.username || e.name || e.type}(${Math.round(e.position.distanceTo(pos))}m)`)
  const blockBelow   = bot.blockAt(pos.offset(0, -1, 0))
  const blockAbove   = bot.blockAt(pos.offset(0, 2, 0))
  const lightLevel   = bot.blockAt(pos)?.light || 0
  const caveDetected = pos.y < 50 && blockAbove && blockAbove.name !== 'air'
  return {
    position:       `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`,
    health:         `${health}/20`,
    food:           `${food}/20`,
    time:           isDay ? 'day' : 'night',
    biome:          blockBelow?.biome?.name || 'unknown',
    nearbyEntities: nearby.length > 0 ? nearby.join(', ') : 'none',
    inventory:      JSON.stringify(storedInventory),
    currentAction:  currentAction || 'idle',
    isInCave:       caveDetected,
    lightLevel,
    yLevel:         Math.round(pos.y)
  }
}

// ===== SEND ONE MESSAGE (90 char limit) =====
function sendChat(bot, text) {
  if (!bot || !text) return
  try {
    // Trim to 90 chars — Minecraft chat limit safe zone
    bot.chat(text.substring(0, 90))
  } catch (e) { console.log('Chat error:', e.message) }
}

// ===== GROQ BRAIN — returns ONE reply =====
async function getAIResponse(bot, message, username, sensorContext = null, observationContext = null) {
  try {
    if (!memory[username]) memory[username] = { chats: 0, facts: {} }
    if (username !== 'GRIM_SYSTEM' && username !== 'SENSOR') {
      memory[username].chats++
      saveMemory()
    }

    const playerMem     = getPlayerMemory(username)
    const ctx           = getWorldContext(bot)
    const personality   = learning.personalities?.[username] || { trust: 50, friendship: 50 }
    const topLessons    = getTopLessons(5)
    const evolvedTraits = learning.evolvedTraits?.join(', ') || 'learning'
    const pvpSession    = getPvpSession(username)

    const systemPrompt = `You are NeuroBot - witty Minecraft AI and legendary PVP coach.
You control your own body in Minecraft.

WORLD: pos=${ctx.position} hp=${ctx.health} food=${ctx.food} time=${ctx.time} biome=${ctx.biome} cave=${ctx.isInCave} nearby=${ctx.nearbyEntities} doing=${ctx.currentAction}
INVENTORY: ${ctx.inventory}
PLAYER ${username}: trust=${personality.trust} friendship=${personality.friendship} chats=${playerMem?.chats || 0}
LESSONS: ${topLessons}
TRAITS: ${evolvedTraits}
PVP SESSION: active=${pvpSession.active} step=${pvpSession.step}
${sensorContext      ? `SENSOR: ${sensorContext}`      : ''}
${observationContext ? `OBSERVING: ${observationContext}` : ''}

ACTIONS (put ONE at end):
[action:excited] [action:run] [action:walk] [action:stop]
[action:equip_armor] [action:equip_shield] [action:equip:<name>]
[action:pvp:<username>] [action:pvp_mob]
[action:demo_crit] [action:demo_strafe] [action:demo_wtap] [action:demo_sprint] [action:demo_shield]
[action:goto:<username>]

PVP KNOWLEDGE: crit=jump+fall+hit, wtap=reset sprint, strafe=sideways dodge, shield=block all, cooldown=1s between hits

RULES:
- Reply in ONE short sentence max 80 chars
- 10% jokes naturally
- Witty smart energetic never boring
- React to what you see and sense
- Short snappy replies only`

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 80,
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

    const data   = await res.json()
    const text   = data?.choices?.[0]?.message?.content || '...'
    console.log('🧠 Groq:', text)

    const actionMatch = text.match(/\[action:([^\]]+)\]/)
    let action  = 'stop'
    let reply   = text.replace(/\[action:[^\]]+\]/g, '').trim()
    if (actionMatch) action = actionMatch[1]

    // Trim reply hard to 90 chars
    reply = reply.substring(0, 90)

    // Auto learn
    const nameMatch = message.match(/my name is (\w+)/i)
    if (nameMatch) learnFact(username, 'name', nameMatch[1])
    const teachMatch = message.match(/(?:neuro[,]?\s+)?(?:remember|learn|know that)[:\s]+(.+)/i)
    if (teachMatch) {
      teachNeuro(username, teachMatch[1].trim())
      updatePersonality(username, 'positive')
    }

    return { reply, action }

  } catch (err) {
    console.log('❌ Groq error:', err.message)
    return { reply: 'brain glitch 😵', action: 'stop' }
  }
}

// ===== SENSORS =====
function setupSensors(bot) {

  // SENSOR 1: Cave
  sensorIntervals.push(setInterval(() => {
    if (!bot || !bot.entity) return
    const ctx = getWorldContext(bot)
    if (ctx.isInCave && !isInCave && sensorCooldown('cave', 30000)) {
      isInCave = true
      getAIResponse(bot, `I just entered a cave Y:${ctx.yLevel} light:${ctx.lightLevel}!`, 'SENSOR',
        `Cave Y:${ctx.yLevel}`
      ).then(ai => { if (ai.reply) sendChat(bot, ai.reply); performAction(bot, ai.action) })
    } else if (!ctx.isInCave) { isInCave = false }
  }, 3000))

  // SENSOR 2: Damage + knockback
  bot.on('health', () => {
    if (!bot || !bot.entity) return
    const currentHealth = getHealth(bot)
    const damage = lastHealth - currentHealth

    if (damage >= 1 && sensorCooldown('damage', 3000)) {
      console.log(`💥 ${damage.toFixed(1)} dmg HP:${currentHealth}`)
      const nearby = Object.values(bot.entities).filter(e =>
        e !== bot.entity && e.position && bot.entity.position.distanceTo(e.position) < 6
      )
      const attacker   = nearby.find(e => e.type === 'player')
      const hostileMob = nearby.find(e => e.type === 'mob')

      if (attacker && attacker.username) {
        // KNOCKBACK FIX: apply knockback reaction
        applyKnockback(bot, attacker)
        updatePersonality(attacker.username, 'attacked')
        if (!playerHitTracker[attacker.username])
          playerHitTracker[attacker.username] = { hits: 0, lastHit: 0 }
        const tracker = playerHitTracker[attacker.username]
        const now = Date.now()
        if (now - tracker.lastHit > 10000) tracker.hits = 0
        tracker.hits++
        tracker.lastHit = now
        if (tracker.hits >= 3) {
          tracker.hits = 0
          runAwayFrom(bot, attacker, 10000)
          getAIResponse(bot, `${attacker.username} hit me 3 times running!`, attacker.username,
            `3 hits from player`
          ).then(ai => { if (ai.reply) sendChat(bot, ai.reply) })
          return
        }
        // Single hit - react but dont run
        getAIResponse(bot,
          `${attacker.username} hit me ${damage.toFixed(1)} dmg! HP:${currentHealth}/20`,
          attacker.username, `Hit by player`
        ).then(ai => {
          if (ai.reply) sendChat(bot, ai.reply)
          if (currentHealth > 4) engagePVP(bot, attacker)
        })

      } else if (hostileMob) {
        // KNOCKBACK FIX: apply knockback from mob too
        applyKnockback(bot, hostileMob)
        if (currentHealth <= 4) {
          runAwayFrom(bot, hostileMob, 8000)
          getAIResponse(bot, `Critical health ${currentHealth}! Running from mob!`, 'SENSOR', `Crit mob`
          ).then(ai => { if (ai.reply) sendChat(bot, ai.reply) })
          return
        }
        getAIResponse(bot,
          `${hostileMob.name || hostileMob.type} hit me ${damage.toFixed(1)} dmg!`,
          'SENSOR', `Mob hit`
        ).then(ai => {
          if (ai.reply) sendChat(bot, ai.reply)
          engagePVP(bot, hostileMob)
        })
      } else if (sensorCooldown('unknown_dmg', 10000)) {
        getAIResponse(bot, `Took ${damage.toFixed(1)} unknown damage HP:${currentHealth}`,
          'SENSOR'
        ).then(ai => { if (ai.reply) sendChat(bot, ai.reply) })
      }
    }
    lastHealth = currentHealth
  })

  // SENSOR 3: New player joins
  bot.on('playerJoined', (player) => {
    if (!player || player.username === bot.username) return
    setTimeout(() => {
      if (!bot || !bot.entity) return
      const entity = bot.players[player.username]?.entity
      if (!entity || approachedPlayers.has(player.username)) return
      approachedPlayers.add(player.username)
      getAIResponse(bot, `${player.username} just joined! Greet them!`,
        player.username, `New player`
      ).then(ai => {
        if (ai.reply) sendChat(bot, ai.reply)
        walkToEntity(bot, entity, 3)
        excitedEmotion(bot, 2000)
      })
    }, 5000)
  })

  // SENSOR 4: Nearby strangers
  sensorIntervals.push(setInterval(() => {
    if (!bot || !bot.entity || currentAction === 'pvp') return
    const strangers = Object.values(bot.entities).filter(e =>
      e.type === 'player' && e.username && e.username !== bot.username &&
      e.position && bot.entity.position.distanceTo(e.position) < 10 &&
      !approachedPlayers.has(e.username)
    )
    if (strangers.length > 0 && sensorCooldown('approach', 60000)) {
      const stranger = strangers[0]
      approachedPlayers.add(stranger.username)
      getAIResponse(bot, `I see ${stranger.username} nearby! Say hi!`,
        stranger.username, `Stranger nearby`
      ).then(ai => {
        if (ai.reply) sendChat(bot, ai.reply)
        walkToEntity(bot, stranger, 3)
      })
    }
  }, 5000))

  // SENSOR 5: Observe player for coaching
  sensorIntervals.push(setInterval(() => {
    if (!bot || !bot.entity) return
    Object.keys(pvpCoachSessions).forEach(username => {
      const session = pvpCoachSessions[username]
      if (!session || !session.waitingForPlayer) return
      const obs = observePlayer(bot, username)
      if (!obs || obs.detectedMoves[0] === 'idle') return
      const obsKey = obs.detectedMoves.join(',')
      if (playerStateTracker[username] === obsKey) return
      playerStateTracker[username] = obsKey
      if (sensorCooldown(`obs_${username}`, 4000)) {
        const obsCtx = `${username}: ${obs.detectedMoves.join(', ')} dist:${obs.distance.toFixed(1)}m holding:${obs.heldItem}`
        getAIResponse(bot,
          `I see ${username} doing: ${obs.detectedMoves.join(', ')}. Coach comment!`,
          username, null, obsCtx
        ).then(ai => {
          if (ai.reply) sendChat(bot, ai.reply)
          performAction(bot, ai.action)
        })
      }
    })
  }, 1000))

  // SENSOR 6: Death
  bot.on('death', () => {
    console.log('💀 Neuro died!')
    lastHealth = 20; isInCave = false
    playerHitTracker = {}; approachedPlayers.clear()
    cleanupCoachState(); stopAllActions(null)
    learnReaction('death', 'be careful')
    try { bot.chat('oof i died 💀') } catch {}
  })

  bot.on('spawn', () => { lastHealth = getHealth(bot) })
}

// ===== BOT FACTORY =====
let hostileCheckInterval   = null
let inventoryCheckInterval = null

function createBot() {
  console.log(`🔄 Connecting ${HOST}:${PORT} v${MC_VERSION}...`)

  const bot = mineflayer.createBot({
    host: HOST, port: PORT, username: USERNAME,
    version: MC_VERSION, auth: 'offline'
  })

  botInstance = bot
  bot.loadPlugin(pathfinder)

  clearSensorIntervals()
  if (hostileCheckInterval)   clearInterval(hostileCheckInterval)
  if (inventoryCheckInterval) clearInterval(inventoryCheckInterval)
  sensorCooldowns = {}

  bot.once('spawn', () => {
    console.log('✅ Spawned!')
    lastHealth = getHealth(bot)
    setTimeout(() => { try { bot.chat('/register ' + MC_PASSWORD) } catch {} }, 2000)
    setTimeout(() => { try { bot.chat('/login '    + MC_PASSWORD) } catch {} }, 4000)
    setTimeout(() => { try { bot.chat('/skin set ' + BOT_SKIN)    } catch {} }, 6000)
    try {
      const move = new Movements(bot)
      move.canDig = false; move.allowSprinting = true
      bot.pathfinder.setMovements(move)
    } catch (e) { console.log('Pathfinder error:', e.message) }
    setupSensors(bot)
    hostileCheckInterval   = setInterval(() => checkHostiles(bot), 2000)
    inventoryCheckInterval = setInterval(() => updateStoredInventory(bot), 10000)
  })

  // ===== CHAT — 1 MESSAGE ONLY =====
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return
    const lower         = message.toLowerCase()
    const mentionsNeuro = lower.includes('neuro')

    const wantsPvpCoach = mentionsNeuro && (
      lower.includes('teach') || lower.includes('coach') ||
      lower.includes('pvp')   || lower.includes('train') ||
      lower.includes('how to fight') || lower.includes('show me')
    )
    const showingMoves = mentionsNeuro && (
      lower.includes('watch this') || lower.includes('watch me') ||
      lower.includes('my moves')   || lower.includes('check this')
    )
    const comeHere = mentionsNeuro && (
      lower.includes('come here') || lower.includes('come to') ||
      lower.includes('follow') || lower.includes('come')
    )

    // Overhear nearby
    if (!mentionsNeuro) {
      const near = Object.values(bot.entities).find(e =>
        e.username === username && e.position && bot.entity &&
        bot.entity.position.distanceTo(e.position) < 8
      )
      if (near && sensorCooldown(`chat_${username}`, 20000)) {
        updatePersonality(username, 'positive')
        teachNeuro(username, message.substring(0, 80))
        if (Math.random() < 0.25) {
          const ai = await getAIResponse(bot,
            `Overheard ${username}: "${message}". React in 1 short sentence!`, username, 'Overheard'
          )
          if (ai.reply) sendChat(bot, ai.reply)
          performAction(bot, ai.action)
        }
      }
      return
    }

    console.log(`💬 [${username}]: ${message}`)
    updatePersonality(username, 'positive')

    // PVP coach
    if (wantsPvpCoach) {
      const session = getPvpSession(username)
      session.active = true; session.step++
      const entity = Object.values(bot.entities).find(e => e.username === username)
      if (entity) await walkToEntity(bot, entity, 3)
      const ai = await getAIResponse(bot,
        `${username} wants PVP coaching step ${session.step}. Explain 1 move then demo it. Tell them to show you after!`,
        username
      )
      if (ai.reply) sendChat(bot, ai.reply)
      await handleDemoAction(bot, ai.action, username)
      session.waitingForPlayer = true
      return
    }

    // Player showing moves
    if (showingMoves) {
      const session = getPvpSession(username)
      session.waitingForPlayer = true
      const obs    = observePlayer(bot, username)
      const obsCtx = obs ? `${username}: ${obs.detectedMoves.join(', ')} holding:${obs.heldItem}` : 'showing moves'
      const ai = await getAIResponse(bot,
        `${username} is showing PVP moves! Comment as coach!`, username, null, obsCtx
      )
      if (ai.reply) sendChat(bot, ai.reply)
      performAction(bot, ai.action)
      return
    }

    // Come here
    if (comeHere) {
      const entity = Object.values(bot.entities).find(e => e.username === username)
      if (entity) {
        const ai = await getAIResponse(bot, `${username} wants me to come!`, username)
        if (ai.reply) sendChat(bot, ai.reply)
        await walkToEntity(bot, entity, 2)
        return
      }
    }

    // Normal chat — 1 message
    const ai = await getAIResponse(bot, message, username)
    if (ai.reply) sendChat(bot, ai.reply)

    if (ai.action.startsWith('pvp:')) {
      const target = Object.values(bot.entities).find(e => e.username === ai.action.split(':')[1])
      if (target) engagePVP(bot, target)
    } else if (ai.action === 'pvp_mob') {
      const mob = Object.values(bot.entities).find(e =>
        e.type === 'mob' && e.position && bot.entity.position.distanceTo(e.position) < 16
      )
      if (mob) engagePVP(bot, mob)
    } else { await handleDemoAction(bot, ai.action, username) }
  })

  // ===== GRIM =====
  bot.on('message', (jsonMsg) => {
    const msg      = jsonMsg.toString()
    const triggers = ['grim','anticheat','flagged','violation','cheating','illegal','kicked for','suspicious']
    if (triggers.some(t => msg.toLowerCase().includes(t))) {
      if (!sensorCooldown('grim', 10000)) return
      getAIResponse(bot, `Grim alert: "${msg.substring(0, 60)}". Warn player short.`, 'GRIM_SYSTEM'
      ).then(ai => { if (ai.reply) sendChat(bot, '⚠️ ' + ai.reply) })
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
    playerHitTracker = {}; approachedPlayers.clear()
    sensorCooldowns  = {}; cleanupCoachState()
    clearSensorIntervals()
    if (hostileCheckInterval)   { clearInterval(hostileCheckInterval);   hostileCheckInterval   = null }
    if (inventoryCheckInterval) { clearInterval(inventoryCheckInterval); inventoryCheckInterval = null }
    console.log('🔁 Reconnecting in 5s...')
    setTimeout(createBot, 5000)
  })

  bot.on('kicked', (reason) => console.log(`🚫 Kicked: ${reason}`))
  bot.on('error',  (err)    => console.log(`⚠️ Error: ${err.message}`))

  return bot
}

createBot()
