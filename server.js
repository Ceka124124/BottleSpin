/**
 * ╔══════════════════════════════════════════════════════╗
 * ║   🍾  ŞİŞƏ ÇEVİRMƏ  —  Socket.IO Game Server       ║
 * ║   Deploy : render.com (free tier)                    ║
 * ║   Stack  : Node.js + Express + Socket.IO             ║
 * ║   DB     : YOXDUR — tam in-memory                   ║
 * ║   Run    : node server.js                            ║
 * ╚══════════════════════════════════════════════════════╝
 */

'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors             : { origin: '*', methods: ['GET','POST'] },
  pingInterval     : 10000,
  pingTimeout      : 25000,
  maxHttpBufferSize: 1e6,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ══════════════════════════════════════════════════════
   STATIC DATA
══════════════════════════════════════════════════════ */
const COLORS = [
  '#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#ff9ff3',
  '#ff9f43','#a29bfe','#fd79a8','#00cec9','#ffeaa7',
  '#74b9ff','#55efc4',
];

const BOTTLES = [
  { id:1, name:'Limonad', link:'https://butilochka.cdnvideo.ru/bottle/bundle/300/b_lemonade_v2.base.webp?9', price:0    },
  { id:2, name:'Kola',    link:'https://butilochka.cdnvideo.ru/bottle/bundle/300/b_cola_v2.base.webp?9',     price:150  },
  { id:3, name:'Enerji',  link:'https://butilochka.cdnvideo.ru/bottle/bundle/300/b_energy_v2.base.webp?9',  price:300  },
  { id:4, name:'Viski',   link:'https://butilochka.cdnvideo.ru/bottle/bundle/300/b_whiskey_v2.base.webp?9', price:500  },
  { id:5, name:'Serob',   link:'https://butilochka.cdnvideo.ru/bottle/bundle/300/b_wine_v2.base.webp?9',    price:750  },
  { id:6, name:'VIP 💎',  link:'https://butilochka.cdnvideo.ru/bottle/bundle/300/b_vip_v2.base.webp?9',     price:2000 },
];

const GIFTS = [
  { id:1,  name:'Qirmizi gul',     link:'🌹', price:1    },
  { id:2,  name:'Opus',            link:'💋', price:5    },
  { id:3,  name:'Sokolad',         link:'🍫', price:8    },
  { id:4,  name:'Cicekler',        link:'💐', price:12   },
  { id:5,  name:'Oyuncaq ayi',     link:'🧸', price:20   },
  { id:6,  name:'Uzuk',            link:'💍', price:35   },
  { id:7,  name:'Urek qutusu',     link:'💝', price:50   },
  { id:8,  name:'Qizilgul destesi',link:'🌺', price:80   },
  { id:9,  name:'Tac',             link:'👑', price:120  },
  { id:10, name:'Brilyant',        link:'💎', price:200  },
  { id:11, name:'Avtomobil',       link:'🚗', price:300  },
  { id:12, name:'Teyyare',         link:'✈️', price:500  },
  { id:13, name:'Saray',           link:'🏰', price:800  },
  { id:14, name:'Unicorn',         link:'🦄', price:1500 },
  { id:15, name:'Kainat',          link:'🌌', price:3000 },
];

const HEART_PACKS = [
  { id:1, hearts:7000, stars:5000, bonus:40, icon:'🎁'  },
  { id:2, hearts:3125, stars:2500, bonus:25, icon:'🛢️' },
  { id:3, hearts:1200, stars:1000, bonus:20, icon:'🏺'  },
  { id:4, hearts:500,  stars:500,  bonus:0,  icon:'💰'  },
  { id:5, hearts:250,  stars:250,  bonus:0,  icon:'📦'  },
  { id:6, hearts:50,   stars:50,   bonus:0,  icon:'🔴'  },
];

const LEVEL_XP = [0,100,250,500,900,1400,2100,3000,4200,5800,8000];

/* ══════════════════════════════════════════════════════
   IN-MEMORY STATE
══════════════════════════════════════════════════════ */
const users   = new Map();   // tg_id  -> user obj
const rooms   = new Map();   // rid    -> room obj
const players = new Map();   // rid    -> Map(tg_id -> { tg_id, slot, join_order })
const msgs    = new Map();   // rid    -> msg[]
const sockMap = new Map();   // socket.id -> { tg_id, room_id }

