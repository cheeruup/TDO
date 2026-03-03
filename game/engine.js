// game/engine.js

const fs = require("fs");
const path = require("path");

// ✅ engine이 balance.js를 require 하면 순환 의존이 생길 수 있어서,
// engine은 balance.json을 직접 읽는다.
function loadBalanceJson() {
  const p = path.join(__dirname, "balance.json");
  const raw = fs.readFileSync(p, "utf-8");
  const bal = JSON.parse(raw);

  if (!bal.cards?.weaponsBase?.length) throw new Error("balance.json: cards.weaponsBase missing");
  if (!bal.cards?.armorsBase?.length) throw new Error("balance.json: cards.armorsBase missing");
  if (!bal.turnFlow?.openSlots) throw new Error("balance.json: turnFlow.openSlots missing");
  if (!bal.deck?.length) throw new Error("balance.json: deck missing");

  return bal;
}

const BAL = loadBalanceJson();

// ✅ fast lookup sets (무기/방어 판별)
const WEAPON_SET = new Set();
const ARMOR_SET = new Set();

for (const c of BAL.cards.weaponsBase) WEAPON_SET.add(c);
for (const c of BAL.cards.armorsBase) ARMOR_SET.add(c);

// upgraded: c/b
if (BAL.cards?.upgraded?.weapon?.c) WEAPON_SET.add(BAL.cards.upgraded.weapon.c);
if (BAL.cards?.upgraded?.weapon?.b) WEAPON_SET.add(BAL.cards.upgraded.weapon.b);
if (BAL.cards?.upgraded?.armor?.c) ARMOR_SET.add(BAL.cards.upgraded.armor.c);
if (BAL.cards?.upgraded?.armor?.b) ARMOR_SET.add(BAL.cards.upgraded.armor.b);

// upgraded: a maps
for (const v of Object.values(BAL.cards?.upgraded?.weapon?.a || {})) WEAPON_SET.add(v);
for (const v of Object.values(BAL.cards?.upgraded?.armor?.a || {})) ARMOR_SET.add(v);

function isWeapon(card) {
  return WEAPON_SET.has(card);
}
function isArmor(card) {
  return ARMOR_SET.has(card);
}

function equipPower(item) {
  if (!item) return 0;

  // base
  if (BAL.cards.weaponsBase.includes(item) || BAL.cards.armorsBase.includes(item)) return BAL.equipmentPower.base;

  // c/b
  if (item === BAL.cards.upgraded.weapon.c || item === BAL.cards.upgraded.armor.c) return BAL.equipmentPower.c;
  if (item === BAL.cards.upgraded.weapon.b || item === BAL.cards.upgraded.armor.b) return BAL.equipmentPower.b;

  // a
  const allA = [
    ...Object.values(BAL.cards.upgraded.weapon.a || {}),
    ...Object.values(BAL.cards.upgraded.armor.a || {})
  ];
  if (allA.includes(item)) return BAL.equipmentPower.a;

  return 0;
}

// RPS relation: att beats def if rps[att] === def
function relation(att, def) {
  if (!att || !def) return 0;
  if (att === def) return 0;
  return BAL.rps[att] === def ? 1 : -1;
}
function multiplier(att, def) {
  const rel = relation(att, def);
  if (rel === 1) return BAL.multiplier.win;
  if (rel === -1) return BAL.multiplier.lose;
  return BAL.multiplier.draw;
}

function makeDeck() {
  const deck = [];
  for (const it of BAL.deck) {
    for (let i = 0; i < it.count; i++) deck.push(it.card);
  }
  // shuffle
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
  const slots = BAL.turnFlow.openSlots;
  while (state.open.length < slots) state.open.push(null);

  for (let i = 0; i < slots; i++) {
    if (state.open[i] == null) {
      const c = draw(state.deck);
      if (!c) break;
      state.open[i] = c;
    }
  }
}

