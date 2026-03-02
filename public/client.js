const socket = io();

let currentRoomId = null;
let mySeat = null;
let lastState = null;
let BAL = null; // state.balance 저장

const $ = (id) => document.getElementById(id);

function setOptions(selectEl, items) {
  if (!selectEl) return;
  const prev = selectEl.value;
  selectEl.innerHTML = "";
  for (const it of items) {
    const opt = document.createElement("option");
    opt.value = it;
    opt.textContent = it;
    selectEl.appendChild(opt);
  }
  if (items.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(없음)";
    selectEl.appendChild(opt);
  }
  if (items.includes(prev)) selectEl.value = prev;
}

function computeSides() {
  if (mySeat === "A") return { left: "A", right: "B" };
  if (mySeat === "B") return { left: "B", right: "A" };
  return { left: "A", right: "B" };
}

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

function updateEquipOptions(state) {
  if (!BAL || !mySeat) return;

  const slot = $("equipSlot")?.value;
  const hand = state.hands?.[mySeat] || [];

  let candidates = [];
  if (slot === "weapon") candidates = hand.filter(isWeaponCard);
  else candidates = hand.filter(isArmorCard);

  candidates = Array.from(new Set(candidates));
  setOptions($("equipCard"), candidates);
}

function updateUpgradeBases() {
  if (!BAL) return;
  const type = $("upType")?.value;
  const baseList = type === "weapon" ? (BAL.cards.weaponsBase || []) : (BAL.cards.armorsBase || []);
  setOptions($("upBase"), baseList);
}

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

function renderHand(el, hand) {
  if (!el) return;
  el.innerHTML = "";
  if (!hand || hand.length === 0) {
    const t = document.createElement("div");
    t.className = "emptyText";
    t.textContent = "(없음)";
    el.appendChild(t);
    return;
  }

  const sorted = [...hand].sort((a, b) => (a > b ? 1 : -1));
  for (const c of sorted) {
    const chip = document.createElement("span");
    chip.className = "cardChip";
    chip.textContent = c;
    el.appendChild(chip);
  }
}

function renderHUD(state) {
  const { left, right } = computeSides();

  if ($("leftBadge")) $("leftBadge").textContent = left;
  if ($("rightBadge")) $("rightBadge").textContent = right;
  if ($("leftName")) $("leftName").textContent = left === mySeat ? "YOU" : "OPPONENT";
  if ($("rightName")) $("rightName").textContent = right === mySeat ? "YOU" : "OPPONENT";

  const maxHp = BAL?.hp?.max ?? 20;
  const leftHp = state.hp?.[left] ?? 0;
  const rightHp = state.hp?.[right] ?? 0;

  if ($("leftHp")) $("leftHp").textContent = leftHp;
  if ($("rightHp")) $("rightHp").textContent = rightHp;

  if ($("leftHpFill")) $("leftHpFill").style.width = `${Math.max(0, Math.min(100, (leftHp / maxHp) * 100))}%`;
  if ($("rightHpFill")) $("rightHpFill").style.width = `${Math.max(0, Math.min(100, (rightHp / maxHp) * 100))}%`;

  if ($("leftWeapon")) $("leftWeapon").textContent = state.equipped?.[left]?.weapon || "-";
  if ($("leftArmor")) $("leftArmor").textContent = state.equipped?.[left]?.armor || "-";
  if ($("rightWeapon")) $("rightWeapon").textContent = state.equipped?.[right]?.weapon || "-";
  if ($("rightArmor")) $("rightArmor").textContent = state.equipped?.[right]?.armor || "-";

  renderTokens($("leftTokens"), state.tokens?.[left]);
  renderTokens($("rightTokens"), state.tokens?.[right]);

  if ($("leftTokTotal")) $("leftTokTotal").textContent = state.tokenTotal?.[left] ?? 0;
  if ($("rightTokTotal")) $("rightTokTotal").textContent = state.tokenTotal?.[right] ?? 0;

  const leftHand = state.hands?.[left] || [];
  const rightHand = state.hands?.[right] || [];

  if ($("leftHandCount")) $("leftHandCount").textContent = leftHand.length;
  if ($("rightHandCount")) $("rightHandCount").textContent = rightHand.length;

  renderHand($("leftHand"), leftHand);
  renderHand($("rightHand"), rightHand);
}