let _msgId = 0;
const newMsgId = () => ++_msgId;

/* ── Pure helpers ── */
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i);
  return h | 0;
}

function nameColor(id) {
  return COLORS[Math.abs(hashStr(String(id))) % COLORS.length];
}

function calcLevel(xp) {
  for (let i = LEVEL_XP.length - 1; i >= 0; i--) {
    if (xp >= LEVEL_XP[i]) return i + 1;
  }
  return 1;
}

/* ── User ── */
function getUser(tg_id) {
  if (!users.has(tg_id)) {
    users.set(tg_id, {
      tg_id,
      username   : 'oyuncu',
      first_name : 'Istifadeci',
      photo_url  : '',
      name_color : nameColor(tg_id),
      hearts     : 50,
      stars      : 100,
      xp         : 0,
      level      : 1,
      wins       : 0,
      spins      : 0,
      kisses     : 0,
      sound_on   : 1,
      music_on   : 1,
      last_seen  : Date.now(),
    });
  }
  return users.get(tg_id);
}

function grantXP(tg_id, amount) {
  const u      = getUser(tg_id);
  u.xp         = (u.xp || 0) + amount;
  const newLvl = calcLevel(u.xp);
  const leveled = newLvl > u.level;
  u.level      = newLvl;
  return { leveled, level: newLvl };
}

/* ── Room helpers ── */
function roomPlayerMap(rid)  { return players.get(rid) || new Map(); }
function roomPlayerList(rid) { return [...roomPlayerMap(rid).values()]; }
function roomMsgList(rid)    { return msgs.get(rid) || []; }

function pushMsg(rid, msg) {
  if (!msgs.has(rid)) msgs.set(rid, []);
  const list = msgs.get(rid);
  list.push(msg);
  if (list.length > 300) list.splice(0, list.length - 300);
}

function sysMsg(rid, text) {
  const msg = {
    id         : newMsgId(),
    room_id    : rid,
    tg_id      : '',
    username   : '',
    photo_url  : '',
    name_color : '#aaa',
    body       : text,
    msg_type   : 'system',
    created_at : Date.now(),
  };
  pushMsg(rid, msg);
  io.to('room:' + rid).emit('new_msg', msg);
}

/* ── Slot / position helpers ── */
const SLOT_ANGLES = {
  1:330, 2:0,   3:30,  4:60,
  5:90,  6:120, 7:150, 8:180,
  9:210, 10:240,11:270,12:300,
};

function assignSlot(rid) {
  const taken = new Set(roomPlayerList(rid).map(p => p.slot));
  for (let i = 1; i <= 12; i++) if (!taken.has(i)) return i;
  return null;
}

function calcTargetSlot(angle, rid, skipSlot) {
  const norm   = ((angle % 360) + 360) % 360;
  const others = roomPlayerList(rid).filter(p => p.slot !== skipSlot);
  if (!others.length) return skipSlot;
  let best = skipSlot, min = Infinity;
  for (const p of others) {
    const sa = SLOT_ANGLES[p.slot] ?? 0;
    let d    = Math.abs(norm - sa);
    if (d > 180) d = 360 - d;
    if (d < min) { min = d; best = p.slot; }
  }
  return best;
}

function nextTurnSlot(rid, curSlot) {
  const slots = roomPlayerList(rid).map(p => p.slot).sort((a, b) => a - b);
  if (!slots.length) return 1;
  const i = slots.indexOf(curSlot);
  return slots[i === -1 ? 0 : (i + 1) % slots.length];
}

function _joinRoom(rid, tg_id, join_order) {
  const slot = assignSlot(rid);
  if (slot === null) return null;
  const pm = players.get(rid);
  pm.set(tg_id, { tg_id, slot, join_order });
  const room = rooms.get(rid);
  if (room) {
    room.player_count = pm.size;
    if (pm.size === 1) room.current_turn_slot = slot;
    room.updated_at = Date.now();
  }
  return slot;
}

