const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = {};

// ---- constants ----
const WEAPONS = ["검", "마법봉", "활"];
const ARMORS = ["방패", "힐", "회피"];
const COLORS = ["R", "B", "Y"];

// RPS: R > Y > B > R
function relation(att, def) {
  if (!att || !def) return 0;
  if (att === def) return 0;
  if (att === "R" && def === "Y") return 1;
  if (att === "Y" && def === "B") return 1;
  if (att === "B" && def === "R") return 1;
  return -1;
}
function multiplier(att, def) {
  const rel = relation(att, def);
  if (rel === 1) return 1.5;
  if (rel === -1) return 0.5;
  return 1.0;
}

function isWeapon(card) {
  return WEAPONS.includes(card) || ["a검", "a마법봉", "a활", "b무기", "c무기"].includes(card);
}
function isArmor(card) {
  return ARMORS.includes(card) || ["a방패", "a힐", "a회피", "b방어", "c방어"].includes(card);
}

function equipPower(item) {
  if (WEAPONS.includes(item) || ARMORS.includes(item)) return 1;
  if (["c무기", "c방어"].includes(item)) return 3;
  if (["b무기", "b방어"].includes(item)) return 5;
  if (["a검", "a마법봉", "a활", "a방패", "a힐", "a회피"].includes(item)) return 7;
  return 0;
}