// 업글 가능 여부(클라 계산용): state.counts(손패+착용 포함) 기반
function canUpgrade(state, seat, type, tier, base) {
  if (!BAL) return false;
  if (!seat) return false;

  const rule = BAL.upgradeRules?.[tier];
  if (!rule) return false;

  const counts = state.counts?.[seat] || {};
  const needSame = rule.same || 0;
  const needAny = rule.anySameType || 0;

  if (!base) return false;
  if ((counts[base] || 0) < needSame) return false;

  if (needAny === 0) return true;

  // base needSame만큼 제외하고 남은 카드 중 동종 1장 있는지
  const temp = { ...counts };
  temp[base] = (temp[base] || 0) - needSame;

  const wantWeapon = type === "weapon";
  for (const [k, v] of Object.entries(temp)) {
    if (v <= 0) continue;
    if (wantWeapon && isWeaponCard(k)) return true;
    if (!wantWeapon && isArmorCard(k)) return true;
  }
  return false;
}

// ✅ 버튼 상태를 즉시 재계산 (업글 버튼 활성화 핵심)
function refreshButtons(state) {
  if (!state || !BAL || !mySeat) return;

  const myTurn = state.turn === mySeat;

  // 장착 버튼
  const equipCard = $("equipCard")?.value;
  if ($("equipBtn")) $("equipBtn").disabled = !(myTurn && equipCard && equipCard !== "(없음)");

  // 업글 버튼 (주사위 굴림 여부와 무관하게 "내 턴 + 재료"면 가능)
  const upType = $("upType")?.value;
  const upBase = $("upBase")?.value;

  if ($("upCBtn")) $("upCBtn").disabled = !(myTurn && canUpgrade(state, mySeat, upType, "c", upBase));
  if ($("upBBtn")) $("upBBtn").disabled = !(myTurn && canUpgrade(state, mySeat, upType, "b", upBase));
  if ($("upABtn")) $("upABtn").disabled = !(myTurn && canUpgrade(state, mySeat, upType, "a", upBase));
}

$("joinBtn")?.addEventListener("click", () => {
  const roomId = $("roomId")?.value.trim();
  if (!roomId) return alert("room id 입력!");
  socket.emit("join", { roomId });
});

socket.on("joined", ({ roomId, seat }) => {
  currentRoomId = roomId;
  mySeat = seat;
  if ($("seat")) $("seat").textContent = seat;

  // 좌석 확정되면 버튼 상태도 다시 계산될 수 있게
  if (lastState) refreshButtons(lastState);
});

socket.on("full", ({ message }) => alert(message));

$("rollBtn")?.addEventListener("click", () => socket.emit("roll", { roomId: currentRoomId }));
$("takeDeckBtn")?.addEventListener("click", () => socket.emit("takeDeck", { roomId: currentRoomId }));
$("endTurnBtn")?.addEventListener("click", () => socket.emit("endTurn", { roomId: currentRoomId }));

$("equipBtn")?.addEventListener("click", () => {
  const slot = $("equipSlot")?.value;
  const card = $("equipCard")?.value;
  if (!card || card === "(없음)") return;
  socket.emit("equip", { roomId: currentRoomId, slot, card });
});

$("equipSlot")?.addEventListener("change", () => {
  if (!lastState) return;
  updateEquipOptions(lastState);
  refreshButtons(lastState);
});

$("equipCard")?.addEventListener("change", () => {
  if (lastState) refreshButtons(lastState);
});