function buildPlayerList(rid) {
  return roomPlayerList(rid)
    .sort((a, b) => a.join_order - b.join_order)
    .map(p => {
      const u = users.get(p.tg_id) || {};
      return {
        slot       : p.slot,
        tg_id      : p.tg_id,
        join_order : p.join_order,
        first_name : u.first_name || '?',
        photo_url  : u.photo_url  || '',
        name_color : u.name_color || '#fff',
        level      : u.level      || 1,
        hearts     : u.hearts     || 0,
        kisses     : u.kisses     || 0,
      };
    });
}

function broadcastState(rid) {
  const room = rooms.get(rid);
  if (!room) return;
  io.to('room:' + rid).emit('state', {
    room    : { ...room },
    players : buildPlayerList(rid),
  });
}

function totalOnline() {
  let n = 0;
  rooms.forEach((_, rid) => { n += roomPlayerList(rid).length; });
  return n;
}

/* ══════════════════════════════════════════════════════
   AUTO CLEANUP
══════════════════════════════════════════════════════ */
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, rid) => {
    const pl = roomPlayerList(rid);

    // Remove empty rooms after 10 min
    if (pl.length === 0 && now - room.created_at > 10 * 60 * 1000) {
      rooms.delete(rid);
      players.delete(rid);
      msgs.delete(rid);
      return;
    }

    // Auto-resolve stuck spins after 35s
    if (room.spin_in_progress && now - room.spin_started_at > 35000) {
      console.log('[auto-reset stuck spin] room', rid);
      const next                = nextTurnSlot(rid, room.current_turn_slot);
      room.spin_in_progress     = false;
      room.spin_by              = '';
      room.spin_angle           = 0;
      room.spin_target_slot     = 0;
      room.current_turn_slot    = next;
      room.updated_at           = Date.now();
      sysMsg(rid, '⏰ Vaxt bitdi — spin ləğv edildi, növbə keçdi.');
      broadcastState(rid);
    }
  });
}, 30 * 1000);

/* ══════════════════════════════════════════════════════
   REST API  (/api/:action)   — PHP client uygunlugu
══════════════════════════════════════════════════════ */
app.get('/api/:action',  handleApiReq);
app.post('/api/:action', handleApiReq);

async function handleApiReq(req, res) {
  const p = { ...req.query, ...req.body, a: req.params.action };
  try   { res.json(await act(p, null)); }
  catch (e) { res.status(500).json({ error: e.message }); }
}

app.get('/', (req, res) => res.json({
  status : 'ok',
  game   : 'Sise Cevirme v6',
  online : totalOnline(),
  rooms  : rooms.size,
  uptime : Math.floor(process.uptime()) + 's',
}));

