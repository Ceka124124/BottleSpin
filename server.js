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
  PHASE MACHINE
  ─────────────────────────────────────────────────────────────────
  'waiting'        → raund başlamayıb, "Zər At" düyməsini gözləyir
  'rolling'        → hamı zər atır (kim atmayıb hələ gözlənir)
  'winner_writing' → qalib hər məğluba ayrı sual/tapşırıq yazır
  'losers_answer'  → məğlublar cavab verir (hamı bitincə irəli)
  'showing'        → nəticələr göstərilir (4s) sonra yeni raund
  ─────────────────────────────────────────────────────────────────

  challenges: Map<loserId, { type, text, answer, answered }>
*/

const rooms   = new Map();
let   roomSeq = 1;

function makeRoom(id) {
  return {
    id,
    players:    new Map(),
    messages:   [],
    created:    Date.now(),
    round:      0,
    phase:      'waiting',
    rolls:      new Map(),   // socketId → { die1, die2, total }
    winnerId:   null,
    challenges: new Map(),   // loserId  → { type, text, answer, answered }
    roundId:    null,
  };
}

function findOrCreateRoom() {
  for (const [, r] of rooms) {
    if (r.players.size < MAX_PER_ROOM) return r;
  }
  const id = roomSeq++;
  const r  = makeRoom(id);
  rooms.set(id, r);
  return r;
}

function roomPlayers(room) {
  return [...room.players.values()].sort((a, b) => a.slot - b.slot);
}

function broadcastState(room) {
  const list    = roomPlayers(room);
  const rolls   = Object.fromEntries(room.rolls);
  const challs  = Object.fromEntries(
    [...room.challenges.entries()].map(([lid, v]) => [lid, {
      type:     v.type,
      text:     v.text,
      answer:   v.answer,
      answered: v.answered,
    }])
  );
  io.to('room:' + room.id).emit('state', {
    roomId:     room.id,
    players:    list,
    phase:      room.phase,
    rolls,
    winnerId:   room.winnerId,
    challenges: challs,
    roundId:    room.roundId,
    round:      room.round,
    waitingRolls: [...room.players.keys()].filter(id => !room.rolls.has(id)),
  });
}

function addMsg(room, msg) {
  room.messages.push(msg);
  if (room.messages.length > 200) room.messages.shift();
  io.to('room:' + room.id).emit('new_msg', msg);
}

function resetRound(room) {
  room.phase      = 'waiting';
  room.rolls      = new Map();
  room.winnerId   = null;
  room.challenges = new Map();
  room.roundId    = null;
}

