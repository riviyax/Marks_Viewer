import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";
import P from "pino";
import fs from "fs";
import axios from "axios";
import qrcode from 'qrcode-terminal'; // ⬅️ NEW IMPORT for QR display

// ----------------- CONFIG -----------------
const BOT_NAME = "MMU Marks Viewer Bot";
const OWNER_NUMBER = "94773557644";
// Convert number to full JID (assuming personal chat format)
const OWNER_JID = `${OWNER_NUMBER.replace(/[^0-9]/g, "")}@s.whatsapp.net`;
const MAIN_IMAGE_PATH = "./main.png"; // ensure this exists
const SPAM_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const SPAM_MAX = 6; // >6 => block
const AUTO_UNBLOCK_MS = 10 * 60 * 1000; // 10 minutes auto-unblock
const API_BASE_URL = "https://marks.vercel.app";
// ------------------------------------------

// track bot start time for uptime
const startTimestamp = Date.now();

// =============== SPAM TRACKER ===================
// spamMap structure: key -> { count, firstTime, blockedAt?, isBlocked?, blockActionInitiated? }
const spamMap = new Map();

/**
 * Handles spam checking. Returns true if the user should be blocked/is currently blocked.
 * Note: The actual blocking API call is handled in the command listener.
 */
function handleSpam(user) {
  const now = Date.now();

  if (!spamMap.has(user)) {
    spamMap.set(user, { count: 1, firstTime: now, isBlocked: false, blockActionInitiated: false });
    return false;
  }

  const data = spamMap.get(user);

  // 1. Check if ALREADY BLOCKED
  if (data.isBlocked) {
    // Check if auto-unblock time has passed
    if (now - data.blockedAt > AUTO_UNBLOCK_MS) {
      // Time passed, but actual unblock is scheduled via setTimeout in the main handler.
      return true;
    }
    // Still within the block period, prevent command processing
    return true;
  }

  // 2. Check for new spam
  if (now - data.firstTime < SPAM_WINDOW_MS) {
    data.count++;
    spamMap.set(user, data);

    if (data.count > SPAM_MAX) {
      // Mark blocked and return true to initiate the block sequence in the main listener
      data.blockedAt = now;
      data.isBlocked = true;
      spamMap.set(user, data);
      return true;
    }
  } else {
    // reset window (and ensure isBlocked flags are false)
    spamMap.set(user, { count: 1, firstTime: now, isBlocked: false, blockActionInitiated: false });
  }

  return false;
}
// =================================================

// ----------------- UTIL -----------------
function formatDate(dateString) {
  if (!dateString) return "Unknown";
  const d = new Date(dateString);
  // en-GB -> DD Mon YYYY, time
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).replace(",", " |");
}

function msToTime(duration) {
  // convert ms to "X days, HH:mm:ss" style but short
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
    const latency = Date.now() - start;
    return { status: true, latency: `${latency}ms` };
  } catch (e) {
    return { status: false, latency: "N/A" };
  }
}

async function fetchLastUpdate() {
  try {
    const res = await axios.get(`${API_BASE_URL}/api/last-update`);
    return res.data?.lastUpdated || null;
  } catch (e) {
    return null;
  }
}