/* ══════════════════════════════════════════════════════
   CORE ACTION HANDLER
══════════════════════════════════════════════════════ */
async function act(p, socket) {
  switch (p.a) {

  /* ───── login ───── */
  case 'login': {
    const id = String(p.tg_id || ('g' + Math.floor(Math.random()*900000+100000)));
    const u  = getUser(id);
    if (p.username)   u.username   = String(p.username).substring(0,50);
    if (p.first_name) u.first_name = String(p.first_name).substring(0,60);
    if (p.photo_url)  u.photo_url  = String(p.photo_url).substring(0,500);
    u.last_seen = Date.now();
    return { ...u };
  }

  /* ───── rooms list ───── */
  case 'rooms': {
    const list = [];
    rooms.forEach((room, rid) => {
      const pc = roomPlayerList(rid).length;
      if (pc < room.max_players || room.status === 'playing')
        list.push({ ...room, player_count: pc });
    });
    return { rooms: list.sort((a,b)=>b.updated_at-a.updated_at).slice(0,25) };
  }

  /* ───── create room ───── */
  case 'create_room': {
    const id   = String(p.tg_id);
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const rid  = Date.now() + Math.floor(Math.random()*9999);
    rooms.set(rid, {
      id, code,
      name              : String(p.name || 'Otaq #' + code).substring(0,50),
      host_tg_id        : id,
      status            : 'waiting',
      current_turn_slot : 0,
      spin_in_progress  : false,
      spin_target_slot  : 0,
      spin_angle        : 0,
      spin_by           : '',
      spin_started_at   : 0,
      player_count      : 0,
      max_players       : 12,
      youtube_url       : '',
      youtube_start_time: 0,
      created_at        : Date.now(),
      updated_at        : Date.now(),
    });
    // overwrite id with numeric rid
    rooms.get(rid).id = rid;
    players.set(rid, new Map());
    const slot = _joinRoom(rid, id, 1);
    sysMsg(rid, '🏠 Otaq yaradildi! Kod: ' + code);
    return { ok:1, room_id:rid, code, slot, is_host:1 };
  }

  /* ───── join room ───── */
  case 'join_room': {
    const id  = String(p.tg_id);
    const rid = +p.room_id;
    if (!rooms.has(rid)) return { ok:0, error:'Otaq tapilmadi' };
    const pm = roomPlayerMap(rid);

    if (pm.has(id)) {
      // Reconnect
      if (socket) {
        socket.join('room:' + rid);
        socket.emit('history', roomMsgList(rid).slice(-50));
      }
      return { ok:1, room_id:rid, slot: pm.get(id).slot, rejoined:true };
    }

    const slot = _joinRoom(rid, id, pm.size + 1);
    if (!slot) return { ok:0, error:'Otaq dolu' };

    const u = getUser(id);
    if (socket) {
      socket.join('room:' + rid);
      socket.emit('history', roomMsgList(rid).slice(-50));
    }
    sysMsg(rid, '👋 ' + (u.first_name||'?') + ' otaga qosuldu!');
    broadcastState(rid);
    return { ok:1, room_id:rid, slot };
  }

  /* ───── leave room ───── */
  case 'leave_room': {
    const id  = String(p.tg_id);
    const rid = +p.room_id;
    const pm  = roomPlayerMap(rid);
    pm.delete(id);
    const room = rooms.get(rid);
    if (room) room.player_count = pm.size;
    const u = users.get(id);
    if (socket) socket.leave('room:' + rid);
    sysMsg(rid, '🚪 ' + (u?.first_name||'?') + ' ayrildi');
    broadcastState(rid);
    return { ok:1 };
  }

  /* ───── ping ───── */
  case 'ping': return { ok:1 };

  /* ───── state (polling fallback) ───── */
  case 'state': {
    const rid   = +p.room_id;
    const since = +(p.since||0);
    return {
      room     : rooms.get(rid),
      players  : buildPlayerList(rid),
      messages : roomMsgList(rid).filter(m => m.id > since),
    };
  }

  /* ───── chat message ───── */
  case 'msg': {
    const id  = String(p.tg_id);
    const rid = +p.room_id;
    const txt = String(p.text||'').substring(0,400)
                  .replace(/</g,'&lt;').replace(/>/g,'&gt;');
    if (!txt) return { ok:0 };
    const u   = getUser(id);
    const msg = {
      id         : newMsgId(), room_id:rid,
      tg_id      : id,
      username   : u.first_name || '?',
      photo_url  : u.photo_url  || '',
      name_color : u.name_color || '#fff',
      body       : txt,
      msg_type   : 'chat',
      created_at : Date.now(),
    };
    pushMsg(rid, msg);
    io.to('room:' + rid).emit('new_msg', msg);
    return { ok:1, msg_id: msg.id };
  }

  /* ───── reaction ───── */
  case 'reaction': {
    io.to('room:' + (+p.room_id)).emit('reaction', {
      tg_id : String(p.tg_id),
      emoji : String(p.emoji||'').substring(0,4),
      ts    : Date.now(),
    });
    return { ok:1 };
  }

  /* ───── spin ───── */
  case 'spin': {
    const id   = String(p.tg_id);
    const rid  = +p.room_id;
    const room = rooms.get(rid);

    if (!room)                           return { ok:0, e:'Otaq yoxdur' };
    if (room.spin_in_progress)           return { ok:0, e:'Spin artiq davam edir' };

    const pm  = roomPlayerMap(rid);
    const myP = pm.get(id);
    if (!myP)                            return { ok:0, e:'Siz bu otaqda deyilsiniz' };
    if (room.current_turn_slot !== myP.slot) return { ok:0, e:'Sizin novbeniz deyil' };
    if (roomPlayerList(rid).length < 2)  return { ok:0, e:'En az 2 oyuncu lazimdir' };

    const angle   = 1440 + Math.floor(Math.random() * 2160);
    const tgtSlot = calcTargetSlot(angle, rid, myP.slot);
    const tgtId   = roomPlayerList(rid).find(pp => pp.slot === tgtSlot)?.tg_id || null;

    room.spin_in_progress = true;
    room.spin_angle       = angle;
    room.spin_target_slot = tgtSlot;
    room.spin_by          = id;
    room.spin_started_at  = Date.now();
    room.status           = 'playing';
    room.updated_at       = Date.now();

    const u  = getUser(id);
    const tu = tgtId ? getUser(tgtId) : null;

    u.spins = (u.spins||0) + 1;
    const lvl = grantXP(id, 5);

    sysMsg(rid,
      '🍾 ' + (u.first_name||'?') +
      ' firlatti' + (tu ? ' → 💫 ' + (tu.first_name||'?') : '') + '!'
    );

    // Instantly push spin event to ALL clients
    io.to('room:' + rid).emit('spin', {
      angle,
      target_slot  : tgtSlot,
      target_tg_id : tgtId,
      spin_by      : id,
      spinner_name : u.first_name,
      target_name  : tu?.first_name || '?',
    });

    broadcastState(rid);

    const res = { ok:1, angle, target_slot:tgtSlot, target_tg_id:tgtId };
    if (lvl.leveled) res.level_up = lvl.level;
    return res;
  }

  /* ───── kiss / reject ───── */
  case 'kiss_reject': {
    const id   = String(p.tg_id);
    const rid  = +p.room_id;
    const ch   = p.choice;
    const room = rooms.get(rid);

    if (!room || !room.spin_in_progress) return { ok:0, e:'Aktiv spin yoxdur' };
    if (room.spin_by !== id)             return { ok:0, e:'Bu sizin spinınız deyil' };

    const tgtSlot = room.spin_target_slot;
    const tgtId   = roomPlayerList(rid).find(pp => pp.slot===tgtSlot)?.tg_id || null;
    const u       = getUser(id);
    const tu      = tgtId ? getUser(tgtId) : null;

    if (ch === 'kiss') {
      u.hearts = (u.hearts||0) + 1;
      u.kisses = (u.kisses||0) + 1;
      grantXP(id, 15);
      if (tu) { tu.hearts = (tu.hearts||0)+1; grantXP(tgtId, 8); }
      sysMsg(rid,
        '💋 ' + (u.first_name||'?') +
        ' ❤️ ' + (tu?.first_name||'?') + ' opdu! (+1❤️)'
      );
    } else {
      sysMsg(rid,
        '💔 ' + (u.first_name||'?') +
        ' → ' + (tu?.first_name||'?') + ' redd etdi!'
      );
    }

    const next = nextTurnSlot(rid, room.current_turn_slot);

    room.spin_in_progress  = false;
    room.spin_by           = '';
    room.spin_angle        = 0;
    room.spin_target_slot  = 0;
    room.current_turn_slot = next;
    room.updated_at        = Date.now();

    io.to('room:' + rid).emit('kiss_result', {
      choice     : ch,
      spinner_id : id,
      target_id  : tgtId,
    });

    broadcastState(rid);
    return { ok:1, my_hearts: u.hearts, choice: ch };
  }

  /* ───── send gift ───── */
  case 'send_gift': {
    const id   = String(p.tg_id);
    const toId = String(p.to_tg_id);
    const gid  = +p.gift_id;
    const rid  = +p.room_id || 0;

    if (id === toId) return { ok:0, e:'Ozunuze hediyye gonderemezsiniz' };
    const gift = GIFTS.find(g => g.id === gid);
    if (!gift)   return { ok:0, e:'Hediyye tapilmadi' };

    const u  = getUser(id);
    const tu = getUser(toId);

    if ((u.hearts||0) < gift.price) return { ok:0, e:'Kifayet qeder urek yoxdur' };

    u.hearts  = (u.hearts||0) - gift.price;
    tu.hearts = (tu.hearts||0) + Math.floor(gift.price * 0.8);
    grantXP(id,   3);
    grantXP(toId, 2);

    if (rid) {
      sysMsg(rid,
        '🎁 ' + (u.first_name||'?') +
        ' → ' + (tu.first_name||'?') +
        ' : ' + gift.link + ' ' + gift.name + '!'
      );
      io.to('room:' + rid).emit('gift', {
        from_name : u.first_name,
        to_id     : toId,
        gift_name : gift.name,
        gift_icon : gift.link,
      });
    }
    return { ok:1, my_hearts: u.hearts };
  }

  /* ───── set youtube ───── */
  case 'set_youtube': {
    const rid  = +p.room_id;
    const room = rooms.get(rid);
    if (!room) return { ok:0, e:'Otaq tapilmadi' };
    room.youtube_url          = String(p.url||'').substring(0,300);
    room.youtube_start_time   = Math.floor(Date.now()/1000);
    room.updated_at           = Date.now();
    io.to('room:' + rid).emit('youtube', {
      url        : room.youtube_url,
      start_time : room.youtube_start_time,
    });
    return { ok:1 };
  }

  /* ───── buy hearts ───── */
  case 'buy_hearts': {
    const id   = String(p.tg_id);
    const pid  = +p.pack_id;
    const pack = HEART_PACKS.find(pk => pk.id === pid);
    if (!pack) return { ok:0, e:'Paket tapilmadi' };
    const u = getUser(id);
    if ((u.stars||0) < pack.stars) return { ok:0, e:'Kifayet qeder ulduz yoxdur' };
    u.hearts = (u.hearts||0) + pack.hearts;
    u.stars  = (u.stars||0)  - pack.stars;
    return { ok:1, hearts: u.hearts, stars: u.stars };
  }

  /* ───── settings ───── */
  case 'settings': {
    const u = getUser(String(p.tg_id));
    if (p.sound !== undefined) u.sound_on = +p.sound;
    if (p.music !== undefined) u.music_on = +p.music;
    return { ok:1 };
  }

  /* ───── leaderboard ───── */
  case 'leaderboard': {
    const leaders = [...users.values()]
      .sort((a,b) => (b.xp||0) - (a.xp||0))
      .slice(0,50)
      .map(u => ({
        first_name : u.first_name,
        photo_url  : u.photo_url,
        wins       : u.wins,
        spins      : u.spins,
        kisses     : u.kisses,
        level      : u.level,
        xp         : u.xp,
        name_color : u.name_color,
      }));
    return { leaders };
  }

  /* ───── static lists ───── */
  case 'bottles_list': return { bottles: BOTTLES };
  case 'gifts_list':   return { gifts:   GIFTS   };
  case 'hearts_list':  return { packs:   HEART_PACKS };

  default: return { error: 'unknown: ' + p.a };
  }
}

