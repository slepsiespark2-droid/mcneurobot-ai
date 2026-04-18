// ===== LOAD ENV (optional .env support) =====
try { require('dotenv').config() } catch {}

// ===== IMPORTS =====
const mineflayer = require('mineflayer')
const fs = require('fs')

// ===== ENV CONFIG =====
const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT) || 25565
const USERNAME = process.env.MC_USERNAME || 'NeuroBotAI'
const GROK_API_KEY = process.env.GROK_API_KEY

// ===== CREATE BOT =====
const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: USERNAME
})

// ===== MEMORY SYSTEM =====
const memoryFile = 'memory.json'
let memory = {}

if (fs.existsSync(memoryFile)) {
  memory = JSON.parse(fs.readFileSync(memoryFile))
} else {
  fs.writeFileSync(memoryFile, JSON.stringify({}))
}

function saveMemory() {
  fs.writeFileSync(memoryFile, JSON.stringify(memory, null, 2))
}

// ===== ACTION SYSTEM =====
let actionInterval = null

function stopAllActions() {
  bot.clearControlStates()
  if (actionInterval) clearInterval(actionInterval)
}

function performAction(action) {
  stopAllActions()

  switch (action) {

    case "happy":
      actionInterval = setInterval(() => {
        bot.setControlState('sneak', true)
        setTimeout(() => bot.setControlState('sneak', false), 200)
      }, 400)
      setTimeout(stopAllActions, 5000)
      break

    case "run":
      bot.setControlState('sprint', true)
      bot.setControlState('forward', true)

      actionInterval = setInterval(() => {
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), 200)
      }, 600)

      setTimeout(stopAllActions, 5000)
      break

    case "walk":
      bot.setControlState('forward', true)
      setTimeout(stopAllActions, 4000)
      break

    case "stop":
    default:
      stopAllActions()
      break
  }
}

// ===== GROK AI =====
async function getAIResponse(message, username) {
  try {
    // memory update
    if (!memory[username]) {
      memory[username] = { chats: 0 }
    }
    memory[username].chats++
    saveMemory()

    if (!GROK_API_KEY) {
      return {
        chat: "No API key set 😅",
        action: "stop"
      }
    }

    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROK_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "grok-beta",
        messages: [
          {
            role: "system",
            content: "You are NeuroBot, a Minecraft AI companion. Reply short. Include one action keyword: happy, run, walk, or stop."
          },
          {
            role: "user",
            content: message
          }
        ]
      })
    })

    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content || "..."

    // detect action
    let action = "happy"
    const lower = text.toLowerCase()

    if (lower.includes("run")) action = "run"
    else if (lower.includes("walk")) action = "walk"
    else if (lower.includes("stop")) action = "stop"

    return {
      chat: text.replace(/(happy|run|walk|stop)/gi, "").trim(),
      action
    }

  } catch (err) {
    console.log("AI error:", err)
    return {
      chat: "AI error 😅",
      action: "stop"
    }
  }
}

// ===== CHAT HANDLER =====
bot.on('chat', async (username, message) => {
  if (username === bot.username) return

  // only respond if "Neuro"
  if (!message.toLowerCase().includes("neuro")) return

  const ai = await getAIResponse(message, username)

  if (ai.chat) bot.chat(ai.chat)
  if (ai.action) performAction(ai.action)
})

// ===== EVENTS =====
bot.on('spawn', () => {
  console.log(`✅ Connected to ${HOST}:${PORT}`)
})

bot.on('end', () => {
  console.log('❌ Disconnected. Restarting...')
  setTimeout(() => process.exit(), 5000)
})

bot.on('error', err => console.log(err))