/* ─────────────────────────────────────────────────── */
io.on('connection', (socket) => {

  /* JOIN */
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
      wins:    0,
      losses:  0,
    };

    room.players.set(socket.id, player);
    socket.join('room:' + room.id);
    socket.data.roomId = room.id;
    socket.emit('history', room.messages);

    addMsg(room, { id: crypto.randomUUID(), type: 'system',
      body: `🎲 ${playerName} oyuna qatıldı!` });

    broadcastState(room);
    cb?.({ ok: true, roomId: room.id, slot, color: player.color, myId: socket.id });
  });

  /* ROLL — player rolls their own dice */
  socket.on('roll', ({} = {}, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false, e: 'Otaq yoxdur' });
    if (!['waiting', 'rolling'].includes(room.phase))
      return cb?.({ ok: false, e: 'Bu mərhələdə zər atmaq olmaz' });
    if (room.rolls.has(socket.id))
      return cb?.({ ok: false, e: 'Artıq atdınız' });
    if (room.players.size < 2)
      return cb?.({ ok: false, e: 'Ən az 2 oyunçu lazımdır' });

    const die1  = Math.floor(Math.random() * 6) + 1;
    const die2  = Math.floor(Math.random() * 6) + 1;
    const total = die1 + die2;

    room.rolls.set(socket.id, { die1, die2, total });
    room.phase = 'rolling';

    cb?.({ ok: true, die1, die2, total });

    // Check if everyone rolled
    if (room.rolls.size === room.players.size) {
      resolveRolls(room);
    } else {
      broadcastState(room);
    }
  });

  function resolveRolls(room) {
    // Find winner = highest total (tie → highest slot wins)
    let best = -1, winnerId = null;
    for (const [sid, roll] of room.rolls) {
      const p = room.players.get(sid);
      if (!p) continue;
      if (roll.total > best || (roll.total === best && p.slot < room.players.get(winnerId)?.slot)) {
        best     = roll.total;
        winnerId = sid;
      }
    }

    room.winnerId = winnerId;
    room.phase    = 'winner_writing';
    room.round++;
    room.roundId  = crypto.randomUUID();

    const winner = room.players.get(winnerId);
    if (winner) winner.wins = (winner.wins || 0) + 1;

    // Init challenge slots for each loser
    for (const [sid] of room.players) {
      if (sid === winnerId) continue;
      const p = room.players.get(sid);
      if (p) p.losses = (p.losses || 0) + 1;
      room.challenges.set(sid, { type: null, text: null, answer: null, answered: false });
    }

    // Announce
    const rollSummary = roomPlayers(room)
      .map(p => {
        const r = room.rolls.get(p.id);
        return r ? `${p.name}: ${r.total}` : `${p.name}: —`;
      }).join(' · ');

    addMsg(room, { id: crypto.randomUUID(), type: 'system',
      body: `🎲 ${rollSummary}` });
    addMsg(room, { id: crypto.randomUUID(), type: 'system',
      body: `🏆 ${winner?.name} qazandı! İndi hər kəsə sual yazır...` });

    broadcastState(room);
  }

  /* SEND CHALLENGE — winner writes per-loser challenge */
  socket.on('send_challenge', ({ loserId, type, text } = {}, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false, e: 'Otaq yoxdur' });
    if (room.phase !== 'winner_writing') return cb?.({ ok: false, e: 'Yanlış mərhələ' });
    if (socket.id !== room.winnerId) return cb?.({ ok: false, e: 'Siz qalib deyilsiniz' });

    const ch = room.challenges.get(loserId);
    if (!ch) return cb?.({ ok: false, e: 'Oyunçu tapılmadı' });

    const trimmed = (text || '').trim().slice(0, 400);
    if (!trimmed) return cb?.({ ok: false, e: 'Mətn boş ola bilməz' });
    if (!['truth', 'dare'].includes(type)) return cb?.({ ok: false, e: 'Növ seçin' });

    ch.type = type;
    ch.text = trimmed;

    const winner = room.players.get(room.winnerId);
    const loser  = room.players.get(loserId);
    const label  = type === 'truth' ? '🔍 Doğruluq' : '🔥 Cəsarət';

    addMsg(room, { id: crypto.randomUUID(), type: 'challenge',
      label, challengeType: type,
      from: winner?.name, fromColor: winner?.color,
      to:   loser?.name,  toColor:   loser?.color,
      loserId,
      body: trimmed,
    });

    // Check if all challenges written
    const allWritten = [...room.challenges.values()].every(c => c.text !== null);
    if (allWritten) {
      room.phase = 'losers_answer';
      addMsg(room, { id: crypto.randomUUID(), type: 'system',
        body: '💬 Hamı cavab versin!' });
    }

    broadcastState(room);
    cb?.({ ok: true });
  });

  /* SEND ANSWER — loser answers their challenge */
  socket.on('send_answer', ({ text } = {}, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false, e: 'Otaq yoxdur' });
    if (room.phase !== 'losers_answer') return cb?.({ ok: false, e: 'Yanlış mərhələ' });

    const ch = room.challenges.get(socket.id);
    if (!ch) return cb?.({ ok: false, e: 'Siz məğlub deyilsiniz' });
    if (ch.answered) return cb?.({ ok: false, e: 'Artıq cavabladınız' });

    const trimmed = (text || '').trim().slice(0, 600);
    if (!trimmed) return cb?.({ ok: false, e: 'Cavab boş ola bilməz' });

    ch.answer   = trimmed;
    ch.answered = true;

    const winner = room.players.get(room.winnerId);
    const loser  = room.players.get(socket.id);
    const label  = ch.type === 'truth' ? '🔍 Doğruluq' : '🔥 Cəsarət';

    addMsg(room, { id: crypto.randomUUID(), type: 'answer',
      label, challengeType: ch.type,
      from: winner?.name, fromColor: winner?.color,
      to:   loser?.name,  toColor:   loser?.color,
      loserId: socket.id,
      question: ch.text,
      answer:   trimmed,
    });

    broadcastState(room);
    cb?.({ ok: true });

    // If all answered → showing
    const allDone = [...room.challenges.values()].every(c => c.answered);
    if (allDone) {
      room.phase = 'showing';
      broadcastState(room);
      setTimeout(() => {
        if (!rooms.has(room.id) || room.phase !== 'showing') return;
        resetRound(room);
        broadcastState(room);
      }, 5000);
    }
  });

  /* SKIP ANSWER */
  socket.on('skip_answer', ({} = {}, cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'losers_answer') return cb?.({ ok: false });

    const ch = room.challenges.get(socket.id);
    if (!ch || ch.answered) return cb?.({ ok: false });

    const loser = room.players.get(socket.id);
    ch.answer   = '😅 Cavab vermədi';
    ch.answered = true;

    addMsg(room, { id: crypto.randomUUID(), type: 'system',
      body: `😅 ${loser?.name} cavab vermədi!` });

    broadcastState(room);
    cb?.({ ok: true });

    const allDone = [...room.challenges.values()].every(c => c.answered);
    if (allDone) {
      room.phase = 'showing';
      broadcastState(room);
      setTimeout(() => {
        if (!rooms.has(room.id) || room.phase !== 'showing') return;
        resetRound(room);
        broadcastState(room);
      }, 5000);
    }
  });

  /* CHAT */
  socket.on('msg', ({ text } = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const body = (text || '').trim().slice(0, 300);
    if (!body) return;
    addMsg(room, { id: crypto.randomUUID(), type: 'chat',
      name: player.name, color: player.color, avatar: player.avatar, body });
  });

  /* DISCONNECT */
  function leaveRoom() {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    room.players.delete(socket.id);
    socket.data.roomId = null;

    addMsg(room, { id: crypto.randomUUID(), type: 'system',
      body: `👋 ${player.name} ayrıldı` });

    if (room.players.size === 0) { rooms.delete(room.id); return; }

    // If this was the winner during writing phase — reset
    if (socket.id === room.winnerId && room.phase === 'winner_writing') {
      addMsg(room, { id: crypto.randomUUID(), type: 'system',
        body: '⚠️ Qalib ayrıldı — raund ləğv edildi' });
      resetRound(room);
    }
    // If a loser left during answering — mark as answered
    else if (room.phase === 'losers_answer' && room.challenges.has(socket.id)) {
      const ch = room.challenges.get(socket.id);
      if (!ch.answered) { ch.answer = '—'; ch.answered = true; }
      const allDone = [...room.challenges.values()].every(c => c.answered);
      if (allDone) {
        room.phase = 'showing';
        setTimeout(() => {
          if (!rooms.has(room.id) || room.phase !== 'showing') return;
          resetRound(room);
          broadcastState(room);
        }, 5000);
      }
    }
    // If was rolling and not yet rolled — check if everyone else rolled
    else if (room.phase === 'rolling' && !room.rolls.has(socket.id)) {
      if (room.rolls.size === room.players.size) resolveRolls(room);
    }

    broadcastState(room);
  }

  socket.on('leave', leaveRoom);
  socket.on('disconnect', leaveRoom);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎲 Zar Oyunu v3 → http://localhost:${PORT}`));