function tokenSum(t) {
  return (t.R || 0) + (t.B || 0) + (t.Y || 0);
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

/**
 * ✅ "아무 카드(동종)" 고르기: 낮은 등급 우선
 * 우선순위: base(0) < c(1) < b(2) < a(3)
 * 같은 등급이면 이름 오름차순(재현성)
 */
function pickAnyAfterBase(totalCounts, base, needSame, type) {
  const temp = { ...totalCounts };
  temp[base] = (temp[base] || 0) - needSame;

  const upW = BAL.cards?.upgraded?.weapon || {};
  const upA = BAL.cards?.upgraded?.armor || {};
  const aWSet = new Set(Object.values(upW.a || {}));
  const aASet = new Set(Object.values(upA.a || {}));

  function tierRank(card) {
    // base (검/활/마법봉/방패/힐/회피)
    if (BAL.cards.weaponsBase.includes(card) || BAL.cards.armorsBase.includes(card)) return 0;

    // c/b
    if (card === upW.c || card === upA.c) return 1;
    if (card === upW.b || card === upA.b) return 2;

    // a (a검/a활/a방패/a힐 등 실제 매핑 값들)
    if (aWSet.has(card) || aASet.has(card)) return 3;

    // 혹시 모르는 카드(확장 대비)는 맨 뒤
    return 99;
  }

  const candidates = [];
  for (const [k, v] of Object.entries(temp)) {
    if (v <= 0) continue;

    // 동종 필터
    if (type === "weapon") {
      if (!isWeapon(k)) continue;
    } else if (type === "armor") {
      if (!isArmor(k)) continue;
    } else continue;

    candidates.push(k);
  }

  // ✅ 낮은 등급 → 이름순
  candidates.sort((x, y) => {
    const rx = tierRank(x);
    const ry = tierRank(y);
    if (rx !== ry) return rx - ry;
    return x > y ? 1 : x < y ? -1 : 0;
  });

  return candidates.length ? candidates[0] : null;
}

function createInitialState() {
  const deck = makeDeck();
  const open = [];
  for (let i = 0; i < BAL.turnFlow.openSlots; i++) open.push(draw(deck));

  return {
    hp: { A: BAL.hp.start, B: BAL.hp.start },
    turn: "A",
    turnCount: 1,
    pendingTurnBreak: false,

    deck,
    open,

    tokens: { A: { R: 0, B: 0, Y: 0 }, B: { R: 0, B: 0, Y: 0 } },
    hands: { A: [], B: [] },

    equipped: {
      A: { weapon: null, armor: null },
      B: { weapon: null, armor: null }
    },

    turnPhase: { rolled: false, drew: 0, mustTakeOpen: true, refilledOpen: false },

    combat: { active: false, submissions: { A: null, B: null }, resolved: false },

    log: ["방 생성됨. 2명 대기중..."]
  };
}

function computeDerived(state) {
  return {
    counts: { A: countsWithEquipped(state, "A"), B: countsWithEquipped(state, "B") },
    power: {
      A: { weapon: equipPower(state.equipped.A.weapon), armor: equipPower(state.equipped.A.armor) },
      B: { weapon: equipPower(state.equipped.B.weapon), armor: equipPower(state.equipped.B.armor) }
    },
    tokenTotal: { A: tokenSum(state.tokens.A), B: tokenSum(state.tokens.B) }
  };
}

function tryAutoStartCombat(state, playersCount) {
  if (!BAL.combat.autoStart) return;
  if (playersCount < 2) return;

  if (state.combat.active) return;
  if (state.combat.resolved) return;

  if (!state.turnPhase.rolled || state.turnPhase.drew < BAL.turnFlow.drawPerTurn) return;

  if (tokenSum(state.tokens.A) < BAL.combat.minTokenTotalEach) return;
  if (tokenSum(state.tokens.B) < BAL.combat.minTokenTotalEach) return;

  state.combat.active = true;
  state.combat.resolved = false;
  state.combat.submissions = { A: null, B: null };
  state.log.push(`⚔️ 자동 전투 시작! (양쪽 토큰 ${BAL.combat.minTokenTotalEach}+ 충족)`);
}

function resolveCombat(state) {
  const subA = state.combat.submissions.A;
  const subB = state.combat.submissions.B;
  if (!subA || !subB) return;

  // spend tokens (weapon 1 + armor 1)
  state.tokens.A[subA.wColor] -= BAL.combat.spend.weapon;
  state.tokens.A[subA.aColor] -= BAL.combat.spend.armor;
  state.tokens.B[subB.wColor] -= BAL.combat.spend.weapon;
  state.tokens.B[subB.aColor] -= BAL.combat.spend.armor;

  const atkA = equipPower(state.equipped.A.weapon);
  const defA = equipPower(state.equipped.A.armor);
  const atkB = equipPower(state.equipped.B.weapon);
  const defB = equipPower(state.equipped.B.armor);

  const multA = multiplier(subA.wColor, subB.aColor);
  const multB = multiplier(subB.wColor, subA.aColor);

  const baseDmgToB = Math.max(0, atkA - defB);
  const baseDmgToA = Math.max(0, atkB - defA);

  const dmgToB = baseDmgToB * multA;
  const dmgToA = baseDmgToA * multB;

  state.hp.B = Math.max(0, Math.round((state.hp.B - dmgToB) * 10) / 10);
  state.hp.A = Math.max(0, Math.round((state.hp.A - dmgToA) * 10) / 10);

  state.log.push(`⚔️ 전투! A(${subA.wColor}/${subA.aColor}) vs B(${subB.wColor}/${subB.aColor})`);
  state.log.push(`A→B: (공${atkA}-방${defB}=${baseDmgToB})×${multA} = ${dmgToB} 피해`);
  state.log.push(`B→A: (공${atkB}-방${defA}=${baseDmgToA})×${multB} = ${dmgToA} 피해`);
  state.log.push(`HP: A=${state.hp.A}, B=${state.hp.B}`);

  state.combat.active = false;
  state.combat.resolved = true;
  state.combat.submissions = { A: null, B: null };

  refillOpen(state);
  state.turnPhase.refilledOpen = true;
}

function getUpgradeResult(type, tier, base) {
  const up = BAL.cards.upgraded[type];
  if (!up) return null;
  if (tier === "c") return up.c;
  if (tier === "b") return up.b;
  if (tier === "a") return up.a?.[base] || null;
  return null;
}

module.exports = {
  BAL,
  isWeapon,
  isArmor,
  equipPower,
  createInitialState,
  refillOpen,
  draw,
  tokenSum,
  computeDerived,
  tryAutoStartCombat,
  resolveCombat,
  countsWithEquipped,
  removeFromHandOrEquipped,
  pickAnyAfterBase,
  getUpgradeResult
};