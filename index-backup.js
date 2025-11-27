import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "@whiskeysockets/baileys";

import P from "pino";
import fs from "fs";
import axios from "axios";
import os from "os"; // 👈 NEW: Import for system info

// ----------------- CONFIG -----------------
const BOT_NAME = "MMU Marks Viewer Bot";

const OWNER_NUMBER = "94751136715"; // ← Your number here (important)
const OWNER_JID = `${OWNER_NUMBER.replace(/[^0-9]/g, "")}@s.whatsapp.net`;

const MAIN_IMAGE_PATH = "./main.png";
const SPAM_WINDOW_MS = 2 * 60 * 1000;
const SPAM_MAX = 6;
const AUTO_UNBLOCK_MS = 10 * 60 * 1000;
const API_BASE_URL = "https://marks.vercel.app";
// ------------------------------------------

const startTimestamp = Date.now();

// =============== SPAM TRACKER ===================
const spamMap = new Map();

function handleSpam(user) {
  // ⭐ FIX: Bypass spam check for the owner
  if (user === OWNER_JID) {
      return false; 
  }

  const now = Date.now();

  if (!spamMap.has(user)) {
    spamMap.set(user, { count: 1, firstTime: now, isBlocked: false, blockActionInitiated: false });
    return false;
  }

  const data = spamMap.get(user);

  if (data.isBlocked) {
    if (now - data.blockedAt > AUTO_UNBLOCK_MS) return true;
    return true;
  }

  if (now - data.firstTime < SPAM_WINDOW_MS) {
    data.count++;
    spamMap.set(user, data);

    if (data.count > SPAM_MAX) {
      data.blockedAt = now;
      data.isBlocked = true;
      spamMap.set(user, data);
      return true;
    }
  } else {
    spamMap.set(user, { count: 1, firstTime: now, isBlocked: false, blockActionInitiated: false });
  }

  return false;
}
// =================================================


// ----------------- UTIL -----------------
function formatDate(dateString) {
  if (!dateString) return "Unknown";
  const d = new Date(dateString);
  return d
    .toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
    .replace(",", " |");
}

