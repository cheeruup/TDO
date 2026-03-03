// public/client.js

const socket = io();

let currentRoomId = null;
let mySeat = null; // "A" | "B" | "S"
let lastState = null;
let BAL = null;

const $ = (id) => document.getElementById(id);

const BASE_ICONS = {
  "검": "⚔️",
  "활": "🏹",
  "마법봉": "🔮",
  "힐": "💊",
  "방패": "🛡️",
  "회피": "👟"
};

let UPGRADE_DEFS = [];
let upgradeUIBuilt = false;

function makeBadgeIcon(emoji, badgeClass) {
  const span = document.createElement("span");
  span.className = `iconBadge ${badgeClass}`;
  span.textContent = emoji;
  return span;
}

function makeCardIconEl(cardName) {
  if (typeof cardName === "string" && cardName.startsWith("a")) {
    const base = cardName.slice(1);
    const em = BASE_ICONS[base] || "⭐";
    return makeBadgeIcon(em, "a");
  }

  if (cardName === "b무기") return makeBadgeIcon("💍", "bYellow");
  if (cardName === "c무기") return makeBadgeIcon("💍", "cBlue");
  if (cardName === "b방어") return makeBadgeIcon("📿", "bYellow");
  if (cardName === "c방어") return makeBadgeIcon("📿", "cBlue");

  if (BASE_ICONS[cardName]) {
    const span = document.createElement("span");
    span.className = "cardIcon";
    span.textContent = BASE_ICONS[cardName];
    span.title = cardName;
    return span;
  }

  const t = document.createElement("span");
  t.textContent = cardName;
  return t;
}

function setEquipValue(el, label, item, power) {
  if (!el) return;
  el.innerHTML = "";

  const p = Number.isFinite(power) ? power : 0;

  if (item) {
    el.appendChild(makeCardIconEl(item));
    const gap = document.createElement("span");
    gap.textContent = " ";
    el.appendChild(gap);
  }

  const txt = document.createElement("span");
  txt.textContent = `${label} ${p}`;
  el.appendChild(txt);

  el.title = item ? item : `${label} 없음`;
}

function computeSides() {
  if (mySeat === "A") return { left: "A", right: "B" };
  if (mySeat === "B") return { left: "B", right: "A" };
  return { left: "A", right: "B" };
}

/* ----------------- 카드 타입 판별 ----------------- */

function isWeaponCard(card) {
  if (!BAL) return false;
  const wBase = BAL.cards.weaponsBase || [];
  const up = BAL.cards.upgraded?.weapon || {};
  const aMap = up.a || {};
  const weaponSet = new Set([...wBase, up.c, up.b, ...Object.values(aMap)]);
  return weaponSet.has(card);
}

function isArmorCard(card) {
  if (!BAL) return false;
  const aBase = BAL.cards.armorsBase || [];
  const up = BAL.cards.upgraded?.armor || {};
  const aMap = up.a || {};
  const armorSet = new Set([...aBase, up.c, up.b, ...Object.values(aMap)]);
  return armorSet.has(card);
}

/* ----------------- 렌더링 ----------------- */

function renderTokens(el, tokens) {
  if (!el) return;
  el.innerHTML = "";

  const order = ["R", "B", "Y"];
  const cls = { R: "r", B: "b", Y: "y" };

  for (const c of order) {
    const n = tokens?.[c] || 0;
    const grp = document.createElement("span");
    grp.className = "tokgrp";

    const dot = document.createElement("span");
    dot.className = `dot ${cls[c]}`;

    const txt = document.createElement("span");
    txt.textContent = `${c}×${n}`;

    grp.appendChild(dot);
    grp.appendChild(txt);
    el.appendChild(grp);
  }
}