// ✅ upType 바꾸면 upBase도 바뀌고, 버튼도 즉시 반영
$("upType")?.addEventListener("change", () => {
  updateUpgradeBases();
  if (lastState) refreshButtons(lastState);
});

// ✅ upBase 바꾸면 버튼 즉시 반영
$("upBase")?.addEventListener("change", () => {
  if (lastState) refreshButtons(lastState);
});

$("upCBtn")?.addEventListener("click", () => socket.emit("upgrade", { roomId: currentRoomId, type: $("upType").value, tier: "c", base: $("upBase").value }));
$("upBBtn")?.addEventListener("click", () => socket.emit("upgrade", { roomId: currentRoomId, type: $("upType").value, tier: "b", base: $("upBase").value }));
$("upABtn")?.addEventListener("click", () => socket.emit("upgrade", { roomId: currentRoomId, type: $("upType").value, tier: "a", base: $("upBase").value }));

$("submitCombatBtn")?.addEventListener("click", () => {
  const wColor = $("combatW")?.value;
  const aColor = $("combatA")?.value;
  socket.emit("submitCombat", { roomId: currentRoomId, wColor, aColor });
});

socket.on("state", (state) => {
  lastState = state;

  // ✅ 서버에서 밸런스 수신
  if (state.balance) BAL = state.balance;

  // 상단 바
  if ($("turn")) $("turn").textContent = state.turn;
  if ($("phase")) $("phase").textContent = `주사위:${state.turnPhase.rolled ? "완료" : "미완료"} / 카드:${state.turnPhase.drew}/${BAL?.turnFlow?.drawPerTurn ?? 2}`;
  if ($("deckCount")) $("deckCount").textContent = state.deck.length;

  const myTurn = mySeat && state.turn === mySeat;
  const drawPerTurn = BAL?.turnFlow?.drawPerTurn ?? 2;

  // 기존 턴 진행 버튼(규칙 반영: 주사위/드로우 기반)
  if ($("rollBtn")) $("rollBtn").disabled = !(myTurn && !state.turnPhase.rolled);
  if ($("takeDeckBtn")) $("takeDeckBtn").disabled = !(myTurn && state.turnPhase.rolled && state.turnPhase.drew >= 1 && state.turnPhase.drew < drawPerTurn);
  if ($("endTurnBtn")) $("endTurnBtn").disabled = !(myTurn && state.turnPhase.rolled && state.turnPhase.drew === drawPerTurn && !state.combat.active);

  // 오픈 카드 버튼
  const openWrap = $("openButtons");
  if (openWrap) {
    openWrap.innerHTML = "";
    (state.open || []).forEach((card, i) => {
      if (!card) return;
      const btn = document.createElement("button");
      btn.textContent = card;
      btn.disabled = !(myTurn && state.turnPhase.rolled && state.turnPhase.drew < drawPerTurn);
      btn.onclick = () => socket.emit("takeOpen", { roomId: currentRoomId, index: i });
      openWrap.appendChild(btn);
    });
  }

  // 장착/업글 옵션 구성
  updateUpgradeBases();
  updateEquipOptions(state);

  // ✅ 장착/업글 버튼 상태 즉시 계산(핵심)
  refreshButtons(state);

  // 전투 패널
  const panel = $("combatPanel");
  if (panel) {
    if (state.combat.active) {
      panel.style.display = "block";
      const sub = state.combat.submissions?.[mySeat];
      if ($("combatStatus")) $("combatStatus").textContent = sub ? "내 선택 완료(상대 대기)" : "선택 대기중";
      if ($("submitCombatBtn")) $("submitCombatBtn").disabled = !!sub;
    } else {
      panel.style.display = "none";
    }
  }

  // HUD
  if (BAL) renderHUD(state);

  // 로그
  if ($("log")) $("log").textContent = state.log.slice(-180).join("\n");
});