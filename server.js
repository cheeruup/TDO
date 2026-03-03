// server.js

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const engine = require("./game/engine");

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

app.use(express.static(path.join(__dirname, "public")));

/**
 * ✅ balance.js를 아예 쓰지 말고(순환 의존 제거),
 * server도 balance.json을 직접 읽어서 client에 줄 PUBLIC_BAL을 만든다.
 */
function loadPublicBalance() {
  const p = path.join(__dirname, "game", "balance.json");
  const raw = fs.readFileSync(p, "utf-8");
  const bal = JSON.parse(raw);

  const publicBalance = {
    hp: bal.hp,
    colors: bal.colors,
    cards: bal.cards,
    upgradeRules: bal.upgradeRules,
    turnFlow: bal.turnFlow,
    combat: bal.combat,
    multiplier: bal.multiplier,
    rps: bal.rps,
    equipmentPower: bal.equipmentPower,
    deck: bal.deck // 필요 없으면 빼도 됨(디버그 용)
  };

  return publicBalance;
}

const PUBLIC_BAL = loadPublicBalance();

const rooms = {};

function createRoom(roomId) {
  rooms[roomId] = {
    players: [], // A,B만 저장. 그 외는 관전자
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

// ✅ "n턴 : " 로그 + 턴 시작 직전 공백
function addLog(state, msg) {
  if (state.pendingTurnBreak) {
    state.log.push("");
    state.pendingTurnBreak = false;
  }
  const t = state.turnCount || 1;
  state.log.push(`${t}턴 : ${msg}`);
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

    // ✅ 2명까지만 플레이어(A,B), 이후 관전자
    let seat = null;
    if (room.players.length < 2) {
      room.players.push(socket.id);
      seat = seatOf(room, socket.id); // A/B
    } else {
      seat = "S"; // spectator
    }

    socket.join(roomId);
    socket.emit("joined", { roomId, seat });

    if (seat === "A" || seat === "B") {
      addLog(room.state, `${seat} 입장`);
      if (room.players.length === 2) addLog(room.state, "2명 입장 완료! A부터 시작");
    } else {
      addLog(room.state, "관전자 입장");
    }

    broadcast(roomId);
  });

  socket.on("roll", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const check = assertMyTurn(room, socket.id);
    if (!check.ok) return;

    const s = room.state;
    if (s.turnPhase.rolled) {
      addLog(s, `${check.seat} 이미 주사위를 굴렸습니다.`);
      return broadcast(roomId);
    }

    const r = Math.floor(Math.random() * 6) + 1;
    const color = r <= 2 ? "R" : r <= 4 ? "B" : "Y";

    s.tokens[check.seat][color] += 1;
    s.turnPhase.rolled = true;

    addLog(s, `${check.seat} 주사위 → ${color} (토큰 +1)`);

    engine.tryAutoStartCombat(s, room.players.length);
    if (s.combat.active) addLog(s, `⚔️ 자동 전투 시작! (양쪽 토큰 ${engine.BAL.combat.minTokenTotalEach}+)`);

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
      addLog(s, `${check.seat} 먼저 주사위를 굴려야 합니다.`);
      return broadcast(roomId);
    }
    if (ph.drew >= engine.BAL.turnFlow.drawPerTurn) return;

    const card = s.open[index];
    if (!card) return;

    s.open[index] = null;
    s.hands[check.seat].push(card);

    ph.drew += 1;
    ph.mustTakeOpen = false;

    addLog(s, `${check.seat} 오픈(${index + 1})에서 ${card} 획득 (${ph.drew}/${engine.BAL.turnFlow.drawPerTurn})`);

    engine.tryAutoStartCombat(s, room.players.length);
    if (s.combat.active) addLog(s, `⚔️ 자동 전투 시작! (양쪽 토큰 ${engine.BAL.combat.minTokenTotalEach}+)`);

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
      addLog(s, `${check.seat} 먼저 주사위를 굴려야 합니다.`);
      return broadcast(roomId);
    }

    if (engine.BAL.turnFlow.firstDrawMustBeOpen && ph.drew === 0) {
      addLog(s, `${check.seat} 첫 카드는 오픈에서 가져가야 합니다.`);
      return broadcast(roomId);
    }

    if (ph.drew >= engine.BAL.turnFlow.drawPerTurn) return;

    const card = engine.draw(s.deck);
    if (!card) {
      addLog(s, "덱이 비었습니다.");
      return broadcast(roomId);
    }

    s.hands[check.seat].push(card);
    ph.drew += 1;

    addLog(s, `${check.seat} 덱에서 ${card} 획득 (${ph.drew}/${engine.BAL.turnFlow.drawPerTurn})`);

    engine.tryAutoStartCombat(s, room.players.length);
    if (s.combat.active) addLog(s, `⚔️ 자동 전투 시작! (양쪽 토큰 ${engine.BAL.combat.minTokenTotalEach}+)`);

    broadcast(roomId);
  });

  // 손패 클릭 장착(기존 장비는 손패로 반환)
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
      addLog(s, `${check.seat} 손패에 ${card} 없음`);
      return broadcast(roomId);
    }

    hand.splice(idx, 1);

    const prev = s.equipped[check.seat][slot];
    if (prev) hand.push(prev);

    s.equipped[check.seat][slot] = card;

    addLog(
      s,
      `${check.seat} ${slot === "weapon" ? "무기" : "방어"} 장착: ${card}` +
      (prev ? ` (기존 ${prev} 손패로 반환)` : "")
    );

    engine.tryAutoStartCombat(s, room.players.length);
    if (s.combat.active) addLog(s, `⚔️ 자동 전투 시작! (양쪽 토큰 ${engine.BAL.combat.minTokenTotalEach}+)`);

    broadcast(roomId);
  });

  // ✅ 업글: 같은 카드 N + (동종 아무 카드 1)
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
      addLog(s, `${seat} 업그레이드 기준 카드가 올바르지 않음`);
      return broadcast(roomId);
    }

    const rule = engine.BAL.upgradeRules[tier];
    const needSame = rule.same;
    const needAny = (rule.any ?? 0);

    const result = engine.getUpgradeResult(type, tier, base);
    if (!result) {
      addLog(s, `${seat} 업그레이드 실패: 결과 카드 매핑이 없음`);
      return broadcast(roomId);
    }

    const totalCounts = engine.countsWithEquipped(s, seat);
    if ((totalCounts[base] || 0) < needSame) {
      addLog(s, `${seat} 업그레이드 실패: ${base} ${needSame}장 필요(손패+착용 포함)`);
      return broadcast(roomId);
    }

    const remove = [];
    for (let i = 0; i < needSame; i++) remove.push(base);

    let anyPicked = null;
    if (needAny === 1) {
      // ✅ 여기서 type 반영 (무기 업글이면 무기 아무카드만, 방어 업글이면 방어 아무카드만)
      anyPicked = engine.pickAnyAfterBase(totalCounts, base, needSame, type);
      if (!anyPicked) {
        addLog(s, `${seat} 업그레이드 실패: ${type === "weapon" ? "무기" : "방어"} 아무 카드 1장이 더 필요`);
        return broadcast(roomId);
      }
      remove.push(anyPicked);
    }

    const ok = engine.removeFromHandOrEquipped(s, seat, remove);
    if (!ok) {
      addLog(s, `${seat} 업그레이드 실패: 재료 카드 소모 불가(손패/착용 확인 필요)`);
      return broadcast(roomId);
    }

    s.hands[seat].push(result);
    addLog(
      s,
      `${seat} 업그레이드 성공: ${result} 획득 (버린 카드: ${remove.join(", ")})${anyPicked ? ` / 아무카드=${anyPicked}` : ""}`
    );

    engine.tryAutoStartCombat(s, room.players.length);
    if (s.combat.active) addLog(s, `⚔️ 자동 전투 시작! (양쪽 토큰 ${engine.BAL.combat.minTokenTotalEach}+)`);

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

    const t = s.tokens[seat];
    const need = { R: 0, B: 0, Y: 0 };
    need[wColor] += engine.BAL.combat.spend.weapon;
    need[aColor] += engine.BAL.combat.spend.armor;

    for (const c of engine.BAL.colors) {
      if ((t[c] || 0) < need[c]) {
        addLog(s, `${seat} 전투 토큰 부족`);
        return broadcast(roomId);
      }
    }

    s.combat.submissions[seat] = { wColor, aColor };
    addLog(s, `${seat} 전투 선택 완료`);

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
      addLog(s, `${check.seat} 턴 종료 전에 주사위를 굴려야 합니다.`);
      return broadcast(roomId);
    }
    if (ph.drew < engine.BAL.turnFlow.drawPerTurn) {
      addLog(s, `${check.seat} 턴 종료 전에 카드를 ${engine.BAL.turnFlow.drawPerTurn}장 모두 가져가야 합니다. (${ph.drew}/${engine.BAL.turnFlow.drawPerTurn})`);
      return broadcast(roomId);
    }
    if (s.combat.active) {
      addLog(s, `${check.seat} 전투가 진행 중입니다(양쪽 선택 완료 후 종료 가능)`);
      return broadcast(roomId);
    }

    if (!ph.refilledOpen) engine.refillOpen(s);

    const prev = check.seat;
    const next = prev === "A" ? "B" : "A";

    addLog(s, `${prev} 턴 종료 → ${next} 턴`);

    s.turn = next;
    s.turnPhase = { rolled: false, drew: 0, mustTakeOpen: true, refilledOpen: false };
    s.combat.resolved = false;
    s.turnCount = (s.turnCount || 1) + 1;
    s.pendingTurnBreak = true;

    broadcast(roomId);
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of Object.entries(rooms)) {
      const idx = room.players.indexOf(socket.id);
      if (idx !== -1) {
        const seat = idx === 0 ? "A" : "B";
        room.players.splice(idx, 1);
        addLog(room.state, `${seat} 연결 종료`);
        if (room.players.length === 0) delete rooms[roomId];
        else broadcast(roomId);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Listening on", PORT));