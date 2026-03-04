'use strict';
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const crypto   = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout:  25000,
});

const MAX_PER_ROOM = 12;

const COLORS = [
  '#FF6B6B','#FFB347','#FFD700','#7BC67E','#6EC6FF',
  '#CE93D8','#F48FB1','#80DEEA','#FFAB91','#C5E1A5','#90CAF9','#EF9A9A',
];

/*
  PHASE MACHINE:
  'waiting'         → turn player picks a target
  'challenger_roll' → challenger clicks "Zər At"
  'target_roll'     → target clicks "Zər At"
  'winner_writing'  → winner types truth/dare question
  'loser_answering' → loser types their answer
  'showing'         → Q&A shown to all (auto-advance 4s)
*/

const rooms   = new Map();
let   roomSeq = 1;

function makeRoom(id) {
  return {
    id,
    players:        new Map(),
    turnIndex:      0,
    messages:       [],
    created:        Date.now(),
    phase:          'waiting',
    challengerId:   null,
    targetId:       null,
    challengerRoll: null,
    targetRoll:     null,
    winnerId:       null,
    loserId:        null,
    challengeType:  null,
    challengeText:  null,
    duelId:         null,
  };
}

function findOrCreateRoom() {
  for (const [, room] of rooms) {
    if (room.players.size < MAX_PER_ROOM) return room;
  }
  const id = roomSeq++;
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
    roomId:         room.id,
    players:        list,
    currentTurn:    curr ? curr.id : null,
    phase:          room.phase,
    challengerId:   room.challengerId,
    targetId:       room.targetId,
    challengerRoll: room.challengerRoll,
    targetRoll:     room.targetRoll,
    winnerId:       room.winnerId,
    loserId:        room.loserId,
    challengeType:  room.challengeType,
    challengeText:  room.challengeText,
    duelId:         room.duelId,
  });
}

function addMsg(room, msg) {
  room.messages.push(msg);
  if (room.messages.length > 150) room.messages.shift();
  io.to('room:' + room.id).emit('new_msg', msg);
}

function resetDuel(room) {
  room.phase          = 'waiting';
  room.challengerId   = null;
  room.targetId       = null;
  room.challengerRoll = null;
  room.targetRoll     = null;
  room.winnerId       = null;
  room.loserId        = null;
  room.challengeType  = null;
  room.challengeText  = null;
  room.duelId         = null;
}

function advanceTurn(room) {
  const cnt = room.players.size;
  if (cnt > 0) room.turnIndex = (room.turnIndex + 1) % cnt;
  resetDuel(room);
}