function renderHand(el, hand, seat, isMyTurn) {
  if (!el) return;
  el.innerHTML = "";

  if (!hand || hand.length === 0) {
    const t = document.createElement("div");
    t.className = "emptyText";
    t.textContent = "(없음)";
    el.appendChild(t);
    return;
  }

  const clickable = !!(mySeat && (mySeat === "A" || mySeat === "B") && seat === mySeat && isMyTurn && currentRoomId);

  const sorted = [...hand].sort((a, b) => (a > b ? 1 : -1));
  for (const c of sorted) {
    const chip = document.createElement("span");
    chip.className = "cardChip";
    chip.title = c;
    chip.appendChild(makeCardIconEl(c));

    if (clickable) {
      chip.classList.add("clickable");
      chip.onclick = () => {
        const slot = isWeaponCard(c) ? "weapon" : isArmorCard(c) ? "armor" : null;
        if (!slot) return;
        socket.emit("equip", { roomId: currentRoomId, slot, card: c });
      };
    }

    el.appendChild(chip);
  }
}

/* ----------------- 업글 로직 (핵심 수정) ----------------- */

/**
 * ✅ 특정 base로 업글 가능 여부 체크
 * - same: base 같은 카드 N장
 * - any: 동종(weapon/armor) 아무 카드 1장 (엔진에서 실제로 소모)
 *
 * state.counts 는 "손패+착용" 합산된 개수(서버 derived)를 사용
 */
function canUpgradeWithBase(state, seat, type, tier, base) {
  if (!BAL) return false;
  if (!seat) return false;

  const rule = BAL.upgradeRules?.[tier];
  if (!rule) return false;

  const counts = state.counts?.[seat] || {};
  const needSame = rule.same || 0;
  const needAny = (rule.any ?? 0);

  if (!base) return false;
  if ((counts[base] || 0) < needSame) return false;

  if (needAny === 0) return true;

  // base를 needSame만큼 먼저 소모했다고 가정
  const temp = { ...counts };
  temp[base] = (temp[base] || 0) - needSame;

  // ✅ 남은 카드들 중 "동종" 카드가 1장이라도 있으면 OK
  for (const [card, v] of Object.entries(temp)) {
    if (v <= 0) continue;

    if (type === "weapon") {
      if (isWeaponCard(card)) return true;
    } else if (type === "armor") {
      if (isArmorCard(card)) return true;
    }
  }

  return false;
}

/**
 * ✅ b/c 업글은 base가 "자동 선택"이어야 함.
 * 가능한 base들을 돌면서 1) 등급 낮은 base 우선 2) 이름순으로 고른다.
 *
 * (검/마법봉/활) or (방패/힐/회피) 중에서 조건 만족하는 base를 고름
 */
function pickUpgradeBase(state, seat, type, tier) {
  if (!BAL) return null;

  const basePool = type === "weapon" ? (BAL.cards.weaponsBase || []) : (BAL.cards.armorsBase || []);
  const sorted = [...basePool].sort((a, b) => (a > b ? 1 : -1)); // 재현성

  for (const b of sorted) {
    if (canUpgradeWithBase(state, seat, type, tier, b)) return b;
  }
  return null;
}

/**
 * ✅ 업글 가능 체크 (UI용)
 * - a 업글: base가 고정(검/마법봉/활 등)
 * - b/c 업글: base가 null로 들어오므로 자동 선택 가능한지만 본다
 */
function canUpgrade(state, seat, type, tier, baseOrNull) {
  if (baseOrNull) return canUpgradeWithBase(state, seat, type, tier, baseOrNull);
  const picked = pickUpgradeBase(state, seat, type, tier);
  return !!picked;
}