function safeReadImage(path) {
  try {
    return fs.readFileSync(path);
  } catch (e) {
    console.warn(`Could not read image at ${path}: ${e.message}`);
    return null;
  }
}
// ------------------------------------------

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./session");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    // FIX: Set logger level to "info" to see necessary output
    logger: P({ level: "info" }),
    // REMOVED: printQRInTerminal: true, // This is deprecated
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // 🌟 FIX: Manually check for and handle the QR code
    if (qr) {
        console.log("-----------------------------------------");
        console.log("⭐ SCAN THE QR CODE BELOW TO CONNECT: ⭐");
        console.log("-----------------------------------------");
        // Use qrcode-terminal to display a scannable QR code
        qrcode.generate(qr, { small: true }); 
    }

    if (connection === "open") {
      console.log("✅ WhatsApp Bot Connected Successfully!");

      // --- 🔑 BOT STARTUP MESSAGE TO OWNER ---
      try {
        const botUpTime = msToTime(Date.now() - startTimestamp);
        const startupMessage = `
*🤖 ${BOT_NAME} is Online!*

Status: *✅ Operational*
Uptime: ${botUpTime}
WhatsApp Version: ${version.join(".")}

Ready to serve commands.
`;
        await sock.sendMessage(OWNER_JID, { text: startupMessage.trim() });
      } catch (e) {
        console.error("Failed to send startup message to owner:", e?.message || e);
      }
      // ----------------------------------------

    } else if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Connection closed, trying to reconnect...");
      
      // Reconnect if not logged out
      if (reason !== DisconnectReason.loggedOut) {
          // Added a small delay for stability
          setTimeout(() => startBot(), 2000); 
      } else {
          console.log("Session explicitly logged out. Delete the session folder and restart the script to connect again.");
      }
    }
  });

  // ================= COMMAND LISTENER =================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg || !msg.message) return;

      const from = msg.key.remoteJid;
      // ignore status broadcast etc.
      if (!from || !from.includes("@")) return;

      // robust text extraction
      const textMsg =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "";

      // SPAM CHECK
      const isBlockedOrSpamming = handleSpam(from);
      const spamData = spamMap.get(from);

      if (isBlockedOrSpamming) {
        // --- KEY FIX: Only initiate block sequence once ---
        if (spamData && !spamData.blockActionInitiated) {
          spamData.blockActionInitiated = true;
          spamMap.set(from, spamData); // Persist block action initiation state

          // Send block notice then attempt to block user
          await sock.sendMessage(from, {
            text:
              "⛔ *You are sending commands too fast!*\nYou have been temporarily blocked for spamming. Try again later."
          });

          // Block the user
          try {
            await sock.updateBlockStatus(from, "block");
            console.log(`Successfully initiated block for ${from}.`);
          } catch (e) {
            console.warn("Failed to block user:", e?.message || e);
          }

          // Schedule auto-unblock after AUTO_UNBLOCK_MS
          setTimeout(async () => {
            try {
              await sock.updateBlockStatus(from, "unblock");
              // IMPORTANT: Delete the map entry so user can use the bot again
              spamMap.delete(from); 
              console.log(`Auto-unblocked ${from} and cleared state.`);
            } catch (e) {
              console.warn("Failed to auto-unblock:", e?.message || e);
            }
          }, AUTO_UNBLOCK_MS);
        }
        // Always stop processing commands if user is marked as blocked
        return; 
      }
      // ---------------------------------------------------

      // handle commands (case-insensitive)
      const parts = textMsg.trim().split(/\s+/);
      const command = parts[0].toLowerCase();
      const subCommand = parts[1]?.toLowerCase();
      const thirdArg = parts[2]; // for !markslist high <number>

      // --- NEW COMMAND: !help ---
      if (command === "!help") {
        const helpText = `
╭─「 *${BOT_NAME} Commands* 」
│
│ *1. Marks Lookup:*
│     \`!marks <name>\`
│     _Example: !marks kemiya_
│
│ *2. Marks Leaderboard:*
│     \`!markslist\` (Default Top 50)
│     \`!markslist <page_number>\`
│     \`!markslist highmarks\` (High to Low)
│     \`!markslist lowmarks\` (Low to High)
│     \`!markslist high <N>\` (Show Top N members)
│     _Example: !markslist high 10_
│
│ *3. Information:*
│     \`!about\` (Bot and Server status)
│     \`!help\` (Show this message)
╰──────────●●►
`.trim();
        await sock.sendMessage(from, { text: helpText });
        return;
      }
      
      // --- NEW COMMAND: !about ---
      if (command === "!about") {
        const apiStatus = await checkApiStatus();
        const uptime = msToTime(Date.now() - startTimestamp);

        const aboutText = `
╭─「 *About ${BOT_NAME}* 」
│ *Developer:* Rivith Abinidu & Disidu Themika
│
│ *Bot Status:*
│       Uptime: ${uptime}
│       Langs: Node.js (Baileys)
│
│ *External Server Status:*
│       API: ${API_BASE_URL}
│       Status: ${apiStatus.status ? '✅ Online' : '❌ Offline'}
│       Latency: ${apiStatus.latency}
│
│ *Concept:* Rivith Abinidu (Riviya_X)
╰──────────●●►
`.trim();
        await sock.sendMessage(from, { text: aboutText });
        return;
      }

      // ---------- !marks <name> (EXISTING) ----------
      if (command === "!marks") {
        const nameArg = textMsg.trim().split(/\s+/).slice(1).join(" ").trim();
        if (!nameArg) {
          return sock.sendMessage(from, {
            text: "❗ Usage: *!marks <name>*\nExample: `!marks kemiya`"
          });
        }

        // fetch members and last update
        const [membersRes, last] = await Promise.all([
          axios.get(`${API_BASE_URL}/api/members`), // Use API_BASE_URL
          fetchLastUpdate()
        ]);

        const members = Array.isArray(membersRes.data) ? membersRes.data : [];

        // search ignoring case
        const user = members.find((m) =>
          m.name?.toLowerCase().includes(nameArg.toLowerCase())
        );

        if (!user) {
          return sock.sendMessage(from, { text: "❌ Member not found." });
        }

        const imgData = safeReadImage(MAIN_IMAGE_PATH);

        // format Last Updated
        const lastUpdatedFormatted = last ? `│⏱️ Last Update: ${formatDate(last)}` : "";

        // panel caption — Asitha-MD style with box-like look
        const caption = `
╭─「 Member Details 」
│🧑‍💼 *Name:* ${user.name}
│🎖️ *Rank:* ${user.rank || "N/A"}
│🏆 *Marks:* ${user.marks ?? "N/A"}
│
│🔗 *Activity Logs:* │   ${API_BASE_URL}/memberview?id=${user._id}
${lastUpdatedFormatted}
│
│ Developed by *Rivith Abinidu (Riviya_X)*
╰──────────●●►
`.trim();

        if (imgData) {
          await sock.sendMessage(from, {
            image: imgData,
            caption
          });
        } else {
          await sock.sendMessage(from, {
            text: caption
          });
        }

        return;
      }

      // ---------- !markslist (EXISTING) ----------
      if (command === "!markslist") {
        // default pagination variables
        let pageArg = 1;
        let pageSize = 50; // default page size
        let limitTopN = 0; // for !markslist high <number>
        let sortOrder = "default"; // 'default', 'high', 'low'

        if (subCommand === "highmarks") {
          sortOrder = "high";
        } else if (subCommand === "lowmarks") {
          sortOrder = "low";
        } else if (subCommand === "high") {
          // !markslist high <number>
          limitTopN = parseInt(thirdArg);
          if (isNaN(limitTopN) || limitTopN <= 0) {
            return sock.sendMessage(from, {
              text: "❗ Usage: *!markslist high <number>*\nExample: `!markslist high 5` to show top 5 members.",
            });
          }
          sortOrder = "high"; // always high for this filter
          pageSize = limitTopN; // set page size to the limit
        } else {
          // Check for simple pagination !markslist 2
          const potentialPage = parseInt(subCommand);
          if (!isNaN(potentialPage) && potentialPage > 0) {
            pageArg = potentialPage;
          }
        }

        const offset = Math.max(0, (pageArg - 1) * pageSize);

        // fetch members and last update
        const [membersRes, last] = await Promise.all([
          axios.get(`${API_BASE_URL}/api/members`), // Use API_BASE_URL
          fetchLastUpdate(),
        ]);

        let members = Array.isArray(membersRes.data) ? membersRes.data : [];

        // --- Sorting Logic ---
        if (sortOrder === "high") {
          members.sort((a, b) => {
            const A = Number(a.marks ?? 0);
            const B = Number(b.marks ?? 0);
            return B - A; // High to Low
          });
        } else if (sortOrder === "low") {
          members.sort((a, b) => {
            const A = Number(a.marks ?? 0);
            const B = Number(b.marks ?? 0);
            return A - B; // Low to High
          });
        }

        // --- Slicing/Limiting Logic ---
        let pageMembers;
        let pageInfo = `Page: ${pageArg}`;

        if (limitTopN > 0) {
          // For !markslist high <number>
          pageMembers = members.slice(0, limitTopN);
          pageInfo = `Top ${limitTopN} Members`;
        } else {
          // For default, highmarks, lowmarks, or simple pagination
          pageMembers = members.slice(offset, offset + pageSize);
        }

        const lastUpdatedFormatted = last ? `│⏱️ Last Update: ${formatDate(last)}` : "";

        // build list string (pretty)
        const listLines = pageMembers.map((m, i) => {
          const idx = limitTopN > 0 ? i + 1 : offset + i + 1;
          return `│${String(idx).padStart(3, " ")}. ${m.name} — ${m.rank || "N/A"} — *${m.marks ?? "0"}*`;
        });

        // --- Header Formatting ---
        let headerTitle = "MEMBERS MARKS LIST";
        if (sortOrder === "high" && limitTopN === 0) headerTitle = "MARKS LEADERBOARD (High to Low)";
        if (sortOrder === "low") headerTitle = "MARKS LIST (Low to High)";

        const header = `
╭─「 *${headerTitle}* 」
│ Total Members: ${members.length}
│ ${pageInfo}
${lastUpdatedFormatted ? `\n│${lastUpdatedFormatted}` : ""}
`.trimEnd();

        const footer = `
╰──────────●●►
`.trim();

        const caption = [header, ...listLines, footer].join("\n");

        const imgData = safeReadImage(MAIN_IMAGE_PATH);

        if (imgData) {
          await sock.sendMessage(from, {
            image: imgData,
            caption,
          });
        } else {
          // if image missing, fall back to text
          await sock.sendMessage(from, { text: caption });
        }

        return;
      }

      // you can add more commands below...
    } catch (err) {
      console.error("Error handling message:", err?.message || err);
    }
  });
  // =================================================
}

startBot().catch((e) => {
  console.error("Failed to start bot:", e?.message || e);
});