/* ─────────────────── SOCKET EVENTS ─────────────────── */
io.on('connection', (socket) => {

  socket.on('join', ({ name } = {}, cb) => {
    const playerName = (name || 'Oyuncu').slice(0, 24);
    const room = findOrCreateRoom();

    const usedSlots = new Set([...room.players.values()].map(p => p.slot));
    let slot = 1;
    while (usedSlots.has(slot)) slot++;

    const player = {
      id:      socket.id,
      name:    playerName,
      color:   COLORS[(slot - 1) % COLORS.length],
      slot,
      avatar:  playerName.charAt(0).toUpperCase(),
      joinedAt:Date.now(),
      wins:    0,
      losses:  0,
    };

    room.players.set(socket.id, player);
    socket.join('room:' + room.id);
    socket.data.roomId = room.id;

    socket.emit('history', room.messages);

    addMsg(room, {
      id: crypto.randomUUID(), type: 'system',
      body: `🎲 ${playerName} oyuna qatıldı!`,
    });

    broadcastState(room);
    cb?.({ ok: true, roomId: room.id, slot, color: player.color, myId: socket.id });
  });

  /* Challenger selects target */
  socket.on('select_target', ({ targetId } = {}, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false, e: 'Otaq yoxdur' });

    const curr = currentTurnPlayer(room);
    if (!curr || curr.id !== socket.id)
      return cb?.({ ok: false, e: 'Sizin növbəniz deyil' });
    if (room.phase !== 'waiting')
      return cb?.({ ok: false, e: 'Yanlış mərhələ' });
    if (targetId === socket.id)
      return cb?.({ ok: false, e: 'Özünüzü seçə bilməzsiniz' });

    const target = room.players.get(targetId);
    if (!target) return cb?.({ ok: false, e: 'Oyunçu tapılmadı' });

    room.challengerId = socket.id;
    room.targetId     = targetId;
    room.phase        = 'challenger_roll';
    room.duelId       = crypto.randomUUID();

    addMsg(room, {
      id: crypto.randomUUID(), type: 'system',
      body: `⚔️ ${curr.name} vs ${target.name} — Düello başlayır!`,
    });

    broadcastState(room);
    cb?.({ ok: true });
  });

  /* Roll dice — works for both challenger and target */
  socket.on('roll', ({} = {}, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false, e: 'Otaq yoxdur' });

    const die = () => Math.floor(Math.random() * 6) + 1;

    if (room.phase === 'challenger_roll' && socket.id === room.challengerId) {
      const die1 = die(), die2 = die();
      room.challengerRoll = { die1, die2, total: die1 + die2 };
      room.phase = 'target_roll';
      broadcastState(room);
      cb?.({ ok: true, die1, die2, total: die1 + die2 });

    } else if (room.phase === 'target_roll' && socket.id === room.targetId) {
      const die1 = die(), die2 = die();
      room.targetRoll = { die1, die2, total: die1 + die2 };

      const cT = room.challengerRoll.total;
      const tT = die1 + die2;

      // challenger wins on draw (home-field advantage)
      room.winnerId = cT >= tT ? room.challengerId : room.targetId;
      room.loserId  = cT >= tT ? room.targetId     : room.challengerId;
      room.phase    = 'winner_writing';

      const w = room.players.get(room.winnerId);
      const l = room.players.get(room.loserId);
      if (w) w.wins   = (w.wins   || 0) + 1;
      if (l) l.losses = (l.losses || 0) + 1;

      const drawStr = cT === tT ? ' (bərabər — challenger qalib)' : '';
      addMsg(room, {
        id: crypto.randomUUID(), type: 'system',
        body: `🎯 ${room.players.get(room.challengerId)?.name} ${cT} ↔ ${tT} ${room.players.get(room.targetId)?.name}${drawStr} — 🏆 ${w?.name} qazandı!`,
      });

      broadcastState(room);
      cb?.({ ok: true, die1, die2, total: tT });

    } else {
      cb?.({ ok: false, e: 'Bu anda zər ata bilməzsiniz' });
    }
  });

  /* Winner sends the challenge question/task */
  socket.on('send_challenge', ({ type, text } = {}, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false, e: 'Otaq yoxdur' });
    if (room.phase !== 'winner_writing') return cb?.({ ok: false, e: 'Yanlış mərhələ' });
    if (socket.id !== room.winnerId) return cb?.({ ok: false, e: 'Yalnız qalib yaza bilər' });

    const trimmed = (text || '').trim().slice(0, 400);
    if (!trimmed) return cb?.({ ok: false, e: 'Mətn boş ola bilməz' });
    if (!['truth', 'dare'].includes(type)) return cb?.({ ok: false, e: 'Növ seçin' });

    room.challengeType = type;
    room.challengeText = trimmed;
    room.phase         = 'loser_answering';

    const w = room.players.get(room.winnerId);
    const l = room.players.get(room.loserId);
    const label = type === 'truth' ? '🔍 Doğruluq' : '🔥 Cəsarət';

    addMsg(room, {
      id: crypto.randomUUID(), type: 'challenge',
      label,
      from: w?.name, fromColor: w?.color,
      to:   l?.name, toColor:   l?.color,
      challengeType: type,
      body: trimmed,
    });

    broadcastState(room);
    cb?.({ ok: true });
  });

  /* Loser sends their answer */
  socket.on('send_answer', ({ text } = {}, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false, e: 'Otaq yoxdur' });
    if (room.phase !== 'loser_answering') return cb?.({ ok: false, e: 'Yanlış mərhələ' });
    if (socket.id !== room.loserId) return cb?.({ ok: false, e: 'Yalnız məğlub cavab verə bilər' });

    const trimmed = (text || '').trim().slice(0, 600);
    if (!trimmed) return cb?.({ ok: false, e: 'Cavab boş ola bilməz' });

    const w = room.players.get(room.winnerId);
    const l = room.players.get(room.loserId);
    const label = room.challengeType === 'truth' ? '🔍 Doğruluq' : '🔥 Cəsarət';

    addMsg(room, {
      id: crypto.randomUUID(), type: 'answer',
      label,
      from: w?.name, fromColor: w?.color,
      to:   l?.name, toColor:   l?.color,
      challengeType: room.challengeType,
      question: room.challengeText,
      answer:   trimmed,
    });

    room.phase = 'showing';
    broadcastState(room);
    cb?.({ ok: true });

    setTimeout(() => {
      if (!rooms.has(room.id) || room.phase !== 'showing') return;
      advanceTurn(room);
      broadcastState(room);
    }, 5000);
  });

  /* Loser skips */
  socket.on('skip_answer', ({} = {}, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'loser_answering') return cb?.({ ok: false });
    if (socket.id !== room.loserId) return cb?.({ ok: false });

    const l = room.players.get(room.loserId);
    addMsg(room, {
      id: crypto.randomUUID(), type: 'system',
      body: `😅 ${l?.name} cavab vermədi!`,
    });

    advanceTurn(room);
    broadcastState(room);
    cb?.({ ok: true });
  });

  /* Chat */
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

  /* Disconnect / Leave */
  function leaveRoom() {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    room.players.delete(socket.id);
    socket.data.roomId = null;

    addMsg(room, {
      id: crypto.randomUUID(), type: 'system',
      body: `👋 ${player.name} ayrıldı`,
    });

    if (room.players.size === 0) { rooms.delete(room.id); return; }

    const wasInDuel = socket.id === room.challengerId || socket.id === room.targetId;
    if (wasInDuel && !['waiting', 'showing'].includes(room.phase)) {
      addMsg(room, {
        id: crypto.randomUUID(), type: 'system',
        body: `⚠️ Düello ləğv edildi — ${player.name} ayrıldı`,
      });
      advanceTurn(room);
    } else {
      room.turnIndex = room.turnIndex % room.players.size;
    }

    broadcastState(room);
  }

  socket.on('leave', leaveRoom);
  socket.on('disconnect', leaveRoom);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎲 Zar Oyunu v2 → http://localhost:${PORT}`));