function buildUpgradeDefsFixedOrder() {
  if (!BAL) return;

  const wa = BAL.cards.upgraded?.weapon?.a || {};
  const aa = BAL.cards.upgraded?.armor?.a || {};

  UPGRADE_DEFS = [
    // a는 베이스 고정
    { id: "up_a_weapon_검", card: wa["검"], type: "weapon", tier: "a", base: "검" },
    { id: "up_a_weapon_마법봉", card: wa["마법봉"], type: "weapon", tier: "a", base: "마법봉" },
    { id: "up_a_weapon_활", card: wa["활"], type: "weapon", tier: "a", base: "활" },

    // ✅ b/c는 base 자동 선택 (null)
    { id: "up_b_weapon", card: BAL.cards.upgraded?.weapon?.b, type: "weapon", tier: "b", base: null },
    { id: "up_c_weapon", card: BAL.cards.upgraded?.weapon?.c, type: "weapon", tier: "c", base: null },

    // a는 베이스 고정
    { id: "up_a_armor_방패", card: aa["방패"], type: "armor", tier: "a", base: "방패" },
    { id: "up_a_armor_힐", card: aa["힐"], type: "armor", tier: "a", base: "힐" },
    { id: "up_a_armor_회피", card: aa["회피"], type: "armor", tier: "a", base: "회피" },

    // ✅ b/c는 base 자동 선택 (null)
    { id: "up_b_armor", card: BAL.cards.upgraded?.armor?.b, type: "armor", tier: "b", base: null },
    { id: "up_c_armor", card: BAL.cards.upgraded?.armor?.c, type: "armor", tier: "c", base: null }
  ].filter(d => !!d.card);
}

function renderUpgradeButtons() {
  const wrap = $("upgradeButtons");
  if (!wrap) return;
  wrap.innerHTML = "";

  for (const d of UPGRADE_DEFS) {
    const btn = document.createElement("button");
    btn.className = "upBtn";
    btn.id = d.id;
    btn.title = d.card;
    btn.appendChild(makeCardIconEl(d.card));

    btn.onclick = () => {
      if (!currentRoomId || !lastState || !BAL) return;
      if (!(mySeat === "A" || mySeat === "B")) return;
      if (btn.disabled) return;

      const myTurn = (lastState.turn === mySeat);
      if (!myTurn) return;

      // ✅ base 결정: a는 고정, b/c는 자동 선택
      const baseToUse = d.base || pickUpgradeBase(lastState, mySeat, d.type, d.tier);
      if (!baseToUse) return;

      if (!canUpgradeWithBase(lastState, mySeat, d.type, d.tier, baseToUse)) return;

      socket.emit("upgrade", { roomId: currentRoomId, type: d.type, tier: d.tier, base: baseToUse });
    };

    wrap.appendChild(btn);
  }

  upgradeUIBuilt = true;
}

function refreshUpgradeButtons(state) {
  if (!state || !BAL) return;

  const isPlayer = (mySeat === "A" || mySeat === "B");
  const myTurn = isPlayer && (state.turn === mySeat);

  for (const d of UPGRADE_DEFS) {
    const btn = document.getElementById(d.id);
    if (!btn) continue;
    btn.disabled = !(myTurn && canUpgrade(state, mySeat, d.type, d.tier, d.base));
  }
}

function renderHUD(state) {
  const { left, right } = computeSides();

  if ($("leftBadge")) $("leftBadge").textContent = left;
  if ($("rightBadge")) $("rightBadge").textContent = right;

  const maxHp = BAL?.hp?.max ?? 20;
  const leftHp = state.hp?.[left] ?? 0;
  const rightHp = state.hp?.[right] ?? 0;

  if ($("leftHp")) $("leftHp").textContent = leftHp;
  if ($("rightHp")) $("rightHp").textContent = rightHp;

  if ($("leftHpFill")) $("leftHpFill").style.width = `${Math.max(0, Math.min(100, (leftHp / maxHp) * 100))}%`;
  if ($("rightHpFill")) $("rightHpFill").style.width = `${Math.max(0, Math.min(100, (rightHp / maxHp) * 100))}%`;

  const pLeftW = state.power?.[left]?.weapon ?? 0;
  const pLeftA = state.power?.[left]?.armor ?? 0;
  const pRightW = state.power?.[right]?.weapon ?? 0;
  const pRightA = state.power?.[right]?.armor ?? 0;

  setEquipValue($("leftArmor"), "방어", state.equipped?.[left]?.armor || null, pLeftA);
  setEquipValue($("leftWeapon"), "무기", state.equipped?.[left]?.weapon || null, pLeftW);
  setEquipValue($("rightArmor"), "방어", state.equipped?.[right]?.armor || null, pRightA);
  setEquipValue($("rightWeapon"), "무기", state.equipped?.[right]?.weapon || null, pRightW);

  renderTokens($("leftTokens"), state.tokens?.[left]);
  renderTokens($("rightTokens"), state.tokens?.[right]);

  const isMyTurn = !!(mySeat && (mySeat === "A" || mySeat === "B") && state.turn === mySeat);
  renderHand($("leftHand"), state.hands?.[left] || [], left, isMyTurn);
  renderHand($("rightHand"), state.hands?.[right] || [], right, isMyTurn);
}

