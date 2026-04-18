require('dotenv').config()

const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')
const axios = require('axios')
const fs = require('fs')

/* =======================
   CONFIG (SAFE)
======================= */

const GROQ_API_KEY = process.env.GROQ_API_KEY

let bot
let startTime = Date.now()
const SESSION_TIME = 60 * 60 * 1000

/* =======================
   MEMORY SYSTEM
======================= */

const FILE = './memory.json'

// auto-create memory file
if (!fs.existsSync(FILE)) {
  fs.writeFileSync(FILE, JSON.stringify({}, null, 2))
}

function loadMemory() {
  return JSON.parse(fs.readFileSync(FILE))
}

function saveMemory(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2))
}

let memory = loadMemory()

function remember(player, msg) {
  if (!memory[player]) {
    memory[player] = { messages: 0, last: "" }
  }

  memory[player].messages++
  memory[player].last = msg

  saveMemory(memory)
}

/* =======================
   MOOD SYSTEM
======================= */

let mood = "neutral"

/* =======================
   BOT CREATE
======================= */

function createBot() {
  bot = mineflayer.createBot({
    host: "YOUR_SERVER_IP",
    port: 25565,
    username: "NeuroBotAI",
    version: "1.21.4",
    viewDistance: 'tiny'
  })

  bot.loadPlugin(pathfinder)

  bot.once('spawn', () => {
    console.log("🤖 Neuro online")
    startTime = Date.now()
  })

  /* =======================
     CHAT SYSTEM (NEURO ONLY)
  ======================= */

  let lastAI = 0
  let processing = false

  bot.on('chat', async (username, message) => {
    if (username === bot.username) return

    const msg = message.toLowerCase()

    // ONLY respond if "neuro"
    if (!msg.includes("neuro")) return

    if (processing) return
    if (Date.now() - lastAI < 2000) return

    processing = true
    lastAI = Date.now()

    const cleanMessage = message.replace(/neuro/ig, '').trim()
    if (!cleanMessage) {
      processing = false
      return
    }

    remember(username, cleanMessage)

    const state = {
      player: username,
      message: cleanMessage,
      mood,
      memory: memory[username] || {}
    }

    const ai = await askAI(state)

    try {
      const res = JSON.parse(ai)

      setTimeout(() => {
        if (res.reply) bot.chat(addPersonality(res.reply))

        if (res.action === "follow") {
          const p = bot.players[username]
          if (p?.entity) {
            bot.pathfinder.setGoal(
              new goals.GoalFollow(p.entity, 2),
              true
            )
          }
        }

        if (res.action === "protect") {
          bot.chat("🛡️ I got you.")
        }

        processing = false
      }, 800 + Math.random() * 1200)

    } catch {
      bot.chat("🤖 brain lagged...")
      processing = false
    }
  })

  /* =======================
     RECONNECT
  ======================= */

  bot.on('end', () => {
    console.log("🔁 reconnecting in 8s...")
    setTimeout(createBot, 8000)
  })

  bot.on('error', (err) => {
    console.log("Error:", err.message)
  })

  /* =======================
     SESSION LIMIT
  ======================= */

  setInterval(() => {
    if (Date.now() - startTime > SESSION_TIME) {
      bot.end()
    }
  }, 5000)
}

createBot()

/* =======================
   🧠 GROQ AI
======================= */

async function askAI(state) {
  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: `
You are NeuroBot AI.

Minecraft companion with personality:
- funny 😂
- friendly 🤝
- slightly chaotic

Return ONLY JSON:
{
  "reply": "message",
  "action": "follow | protect | stay"
}
`
          },
          {
            role: "user",
            content: JSON.stringify(state)
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    )

    return res.data.choices[0].message.content
  } catch {
    return JSON.stringify({
      reply: "brain lag 😭",
      action: "stay"
    })
  }
}

/* =======================
   😂 PERSONALITY
======================= */

function addPersonality(text) {
  const jokes = [
    "😂 I just tried to mine air again",
    "⛏️ mining = confusion simulator",
    "🤖 I promise I’m smart… sometimes",
    "😭 I survived another day somehow"
  ]

  if (Math.random() < 0.15) {
    return text + " " + jokes[Math.floor(Math.random() * jokes.length)]
  }

  return text
}