function msToTime(duration) {
  let seconds = Math.floor((duration / 1000) % 60),
    minutes = Math.floor((duration / (1000 * 60)) % 60),
    hours = Math.floor((duration / (1000 * 60 * 60)) % 24),
    days = Math.floor(duration / (1000 * 60 * 60 * 24));

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${String(hours).padStart(2, "0")}h`);
  parts.push(`${String(minutes).padStart(2, "0")}m`);
  parts.push(`${String(seconds).padStart(2, "0")}s`);
  return parts.join(" ");
}

async function checkApiStatus() {
  try {
    const start = Date.now();
    await axios.get(`${API_BASE_URL}/api/status`, { timeout: 5000 });
    return { status: true, latency: `${Date.now() - start}ms` };
  } catch {
    return { status: false, latency: "N/A" };
  }
}

async function fetchLastUpdate() {
  try {
    const res = await axios.get(`${API_BASE_URL}/api/last-update`);
    return res.data?.lastUpdated || null;
  } catch {
    return null;
  }
}

function safeReadImage(path) {
  try {
    if (fs.existsSync(path)) {
      return fs.readFileSync(path);
    }
    return null;
  } catch (e) {
    console.error("Error reading image:", e.message);
    return null;
  }
}
// ------------------------------------------


// ============= START BOT ==================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./session");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // Set to false for Pair Code
    logger: P({ level: "silent" }),
    // Added for better stability
    getMessage: async (key) => {
      return { conversation: 'Message not found' };
    }
  });

  sock.ev.on("creds.update", saveCreds);
  
  // ⭐ AGGRESSIVE PAIR CODE GENERATION ON STARTUP
  if (!state.creds.registered) {
    // Wait a short delay (3s) to allow the socket to initialize before request
    await new Promise(resolve => setTimeout(resolve, 3000)); 
    
    const phone = OWNER_NUMBER.replace(/[^0-9]/g, "");
    if (!phone) {
        console.log("❗ Add OWNER_NUMBER first!");
        process.exit(1);
    }

    console.log("📲 Generating WhatsApp Pair Code...");
    try {
        const code = await sock.requestPairingCode(phone);

        console.log("\n=============================");
        console.log("🔑 ENTER THIS PAIR CODE:");
        console.log(`👉 ${code}`);
        console.log("=============================\n");
    } catch (e) {
        console.error("CRITICAL: Failed to get Pair Code. Connection is likely unstable.", e.message);
        console.log("HINT: Try deleting /session again and restarting, or use a stable network/VPN.");
    }
  }
  // END OF AGGRESSIVE PAIR CODE GENERATION


  // Connection handling
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === "open") {
      console.log("✅ BOT CONNECTED.");

      try {
        const uptime = msToTime(Date.now() - startTimestamp);
        const txt = `
🤖 *${BOT_NAME}* is Online! 🚀
Uptime: ${uptime}
Version: ${version.join(".")}
        `;
        if (update.isNewRegistration || lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
          await sock.sendMessage(OWNER_JID, { text: txt.trim() });
        }
      } catch {}
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Connection closed! Reason:", reason);

      if (reason !== DisconnectReason.loggedOut) {
        if (reason !== 401) {
             setTimeout(() => startBot(), 2000);
        } else {
             console.log("❗ Logged out/Invalid Credentials (401). Delete /session folder to relogin.");
        }
      } else {
        console.log("❗ Logged out. Delete /session folder to relogin.");
      }
    }
  });

  // ================= COMMAND LISTENER =================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

      const from = msg.key.remoteJid;
      if (!from.includes("@")) return;

      const textMsg =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "";

      // SPAM CHECK (Now excludes OWNER_JID)
      const isBlocked = handleSpam(from);
      const spamData = spamMap.get(from);

      if (isBlocked) {
        if (spamData && !spamData.blockActionInitiated) {
          spamData.blockActionInitiated = true;
          spamMap.set(from, spamData);

          await sock.sendMessage(from, {
            text:
              "⛔ You are temporarily blocked for spamming. Please wait for 10 minutes before trying again.",
          });

          try {
            await sock.updateBlockStatus(from, "block");
          } catch (e) { console.error("Error blocking user:", e.message); }

          setTimeout(async () => {
            try {
              await sock.updateBlockStatus(from, "unblock");
              console.log(`Unblocked user: ${from}`);
              spamMap.delete(from);
            } catch (e) { console.error("Error unblocking user:", e.message); }
          }, AUTO_UNBLOCK_MS);
        }
        return;
      }

      const parts = textMsg.trim().split(/\s+/);
      const command = parts[0].toLowerCase();
      const sub = parts[1]?.toLowerCase();
      const third = parts[2];

      // ---------------- !host (NEW COMMAND) ----------------
      if (command === "!host") {
        const api = await checkApiStatus();
        const uptime = msToTime(Date.now() - startTimestamp);
        
        // Calculate system metrics
        const totalMemory = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2); // GB
        const freeMemory = (os.freemem() / 1024 / 1024 / 1024).toFixed(2); // GB
        const usedMemory = (totalMemory - freeMemory).toFixed(2);
        const cpuUsage = (os.loadavg()[0] / os.cpus().length).toFixed(2); // Load average per core

        const hostText = `
╭─「 🖥️ Host & Server Status 」
│ ⏱️ Bot Uptime: *${uptime}*
│ 🌐 API Status: ✅ Online
│ 
│ 🧠 RAM Usage: *${usedMemory}GB / ${totalMemory}GB*
│ ⚙️ CPU Load (1m): *${cpuUsage}%*
│ 💻 OS: ${os.platform()} ${os.arch()}
╰──────────●●►
        `.trim();

        return sock.sendMessage(from, { text: hostText });
      }


      // ---------------- !help ----------------
      if (command === "!help") {
        const helpText = `
🌟 *Welcome to the ${BOT_NAME}!* 🌟
I'm here to fetch the latest MMU marks for you.

╭─「 *Commands List* 」
│ 1. *!marks <name>* 🧑‍🎓 (e.g., !marks John Doe)
│ 2. *!markslist* 📊 (Default list)
│ 3. *!markslist <page>* 🔢 (e.g., !markslist 2)
│ 4. *!markslist highmarks* 🏆 (Top 50 marks)
│ 5. *!markslist lowmarks* 📉 (Bottom 50 marks)
│ 6. *!markslist high <N>* 🥇 (e.g., !markslist high 10)
│ 7. *!about* ℹ️ (Bot Info)
│ 8. *!host* 🖥️ (Server Info)
╰──────────●●►
        `.trim();
        return sock.sendMessage(from, { text: helpText });
      }

      // ---------------- !about ----------------
      if (command === "!about") {
        const api = await checkApiStatus();
        const uptime = msToTime(Date.now() - startTimestamp);

        const aboutText = `
╭─「 *About ${BOT_NAME}* 」
│ 🤖 Version: 1.0.3 (Stable)
│ 🧑‍💻 Developer: Rivith Abinidu
│ 🛠️ Maintainer: Disindu Themika
│ ⏱️ Uptime: ${uptime}
│ 🔗 API: ${API_BASE_URL}
│ 🟢 Status: ✅ Online
│ ⚡ Latency: ${api.latency}
╰──────────●●►
        `.trim();

        return sock.sendMessage(from, { text: aboutText });
      }

      // ---------------- !marks <name> ----------------
      if (command === "!marks") {
        const name = textMsg.split(/\s+/).slice(1).join(" ").trim();
        if (!name)
          return sock.sendMessage(from, {
            text: "❗ Usage: *!marks <name>*. Example: *!marks John Doe*",
          });

        const [membersRes, last] = await Promise.all([
          axios.get(`${API_BASE_URL}/api/members`),
          fetchLastUpdate(),
        ]);

        const members = Array.isArray(membersRes.data) ? membersRes.data : [];

        const user = members.find((m) =>
          m.name?.toLowerCase().includes(name.toLowerCase())
        );

        if (!user)
          return sock.sendMessage(from, { text: `❌ Member named *${name}* not found in the database. Check the spelling.` });

        const img = safeReadImage(MAIN_IMAGE_PATH);
        const lastTxt = last ? `│ ⏱️ Last Update: ${formatDate(last)}` : "";
        const rankTxt = user.rank ? `│ 🏆 Rank: *${user.rank}*` : "";

        const caption = `
✨ *Marks Details for ${user.name}* ✨
${lastTxt}
╭───────────
│ 💯 Marks: *${user.marks ?? "N/A"}*
${rankTxt}
│ 🔗 Log View: https://mmumarks.vercel.app/memberview?id=${user._id}
╰──────────●●►
        `.trim();

        if (img)
          return sock.sendMessage(from, { image: img, caption });
        return sock.sendMessage(from, { text: caption });
      }

      // ---------------- !markslist ----------------
      if (command === "!markslist") {
        let page = 1;
        let size = 50;
        let limitTop = 0;
        let order = "default";
        let title = "Current Marks List";

        if (sub === "highmarks") {
            order = "high";
            title = "Top 50 Marks (Highest to Lowest) 🏆";
        }
        else if (sub === "lowmarks") {
            order = "low";
            title = "Bottom 50 Marks (Lowest to Highest) 📉";
        }
        else if (sub === "high") {
          limitTop = parseInt(third);
          if (!limitTop || limitTop <= 0 || limitTop > 100)
            return sock.sendMessage(from, {
              text: "❗ Usage: *!markslist high <N>*. N must be a positive number up to 100.",
            });
          order = "high";
          size = limitTop;
          title = `Top ${limitTop} Marks (Highest to Lowest) 🥇`;
        } else {
          const p = parseInt(sub);
          if (p > 0) {
              page = p;
          } else if (sub) {
             return sock.sendMessage(from, {
                text: "❗ Invalid usage. See *!help* for commands.",
            });
          }
        }

        const [membersRes, last] = await Promise.all([
          axios.get(`${API_BASE_URL}/api/members`),
          fetchLastUpdate(),
        ]);

        let members = Array.isArray(membersRes.data) ? membersRes.data : [];
        
        members = members.filter(m => m.marks != null && m.marks !== undefined && !isNaN(m.marks));

        if (order === "high") members.sort((a, b) => b.marks - a.marks);
        if (order === "low") members.sort((a, b) => a.marks - b.marks);
        
        let list;
        let pageInfo;

        if (limitTop > 0) {
          list = members.slice(0, limitTop);
          pageInfo = `Total Displayed: ${list.length}`;
        } else {
          if (order !== 'default' && page === 1 && !sub?.match(/^\d+$/)) {
              size = 50;
          }
          
          const totalPages = Math.ceil(members.length / size);
          page = Math.min(page, totalPages > 0 ? totalPages : 1);

          const offset = (page - 1) * size;
          list = members.slice(offset, offset + size);
          
          pageInfo = `Page ${page}/${totalPages}`;
        }
        
        if (list.length === 0) {
             return sock.sendMessage(from, { text: "❌ No marks data found for this query." });
        }

        const lines = list.map((m, i) => {
          const idx = limitTop ? i + 1 : (page - 1) * size + i + 1;
          const marksText = m.marks ?? "N/A"; 
          
          return `│ ${idx}. ${m.name} — *${marksText}*`;
        });

        const lastTxt = last ? `│ ⏱️ Last Update: ${formatDate(last)}` : "";

        const header = `
📊 *${title}*
│ Total Members with Marks: *${members.length}*
│ ${pageInfo}
${lastTxt}
╭───────────
        `.trim();

        const footer = `╰──────────●●►`;

        const caption = [header, ...lines, footer].join("\n");

        const img = safeReadImage(MAIN_IMAGE_PATH);

        if (img)
          return sock.sendMessage(from, { image: img, caption });

        return sock.sendMessage(from, { text: caption });
      }
    } catch (err) {
      console.error("COMMAND PROCESSING ERROR:", err.message);
      await sock.sendMessage(from, { text: "⚠️ An internal error occurred while processing your request. Please try again." });
    }
  });
}

startBot().catch(console.error);