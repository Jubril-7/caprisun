import pino from 'pino';
import express from 'express';
import { config } from './config.js';
import { getRole, isGroupApproved } from './middlewares/roles.js';
import { sendReaction } from './middlewares/reactions.js';
import { logMessage } from './utils/logger.js';
import { loadStorage, saveStorage } from './utils/storage.js';
import systemCommands from './commands/system.js';
import adminCommands from './commands/admin.js';
import mediaCommands from './commands/media.js';
import hangmanCommands from './commands/games/hangman.js';
import tictactoeCommands from './commands/games/tictactoe.js';
import wordgameCommands from './commands/games/wordgame.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('🤖¢əρяιѕυη WhatsApp Bot is running fine!'));
app.listen(PORT, () => console.log(`✅ Health check server started on port ${PORT}`));

let sock;

async function handleWarningKick(chatId, sender, storage) {
    try {
        const role = await getRole(sock, sender, chatId, storage);
        if (role !== 'owner') {
            await sock.groupParticipantsUpdate(chatId, [sender], 'remove');
            await sock.sendMessage(chatId, { text: `@${sender.split('@')[0]} has been kicked for reaching 3 warnings.`, mentions: [sender] });
            await logMessage('info', `User ${sender} kicked from ${chatId} for reaching 3 warnings`);
        }
        delete storage.warnings[sender];
        await saveStorage(storage);
    } catch (error) {
        await logMessage('error', `Failed to kick ${sender} for warnings: ${error.message}`);
    }
}

const ADMIN_COMMANDS = new Set(['admin', 'groupinfo', 'grouplink', 'kick', 'promote', 'demote', 'add', 'close', 'open', 'welcome', 'setwelcome', 'warn', 'warnings', 'clearwarn', 'delete', 'antilink', 'tag']);
const OWNER_COMMANDS = new Set(['ban', 'unban', 'accept', 'reject', 'status', 'setprefix']);

async function connectToWhatsApp() {
    const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = await import('@whiskeysockets/baileys');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && !sock.user) {
            console.log('QR Code:', qr);
        }
        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                await connectToWhatsApp();
            } else {
                console.log('Connection closed. Please delete auth_info folder and rescan QR.');
            }
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp');
            await logMessage('info', 'Connected to WhatsApp');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message) return;

            const chatId = msg.key.remoteJid;
            const isGroup = chatId.endsWith('@g.us');
            const sender = msg.key.fromMe ? sock.user.id : (msg.key.participant || msg.key.remoteJid);
            const fromMe = msg.key.fromMe;

            const storage = await loadStorage();
            let prefix = storage.prefix || config.prefix;

            const approved = await isGroupApproved(chatId, storage);
            if (isGroup && !approved) {
                if (msg.message.conversation?.startsWith(`${prefix}alive`)) {
                    await handleUnapprovedGroup(sock, msg, chatId, storage);
                }
                return;
            }

            const role = await getRole(sock, sender, chatId, storage);
            if (role === 'banned' && !fromMe) return;

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            if (!text.startsWith(prefix)) {
                if (isGroup && storage.groups[chatId]?.antilink === 'on') {
                    if (text.includes('http://') || text.includes('https://')) {
                        await handleAntilink(sock, msg, chatId, sender, storage);
                    }
                }
                return;
            }

            const [command, ...args] = text.slice(prefix.length).trim().split(/\s+/);
            const commandLower = command.toLowerCase();

            if (OWNER_COMMANDS.has(commandLower) && role !== 'owner') {
                await sendReaction(sock, msg, '❌');
                await sock.sendMessage(chatId, { text: '❌ This command is for bot owners only.' });
                return;
            }

            if (ADMIN_COMMANDS.has(commandLower) && role !== 'admin' && role !== 'owner') {
                await sendReaction(sock, msg, '❌');
                await sock.sendMessage(chatId, { text: '❌ This command is for group admins only.' });
                return;
            }

            let handled = await systemCommands(sock, msg, commandLower, args, storage, sender, chatId, role, prefix);
            if (handled) return;

            handled = await adminCommands(sock, msg, commandLower, args, storage, sender, chatId, role, prefix);
            if (handled) return;

            handled = await mediaCommands(sock, msg, commandLower, args, storage, sender, chatId, role);
            if (handled) return;

            handled = await hangmanCommands(sock, msg, commandLower, args, storage, sender, chatId, role, prefix);
            if (handled) return;

            handled = await tictactoeCommands(sock, msg, commandLower, args, storage, sender, chatId, role, prefix);
            if (handled) return;

            handled = await wordgameCommands(sock, msg, commandLower, args, storage, sender, chatId, role, prefix);
            if (handled) return;

            if (!handled) {
                await sendReaction(sock, msg, '❌');
                await sock.sendMessage(chatId, { text: `Unknown command: ${command}. Type ${prefix}help for available commands.` });
            }
        } catch (err) {
            if (String(err).includes('Bad MAC') || String(err).includes('decrypt')) {
                console.warn('⚠️ Ignored Bad MAC/decrypt error');
            } else {
                console.error('❌ messages.upsert error:', err);
            }
        }
    });

    sock.ev.on('group-participants.update', async ({ id: chatId, participants, action }) => {
        const storage = await loadStorage();
        if (action === 'add' && storage.groups[chatId]?.welcome === 'on') {
            const welcomeMsg = storage.groups[chatId]?.welcomeMessage || 'Welcome to the group! Intro...';
            for (const participant of participants) {
                // Extract the JID from participant object
                const participantJid = participant.id || participant;
                const participantNumber = participantJid.split('@')[0];
                await sock.sendMessage(chatId, {
                    text: `${welcomeMsg} @${participantNumber}`,
                    mentions: [participantJid]
                });
            }
        }
    });
}

async function handleUnapprovedGroup(sock, msg, chatId, storage) {
    try {
        const groupMeta = await sock.groupMetadata(chatId);
        const groupName = groupMeta.subject;
        await sock.sendMessage(chatId, { text: 'This group is not approved. Request sent to control group.' });
        await sock.sendMessage(config.controlGroupId, {
            text: `New group request:\nName: ${groupName}\nID: ${chatId}\nUse ${config.prefix}accept ${chatId} or ${config.prefix}reject ${chatId}`
        });
    } catch (error) {
        await logMessage('error', `Failed to handle unapproved group ${chatId}: ${error.message}`);
    }
}

async function handleAntilink(sock, msg, chatId, sender, storage) {
    const warnings = storage.warnings[sender] || 0;
    storage.warnings[sender] = warnings + 1;
    await saveStorage(storage);

    await sock.sendMessage(chatId, { text: `@${sender.split('@')[0]}, links are not allowed. Warning ${warnings + 1}/3.`, mentions: [sender] });
    await sock.sendMessage(chatId, { delete: msg.key });

    if (storage.warnings[sender] >= 3) {
        await handleWarningKick(chatId, sender, storage);
    }
}

connectToWhatsApp().catch(console.error);

process.on('uncaughtException', (err) => {
    if (String(err).includes('Bad MAC') || String(err).includes('decrypt')) {
        console.warn('⚠️ Ignored uncaught decrypt error');
    } else {
        console.error('❌ Uncaught Exception:', err);
    }
});

process.on('unhandledRejection', (reason) => {
    if (String(reason).includes('Bad MAC') || String(reason).includes('decrypt')) {
        console.warn('⚠️ Ignored unhandled decrypt rejection');
    } else {
        console.error('❌ Unhandled Rejection:', reason);
    }
});