function makeDeck() {
  const deck = [];
  for (let i = 0; i < 10; i++) deck.push("검", "마법봉", "활");
  for (let i = 0; i < 10; i++) deck.push("방패", "힐", "회피");

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function draw(deck) {
  return deck.length ? deck.pop() : null;
}

function refillOpen(state) {
  while (state.open.length < 3) {
    const c = draw(state.deck);
    if (!c) break;
    state.open.push(c);
  }
}

function countsOf(cards) {
  const m = {};
  for (const c of cards) m[c] = (m[c] || 0) + 1;
  return m;
}

function countsWithEquipped(state, seat) {
  const m = countsOf(state.hands[seat]);
  const w = state.equipped[seat].weapon;
  const a = state.equipped[seat].armor;
  if (w) m[w] = (m[w] || 0) + 1;
  if (a) m[a] = (m[a] || 0) + 1;
  return m;
}

function removeFromHandOrEquipped(state, seat, cardsToRemove) {
  const hand = state.hands[seat];

  for (const c of cardsToRemove) {
    const idx = hand.indexOf(c);
    if (idx !== -1) {
      hand.splice(idx, 1);
      continue;
    }

    if (state.equipped[seat].weapon === c) {
      state.equipped[seat].weapon = null;
      continue;
    }
    if (state.equipped[seat].armor === c) {
      state.equipped[seat].armor = null;
      continue;
    }
    return false;
  }
  return true;
}

function tokenSum(t) {
  return (t.R || 0) + (t.B || 0) + (t.Y || 0);
}

// ✅ "아무(동종)" 카드 선택: base needSame 제거 후 남은 카드 중에서만,
// 무기/방어 타입에 맞는 것만 후보로 잡아서 고른다.
function pickAnyOfSameTypeAfterBase(totalCounts, base, needSame, wantWeapon) {
  const temp = { ...totalCounts };
  temp[base] = (temp[base] || 0) - needSame;

  const candidates = [];
  for (const [k, v] of Object.entries(temp)) {
    if (v <= 0) continue;
    if (wantWeapon && isWeapon(k)) candidates.push(k);
    if (!wantWeapon && isArmor(k)) candidates.push(k);
  }

  // 결정적 선택(정렬)로 “랜덤/순서 이슈” 제거
  candidates.sort();

  return candidates.length ? candidates[0] : null;
}

function createRoom(roomId) {
  const deck = makeDeck();
  const open = [];
  for (let i = 0; i < 3; i++) open.push(draw(deck));

  rooms[roomId] = {
    players: [],
    state: {
      hp: { A: 20, B: 20 },
      turn: "A",

      deck,
      open,

      tokens: { A: { R: 0, B: 0, Y: 0 }, B: { R: 0, B: 0, Y: 0 } },
      hands: { A: [], B: [] },

      equipped: {
        A: { weapon: null, armor: null },
        B: { weapon: null, armor: null },
      },

      turnPhase: { rolled: false, drew: 0, mustTakeOpen: true, refilledOpen: false },

      combat: {
        active: false,
        submissions: { A: null, B: null },
        resolved: false,
      },

      log: ["방 생성됨. 2명 대기중..."],
    },
  };
}

function seatOf(room, socketId) {
  const idx = room.players.indexOf(socketId);
  return idx === 0 ? "A" : idx === 1 ? "B" : null;
}

function broadcast(roomId) {
  const s = rooms[roomId].state;
  const payload = {
    ...s,
    counts: { A: countsWithEquipped(s, "A"), B: countsWithEquipped(s, "B") },
    power: {
      A: { weapon: equipPower(s.equipped.A.weapon), armor: equipPower(s.equipped.A.armor) },
      B: { weapon: equipPower(s.equipped.B.weapon), armor: equipPower(s.equipped.B.armor) },
    },
    tokenTotal: { A: tokenSum(s.tokens.A), B: tokenSum(s.tokens.B) },
  };
  io.to(roomId).emit("state", payload);
}

function assertMyTurn(room, socketId) {
  const seat = seatOf(room, socketId);
  if (!seat) return { ok: false, seat: null };
  if (room.state.turn !== seat) return { ok: false, seat };
  return { ok: true, seat };
}

function resolveCombat(s) {
  const subA = s.combat.submissions.A;
  const subB = s.combat.submissions.B;
  if (!subA || !subB) return;

  s.tokens.A[subA.wColor] -= 1;
  s.tokens.A[subA.aColor] -= 1;
  s.tokens.B[subB.wColor] -= 1;
  s.tokens.B[subB.aColor] -= 1;

  const atkA = equipPower(s.equipped.A.weapon);
  const defA = equipPower(s.equipped.A.armor);
  const atkB = equipPower(s.equipped.B.weapon);
  const defB = equipPower(s.equipped.B.armor);

  const multA = multiplier(subA.wColor, subB.aColor);
  const multB = multiplier(subB.wColor, subA.aColor);

  const baseDmgToB = Math.max(0, atkA - defB);
  const baseDmgToA = Math.max(0, atkB - defA);

  const dmgToB = baseDmgToB * multA;
  const dmgToA = baseDmgToA * multB;

  s.hp.B = Math.max(0, Math.round((s.hp.B - dmgToB) * 10) / 10);
  s.hp.A = Math.max(0, Math.round((s.hp.A - dmgToA) * 10) / 10);

  s.log.push(`⚔️ 전투! A(${subA.wColor}/${subA.aColor}) vs B(${subB.wColor}/${subB.aColor})`);
  s.log.push(`A→B: (공${atkA}-방${defB}=${baseDmgToB})×${multA} = ${dmgToB} 피해`);
  s.log.push(`B→A: (공${atkB}-방${defA}=${baseDmgToA})×${multB} = ${dmgToA} 피해`);
  s.log.push(`HP: A=${s.hp.A}, B=${s.hp.B}`);

  s.combat.active = false;
  s.combat.resolved = true;
  s.combat.submissions = { A: null, B: null };

  refillOpen(s);
  s.turnPhase.refilledOpen = true;
}

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  socket.on("join", ({ roomId }) => {
    if (!roomId) return;

    if (!rooms[roomId]) createRoom(roomId);
    const room = rooms[roomId];

    if (room.players.length >= 2) {
      socket.emit("full", { message: "방이 가득 찼습니다." });
      return;
    }

    room.players.push(socket.id);
    socket.join(roomId);

    const seat = seatOf(room, socket.id);
    socket.emit("joined", { roomId, seat });

    room.state.log.push(`${seat} 입장`);
    if (room.players.length === 2) room.state.log.push("2명 입장 완료! A부터 시작");

    broadcast(roomId);
  });

  socket.on("roll", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const check = assertMyTurn(room, socket.id);
    if (!check.ok) return;

    const s = room.state;
    if (s.turnPhase.rolled) {
      s.log.push(`${check.seat} 이미 주사위를 굴렸습니다.`);
      return broadcast(roomId);
    }

    const r = Math.floor(Math.random() * 6) + 1;
    const color = r <= 2 ? "R" : r <= 4 ? "B" : "Y";

    s.tokens[check.seat][color] += 1;
    s.turnPhase.rolled = true;

    s.log.push(`${check.seat} 주사위 → ${color} (토큰 +1)`);
    broadcast(roomId);
  });

  socket.on("takeOpen", ({ roomId, index }) => {
    const room = rooms[roomId];
    if (!room) return;

    const check = assertMyTurn(room, socket.id);
    if (!check.ok) return;

    const s = room.state;
    const ph = s.turnPhase;

    if (!ph.rolled) {
      s.log.push(`${check.seat} 먼저 주사위를 굴려야 합니다.`);
      return broadcast(roomId);
    }
    if (ph.drew >= 2) return;

    const card = s.open[index];
    if (!card) return;

    s.open.splice(index, 1);
    s.hands[check.seat].push(card);

    ph.drew += 1;
    ph.mustTakeOpen = false;

    s.log.push(`${check.seat} 오픈에서 ${card} 획득 (${ph.drew}/2)`);
    broadcast(roomId);
  });

  socket.on("takeDeck", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const check = assertMyTurn(room, socket.id);
    if (!check.ok) return;

    const s = room.state;
    const ph = s.turnPhase;

    if (!ph.rolled) {
      s.log.push(`${check.seat} 먼저 주사위를 굴려야 합니다.`);
      return broadcast(roomId);
    }
    if (ph.drew === 0) {
      s.log.push(`${check.seat} 첫 카드는 오픈에서 가져가야 합니다.`);
      return broadcast(roomId);
    }
    if (ph.drew >= 2) return;

    const card = draw(s.deck);
    if (!card) {
      s.log.push("덱이 비었습니다.");
      return broadcast(roomId);
    }

    s.hands[check.seat].push(card);
    ph.drew += 1;

    s.log.push(`${check.seat} 덱에서 ${card} 획득 (${ph.drew}/2)`);
    broadcast(roomId);
  });

  socket.on("equip", ({ roomId, slot, card }) => {
    const room = rooms[roomId];
    if (!room) return;

    const check = assertMyTurn(room, socket.id);
    if (!check.ok) return;

    const s = room.state;
    if (!["weapon", "armor"].includes(slot)) return;

    if (slot === "weapon" && !isWeapon(card)) return;
    if (slot === "armor" && !isArmor(card)) return;

    const hand = s.hands[check.seat];
    const idx = hand.indexOf(card);
    if (idx === -1) {
      s.log.push(`${check.seat} 손패에 ${card} 없음`);
      return broadcast(roomId);
    }

    hand.splice(idx, 1);
    const prev = s.equipped[check.seat][slot];
    s.equipped[check.seat][slot] = card;

    s.log.push(`${check.seat} ${slot === "weapon" ? "무기" : "방어"} 장착: ${card}${prev ? ` (기존 ${prev} 버림)` : ""}`);
    broadcast(roomId);
  });

  /**
   * ✅ 업그레이드(수정/확정):
   * - 같은 카드 needSame
   * - "아무 카드"는 동종만: 무기면 아무무기, 방어면 아무방어
   * - 재료는 손패/착용 어디서든 사용 가능 + 사용된 카드는 무조건 버림
   * - 결과는 즉시 장착 X → 손패에 추가(획득)
   */
  socket.on("upgrade", ({ roomId, type, tier, base }) => {
    const room = rooms[roomId];
    if (!room) return;

    const check = assertMyTurn(room, socket.id);
    if (!check.ok) return;

    const s = room.state;
    const seat = check.seat;

    const isW = type === "weapon";
    if (!["weapon", "armor"].includes(type) || !["c", "b", "a"].includes(tier)) return;

    const basePool = isW ? WEAPONS : ARMORS;
    if (!basePool.includes(base)) {
      s.log.push(`${seat} 업그레이드 기준 카드가 올바르지 않음`);
      return broadcast(roomId);
    }

    let needSame = 0, needAny = 0, result = null;
    if (tier === "c") { needSame = 2; needAny = 1; result = isW ? "c무기" : "c방어"; }
    else if (tier === "b") { needSame = 3; needAny = 1; result = isW ? "b무기" : "b방어"; }
    else {
      needSame = 5; needAny = 0;
      if (isW) result = base === "검" ? "a검" : base === "마법봉" ? "a마법봉" : "a활";
      else result = base === "방패" ? "a방패" : base === "힐" ? "a힐" : "a회피";
    }

    const totalCounts = countsWithEquipped(s, seat);
    if ((totalCounts[base] || 0) < needSame) {
      s.log.push(`${seat} 업그레이드 실패: ${base} ${needSame}장 필요(손패+착용 포함)`);
      return broadcast(roomId);
    }

    const remove = [];
    for (let i = 0; i < needSame; i++) remove.push(base);

    let anyPicked = null;
    if (needAny === 1) {
      anyPicked = pickAnyOfSameTypeAfterBase(totalCounts, base, needSame, isW);
      if (!anyPicked) {
        s.log.push(`${seat} 업그레이드 실패: ${isW ? "아무 무기" : "아무 방어"} 1장이 더 필요`);
        return broadcast(roomId);
      }
      remove.push(anyPicked);
    }

    const ok = removeFromHandOrEquipped(s, seat, remove);
    if (!ok) {
      s.log.push(`${seat} 업그레이드 실패: 재료 카드 소모 불가(손패/착용 확인 필요)`);
      return broadcast(roomId);
    }

    s.hands[seat].push(result);
    s.log.push(`${seat} 업그레이드 성공: ${result} 획득 (버린 카드: ${remove.join(", ")})${anyPicked ? ` / 아무카드=${anyPicked}` : ""}`);
    broadcast(roomId);
  });

  // ---- combat ----
  socket.on("startCombat", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const check = assertMyTurn(room, socket.id);
    if (!check.ok) return;

    const s = room.state;

    if (tokenSum(s.tokens.A) < 3 || tokenSum(s.tokens.B) < 3) {
      s.log.push(`${check.seat} 전투 조건 불충족(양쪽 토큰 총합 3 이상 필요)`);
      return broadcast(roomId);
    }
    if (!s.turnPhase.rolled || s.turnPhase.drew < 2) {
      s.log.push(`${check.seat} 전투는 주사위+카드2장 이후에 시작 가능`);
      return broadcast(roomId);
    }
    if (s.combat.active) return;

    s.combat.active = true;
    s.combat.resolved = false;
    s.combat.submissions = { A: null, B: null };

    s.log.push(`⚔️ 전투 시작! 각자 토큰 2개 선택(무기1/방어1)`);
    broadcast(roomId);
  });

  socket.on("submitCombat", ({ roomId, wColor, aColor }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seat = seatOf(room, socket.id);
    if (!seat) return;

    const s = room.state;
    if (!s.combat.active) return;

    if (!COLORS.includes(wColor) || !COLORS.includes(aColor)) return;

    const t = s.tokens[seat];
    const need = { R: 0, B: 0, Y: 0 };
    need[wColor] += 1;
    need[aColor] += 1;

    for (const c of COLORS) {
      if ((t[c] || 0) < need[c]) {
        s.log.push(`${seat} 전투 토큰 부족`);
        return broadcast(roomId);
      }
    }

    s.combat.submissions[seat] = { wColor, aColor };
    s.log.push(`${seat} 전투 선택 완료`);

    if (s.combat.submissions.A && s.combat.submissions.B) {
      resolveCombat(s);
    }
    broadcast(roomId);
  });

  socket.on("endTurn", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const check = assertMyTurn(room, socket.id);
    if (!check.ok) return;

    const s = room.state;
    const ph = s.turnPhase;

    if (!ph.rolled) {
      s.log.push(`${check.seat} 턴 종료 전에 주사위를 굴려야 합니다.`);
      return broadcast(roomId);
    }
    if (ph.drew < 2) {
      s.log.push(`${check.seat} 턴 종료 전에 카드를 2장 모두 가져가야 합니다. (${ph.drew}/2)`);
      return broadcast(roomId);
    }
    if (s.combat.active) {
      s.log.push(`${check.seat} 전투가 진행 중입니다(양쪽 선택 완료 후 종료 가능)`);
      return broadcast(roomId);
    }

    if (!ph.refilledOpen) refillOpen(s);

    const prev = check.seat;
    s.turn = prev === "A" ? "B" : "A";
    s.turnPhase = { rolled: false, drew: 0, mustTakeOpen: true, refilledOpen: false };

    s.log.push(`${prev} 턴 종료 → ${s.turn} 턴`);
    broadcast(roomId);
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of Object.entries(rooms)) {
      const idx = room.players.indexOf(socket.id);
      if (idx !== -1) {
        const seat = idx === 0 ? "A" : "B";
        room.players.splice(idx, 1);
        room.state.log.push(`${seat} 연결 종료`);
        if (room.players.length === 0) delete rooms[roomId];
        else broadcast(roomId);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Listening on", PORT));