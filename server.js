'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout:  25000,
});

/* ═══════════════════════════════════════════
   IN-MEMORY STATE
═══════════════════════════════════════════ */
const MAX_PER_ROOM = 12;

// rooms: Map<roomId, Room>
// Room = { id, players: Map<socketId, Player>, turnIndex, spinning, messages, created }
// Player = { id (socketId), name, color, slot, avatar, joinedAt }

const rooms   = new Map();
let   roomSeq = 1;

function makeRoom(id) {
  return {
    id,
    players:    new Map(), // socketId → Player
    turnIndex:  0,
    spinning:   false,
    messages:   [],
    created:    Date.now(),
  };
}

function findOrCreateRoom() {
  // Find a room with < MAX_PER_ROOM players
  for (const [, room] of rooms) {
    if (room.players.size < MAX_PER_ROOM) return room;
  }
  const id   = roomSeq++;
  const room = makeRoom(id);
  rooms.set(id, room);
  return room;
}

function roomPlayers(room) {
  return [...room.players.values()].sort((a, b) => a.slot - b.slot);
}

function currentTurnPlayer(room) {
  const list = roomPlayers(room);
  if (!list.length) return null;
  return list[room.turnIndex % list.length];
}

function broadcastState(room) {
  const list = roomPlayers(room);
  const curr = currentTurnPlayer(room);
  io.to('room:' + room.id).emit('state', {
    roomId:       room.id,
    players:      list,
    currentTurn:  curr ? curr.id : null,
    spinning:     room.spinning,
    playerCount:  list.length,
  });
}

function addMsg(room, msg) {
  room.messages.push(msg);
  if (room.messages.length > 120) room.messages.shift();
  io.to('room:' + room.id).emit('new_msg', msg);
}

const COLORS = [
  '#FF6B6B','#FFB347','#FFD700','#7BC67E','#6EC6FF',
  '#CE93D8','#F48FB1','#80DEEA','#FFAB91','#C5E1A5','#90CAF9','#EF9A9A',
];

/* ═══════════════════════════════════════════
   SOCKET EVENTS
═══════════════════════════════════════════ */
io.on('connection', (socket) => {

  // join: { name }
  socket.on('join', ({ name } = {}, cb) => {
    const playerName = (name || 'Oyuncu').slice(0, 24);
    const room = findOrCreateRoom();

    // Assign slot (1-based, smallest free)
    const usedSlots = new Set([...room.players.values()].map(p => p.slot));
    let slot = 1;
    while (usedSlots.has(slot)) slot++;

    const color  = COLORS[(slot - 1) % COLORS.length];
    const player = {
      id:       socket.id,
      name:     playerName,
      color,
      slot,
      avatar:   playerName.charAt(0).toUpperCase(),
      joinedAt: Date.now(),
    };

    room.players.set(socket.id, player);
    socket.join('room:' + room.id);
    socket.data.roomId = room.id;

    // Send chat history
    socket.emit('history', room.messages);

    addMsg(room, {
      id:   crypto.randomUUID(),
      type: 'system',
      body: `🎲 ${playerName} oyuna qatıldı!`,
    });

    broadcastState(room);
    cb?.({ ok: true, roomId: room.id, slot, color });
  });

  // spin — only current turn player may spin
  socket.on('spin', ({}, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false, e: 'Otaq tapılmadı' });
    if (room.spinning) return cb?.({ ok: false, e: 'Artıq fırlanır' });

    const curr = currentTurnPlayer(room);
    if (!curr || curr.id !== socket.id)
      return cb?.({ ok: false, e: 'Sizin növbəniz deyil' });

    // Roll two dice (1-6 each)
    const die1  = Math.floor(Math.random() * 6) + 1;
    const die2  = Math.floor(Math.random() * 6) + 1;
    const total = die1 + die2;

    // Pick a random OTHER player as target
    const others = roomPlayers(room).filter(p => p.id !== socket.id);
    const target = others.length ? others[Math.floor(Math.random() * others.length)] : null;

    // Decide challenge type based on total (odd=truth, even=dare — fun rule)
    const challengeType = total % 2 === 0 ? 'dare' : 'truth';

    room.spinning = true;
    broadcastState(room);

    io.to('room:' + room.id).emit('spin', {
      die1,
      die2,
      total,
      spinner:       curr,
      target:        target || curr,
      challengeType,
    });

    addMsg(room, {
      id:   crypto.randomUUID(),
      type: 'system',
      body: `🎲 ${curr.name}: ${die1}+${die2}=${total} → ${target ? target.name : '—'} (${challengeType === 'truth' ? '🔍 Doğruluq' : '🔥 Cəsarət'})`,
    });

    // Advance turn after animation (3.5 s)
    setTimeout(() => {
      if (!room) return;
      room.spinning   = false;
      room.turnIndex  = (room.turnIndex + 1) % Math.max(1, room.players.size);
      broadcastState(room);
    }, 3600);

    cb?.({ ok: true });
  });

  // chat message
  socket.on('msg', ({ text } = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const body = (text || '').trim().slice(0, 300);
    if (!body) return;
    addMsg(room, {
      id:    crypto.randomUUID(),
      type:  'chat',
      name:  player.name,
      color: player.color,
      avatar:player.avatar,
      body,
    });
  });

  // challenge_done — current player done, skip to next
  socket.on('challenge_done', ({}, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false });
    broadcastState(room);
    cb?.({ ok: true });
  });

  // leave / disconnect
  function leaveRoom() {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) {
      room.players.delete(socket.id);
      addMsg(room, {
        id:   crypto.randomUUID(),
        type: 'system',
        body: `👋 ${player.name} ayrıldı`,
      });
      // Re-normalise turnIndex
      const cnt = room.players.size;
      if (cnt > 0) room.turnIndex = room.turnIndex % cnt;
      else {
        // Empty room — clean up
        rooms.delete(room.id);
        return;
      }
      broadcastState(room);
    }
    socket.data.roomId = null;
  }

  socket.on('leave', leaveRoom);
  socket.on('disconnect', leaveRoom);
});

/* ═══════════════════════════════════════════
   SERVE index.html
═══════════════════════════════════════════ */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎲 Zar Oyunu → http://localhost:${PORT}`));
