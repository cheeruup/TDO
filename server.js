const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const { PUBLIC_BAL } = require("./game/balance");
const engine = require("./game/engine");

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = {};

function createRoom(roomId) {
  rooms[roomId] = {
    players: [],
    state: engine.createInitialState()
  };
}

function seatOf(room, socketId) {
  const idx = room.players.indexOf(socketId);
  return idx === 0 ? "A" : idx === 1 ? "B" : null;
}

function assertMyTurn(room, socketId) {
  const seat = seatOf(room, socketId);
  if (!seat) return { ok: false, seat: null };
  if (room.state.turn !== seat) return { ok: false, seat };
  return { ok: true, seat };
}

function broadcast(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const s = room.state;
  const derived = engine.computeDerived(s);

  io.to(roomId).emit("state", {
    ...s,
    ...derived,
    balance: PUBLIC_BAL
  });
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

    engine.tryAutoStartCombat(s, room.players.length);
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
    if (ph.drew >= engine.BAL.turnFlow.drawPerTurn) return;

    const card = s.open[index];
    if (!card) return;

    s.open[index] = null;
    s.hands[check.seat].push(card);

    ph.drew += 1;
    ph.mustTakeOpen = false;

    s.log.push(`${check.seat} 오픈(${index + 1})에서 ${card} 획득 (${ph.drew}/${engine.BAL.turnFlow.drawPerTurn})`);

    engine.tryAutoStartCombat(s, room.players.length);
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

    if (engine.BAL.turnFlow.firstDrawMustBeOpen && ph.drew === 0) {
      s.log.push(`${check.seat} 첫 카드는 오픈에서 가져가야 합니다.`);
      return broadcast(roomId);
    }

    if (ph.drew >= engine.BAL.turnFlow.drawPerTurn) return;

    const card = engine.draw(s.deck);
    if (!card) {
      s.log.push("덱이 비었습니다.");
      return broadcast(roomId);
    }

    s.hands[check.seat].push(card);
    ph.drew += 1;

    s.log.push(`${check.seat} 덱에서 ${card} 획득 (${ph.drew}/${engine.BAL.turnFlow.drawPerTurn})`);

    engine.tryAutoStartCombat(s, room.players.length);
    broadcast(roomId);
  });

  socket.on("equip", ({ roomId, slot, card }) => {
    const room = rooms[roomId];
    if (!room) return;

    const check = assertMyTurn(room, socket.id);
    if (!check.ok) return;

    const s = room.state;
    if (!["weapon", "armor"].includes(slot)) return;

    if (slot === "weapon" && !engine.isWeapon(card)) return;
    if (slot === "armor" && !engine.isArmor(card)) return;

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

    engine.tryAutoStartCombat(s, room.players.length);
    broadcast(roomId);
  });

  socket.on("upgrade", ({ roomId, type, tier, base }) => {
    const room = rooms[roomId];
    if (!room) return;

    const check = assertMyTurn(room, socket.id);
    if (!check.ok) return;

    const s = room.state;
    const seat = check.seat;

    if (!["weapon", "armor"].includes(type)) return;
    if (!["c", "b", "a"].includes(tier)) return;

    const basePool = type === "weapon" ? engine.BAL.cards.weaponsBase : engine.BAL.cards.armorsBase;
    if (!basePool.includes(base)) {
      s.log.push(`${seat} 업그레이드 기준 카드가 올바르지 않음`);
      return broadcast(roomId);
    }

    const rule = engine.BAL.upgradeRules[tier];
    const needSame = rule.same;
    const needAny = rule.anySameType;

    const result = engine.getUpgradeResult(type, tier, base);
    if (!result) {
      s.log.push(`${seat} 업그레이드 실패: 결과 카드 매핑이 없음`);
      return broadcast(roomId);
    }

    const totalCounts = engine.countsWithEquipped(s, seat);
    if ((totalCounts[base] || 0) < needSame) {
      s.log.push(`${seat} 업그레이드 실패: ${base} ${needSame}장 필요(손패+착용 포함)`);
      return broadcast(roomId);
    }

    const remove = [];
    for (let i = 0; i < needSame; i++) remove.push(base);

    let anyPicked = null;
    if (needAny === 1) {
      const wantWeapon = type === "weapon";
      anyPicked = engine.pickAnyOfSameTypeAfterBase(totalCounts, base, needSame, wantWeapon);
      if (!anyPicked) {
        s.log.push(`${seat} 업그레이드 실패: ${wantWeapon ? "아무 무기" : "아무 방어"} 1장이 더 필요`);
        return broadcast(roomId);
      }
      remove.push(anyPicked);
    }

    const ok = engine.removeFromHandOrEquipped(s, seat, remove);
    if (!ok) {
      s.log.push(`${seat} 업그레이드 실패: 재료 카드 소모 불가(손패/착용 확인 필요)`);
      return broadcast(roomId);
    }

    s.hands[seat].push(result);
    s.log.push(`${seat} 업그레이드 성공: ${result} 획득 (버린 카드: ${remove.join(", ")})${anyPicked ? ` / 아무카드=${anyPicked}` : ""}`);

    engine.tryAutoStartCombat(s, room.players.length);
    broadcast(roomId);
  });

  socket.on("submitCombat", ({ roomId, wColor, aColor }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seat = seatOf(room, socket.id);
    if (!seat) return;

    const s = room.state;
    if (!s.combat.active) return;

    if (!engine.BAL.colors.includes(wColor) || !engine.BAL.colors.includes(aColor)) return;

    // token sufficient check
    const t = s.tokens[seat];
    const need = { R: 0, B: 0, Y: 0 };
    need[wColor] += engine.BAL.combat.spend.weapon;
    need[aColor] += engine.BAL.combat.spend.armor;

    for (const c of engine.BAL.colors) {
      if ((t[c] || 0) < need[c]) {
        s.log.push(`${seat} 전투 토큰 부족`);
        return broadcast(roomId);
      }
    }

    s.combat.submissions[seat] = { wColor, aColor };
    s.log.push(`${seat} 전투 선택 완료`);

    if (s.combat.submissions.A && s.combat.submissions.B) {
      engine.resolveCombat(s);
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
    if (ph.drew < engine.BAL.turnFlow.drawPerTurn) {
      s.log.push(`${check.seat} 턴 종료 전에 카드를 ${engine.BAL.turnFlow.drawPerTurn}장 모두 가져가야 합니다. (${ph.drew}/${engine.BAL.turnFlow.drawPerTurn})`);
      return broadcast(roomId);
    }
    if (s.combat.active) {
      s.log.push(`${check.seat} 전투가 진행 중입니다(양쪽 선택 완료 후 종료 가능)`);
      return broadcast(roomId);
    }

    if (!ph.refilledOpen) engine.refillOpen(s);

    const prev = check.seat;
    s.turn = prev === "A" ? "B" : "A";
    s.turnPhase = { rolled: false, drew: 0, mustTakeOpen: true, refilledOpen: false };

    s.combat.resolved = false;

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