/* ══════════════════════════════════════════════════════
   SOCKET.IO
══════════════════════════════════════════════════════ */
io.on('connection', (socket) => {
  let myId   = null;
  let myRoom = null;

  console.log('[+] connect ', socket.id);

  /* login */
  socket.on('login', async (data, cb) => {
    myId = String(data?.tg_id || ('g' + Math.floor(Math.random()*900000+100000)));
    sockMap.set(socket.id, { tg_id: myId, room_id: null });
    const res = await act({ ...data, a:'login', tg_id: myId }, socket);
    if (cb) cb(res);
  });

  /* join_room — auto find or create if no room_id given */
  socket.on('join_room', async (data, cb) => {
    const id = String(data?.tg_id || myId);
    myId     = id;
    let rid  = data?.room_id ? +data.room_id : null;

    if (!rid) {
      // Find open room
      for (const [r, room] of rooms) {
        if (room.status === 'waiting' && roomPlayerList(r).length < room.max_players) {
          rid = r; break;
        }
      }
      // Create if none found
      if (!rid) {
        const cr = await act({ a:'create_room', tg_id:id }, socket);
        myRoom   = cr.room_id;
        sockMap.set(socket.id, { tg_id:id, room_id:myRoom });
        socket.join('room:' + myRoom);
        socket.emit('history', roomMsgList(myRoom).slice(-50));
        if (cb) cb(cr);
        return;
      }
    }

    const res = await act({ a:'join_room', tg_id:id, room_id:rid }, socket);
    if (res.ok) {
      myRoom = rid;
      sockMap.set(socket.id, { tg_id:id, room_id:rid });
    }
    if (cb) cb(res);
  });

  /* leave room */
  socket.on('leave_room', async (data, cb) => {
    const id  = String(data?.tg_id  || myId);
    const rid = +(data?.room_id || myRoom);
    if (!rid) { if (cb) cb({ok:0}); return; }
    await act({ a:'leave_room', tg_id:id, room_id:rid }, socket);
    myRoom = null;
    sockMap.set(socket.id, { tg_id:id, room_id:null });
    if (cb) cb({ ok:1 });
  });

  /* msg */
  socket.on('msg', async (data, cb) => {
    const res = await act({
      a:'msg',
      tg_id   : data?.tg_id   || myId,
      room_id : data?.room_id || myRoom,
      text    : data?.text,
    }, socket);
    if (cb) cb(res);
  });

  /* reaction */
  socket.on('reaction', async (data, cb) => {
    const res = await act({
      a:'reaction',
      tg_id   : data?.tg_id   || myId,
      room_id : data?.room_id || myRoom,
      emoji   : data?.emoji,
    }, socket);
    if (cb) cb(res);
  });

  /* spin */
  socket.on('spin', async (data, cb) => {
    const res = await act({
      a:'spin',
      tg_id   : data?.tg_id   || myId,
      room_id : data?.room_id || myRoom,
    }, socket);
    if (cb) cb(res);
  });

  /* kiss_reject */
  socket.on('kiss_reject', async (data, cb) => {
    const res = await act({
      a:'kiss_reject',
      tg_id   : data?.tg_id   || myId,
      room_id : data?.room_id || myRoom,
      choice  : data?.choice,
    }, socket);
    if (cb) cb(res);
  });

  /* send_gift */
  socket.on('send_gift', async (data, cb) => {
    const res = await act({
      a:'send_gift',
      tg_id     : data?.tg_id     || myId,
      to_tg_id  : data?.to_tg_id,
      gift_id   : data?.gift_id,
      room_id   : data?.room_id   || myRoom,
    }, socket);
    if (cb) cb(res);
  });

  /* buy_hearts */
  socket.on('buy_hearts', async (data, cb) => {
    const res = await act({
      a:'buy_hearts',
      tg_id   : data?.tg_id || myId,
      pack_id : data?.pack_id,
    }, socket);
    if (cb) cb(res);
  });

  /* set_youtube */
  socket.on('set_youtube', async (data, cb) => {
    const res = await act({
      a:'set_youtube',
      room_id : data?.room_id || myRoom,
      url     : data?.url,
    }, socket);
    if (cb) cb(res);
  });

  /* settings */
  socket.on('settings', async (data, cb) => {
    const res = await act({
      a:'settings',
      tg_id : data?.tg_id || myId,
      sound : data?.sound,
      music : data?.music,
    }, socket);
    if (cb) cb(res);
  });

  /* leaderboard */
  socket.on('leaderboard', async (data, cb) => {
    const res = await act({ a:'leaderboard' });
    if (cb) cb(res);
  });

  /* disconnect */
  socket.on('disconnect', (reason) => {
    console.log('[-] disconnect', socket.id, reason);

    const info = sockMap.get(socket.id);
    sockMap.delete(socket.id);

    const id  = info?.tg_id  || myId;
    const rid = info?.room_id || myRoom;
    if (!id || !rid) return;

    const pm = roomPlayerMap(rid);
    pm.delete(id);

    const room = rooms.get(rid);
    if (room) {
      room.player_count = pm.size;

      // If disconnecting player was spinning, auto-advance turn
      if (room.spin_in_progress && room.spin_by === id) {
        const next             = nextTurnSlot(rid, room.current_turn_slot);
        room.spin_in_progress  = false;
        room.spin_by           = '';
        room.current_turn_slot = next;
        room.updated_at        = Date.now();
        sysMsg(rid, '⏰ Spinner ayrildi — novbe kecdi.');
      }
    }

    const u = users.get(id);
    sysMsg(rid, '🚪 ' + (u?.first_name||'?') + ' ayrildi');
    broadcastState(rid);
  });
});

/* ══════════════════════════════════════════════════════
   START
══════════════════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  🍾  Sise Cevirme Server  READY         ║');
  console.log('║  Port   : ' + String(PORT).padEnd(31) + '║');
  console.log('║  Engine : Socket.IO + Express            ║');
  console.log('║  DB     : none (full in-memory)          ║');
  console.log('║  Deploy : render.com                     ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