/* ----------------- events ----------------- */

$("joinBtn")?.addEventListener("click", () => {
  const roomId = $("roomId")?.value.trim();
  if (!roomId) return alert("room id 입력!");
  socket.emit("join", { roomId });
});

socket.on("joined", ({ roomId, seat }) => {
  currentRoomId = roomId;
  mySeat = seat;
});

socket.on("full", ({ message }) => alert(message));

$("rollBtn")?.addEventListener("click", () => socket.emit("roll", { roomId: currentRoomId }));
$("takeDeckBtn")?.addEventListener("click", () => socket.emit("takeDeck", { roomId: currentRoomId }));
$("endTurnBtn")?.addEventListener("click", () => socket.emit("endTurn", { roomId: currentRoomId }));

$("submitCombatBtn")?.addEventListener("click", () => {
  const wColor = $("combatW")?.value;
  const aColor = $("combatA")?.value;
  socket.emit("submitCombat", { roomId: currentRoomId, wColor, aColor });
});

socket.on("state", (state) => {
  lastState = state;
  if (state.balance) BAL = state.balance;

  if (BAL && !upgradeUIBuilt) {
    buildUpgradeDefsFixedOrder();
    renderUpgradeButtons();
  }

  const isPlayer = (mySeat === "A" || mySeat === "B");
  const myTurn = isPlayer && state.turn === mySeat;
  const drawPerTurn = BAL?.turnFlow?.drawPerTurn ?? 2;

  if ($("rollBtn")) $("rollBtn").disabled = !(myTurn && !state.turnPhase.rolled);
  if ($("takeDeckBtn")) $("takeDeckBtn").disabled = !(myTurn && state.turnPhase.rolled && state.turnPhase.drew >= 1 && state.turnPhase.drew < drawPerTurn);
  if ($("endTurnBtn")) $("endTurnBtn").disabled = !(myTurn && state.turnPhase.rolled && state.turnPhase.drew === drawPerTurn && !state.combat.active);

  const openWrap = $("openButtons");
  if (openWrap) {
    openWrap.innerHTML = "";
    (state.open || []).forEach((card, i) => {
      if (!card) return;

      const btn = document.createElement("button");
      btn.disabled = !(myTurn && state.turnPhase.rolled && state.turnPhase.drew < drawPerTurn);
      btn.title = card;
      btn.appendChild(makeCardIconEl(card));
      btn.onclick = () => socket.emit("takeOpen", { roomId: currentRoomId, index: i });
      openWrap.appendChild(btn);
    });
  }

  refreshUpgradeButtons(state);

  const panel = $("combatPanel");
  if (panel) {
    if (state.combat.active) {
      panel.style.display = "block";
      const sub = state.combat.submissions?.[mySeat];
      if ($("combatStatus")) $("combatStatus").textContent = sub ? "완료" : "-";
      if ($("submitCombatBtn")) $("submitCombatBtn").disabled = !!sub || !isPlayer;
    } else {
      panel.style.display = "none";
    }
  }

  if (BAL) renderHUD(state);

  if ($("log")) $("log").textContent = state.log.slice(-180).reverse().join("\n");
});