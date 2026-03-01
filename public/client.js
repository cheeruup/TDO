const socket = io();

let currentRoomId = null;
let mySeat = null;
let lastState = null;

const WEAPONS = ["검", "마법봉", "활"];
const ARMORS = ["방패", "힐", "회피"];

const $ = (id) => document.getElementById(id);

function renderHand(el, cards) {
  el.textContent = cards.length ? cards.join(", ") : "(비어있음)";
}

function setOptions(selectEl, items) {
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

$("joinBtn").onclick = () => {
  const roomId = $("roomId").value.trim();
  if (!roomId) return alert("room id 입력!");
  socket.emit("join", { roomId });
};

socket.on("joined", ({ roomId, seat }) => {
  currentRoomId = roomId;
  mySeat = seat;
  $("seat").textContent = seat;
});

socket.on("full", ({ message }) => alert(message));

$("rollBtn").onclick = () => socket.emit("roll", { roomId: currentRoomId });
$("takeDeckBtn").onclick = () => socket.emit("takeDeck", { roomId: currentRoomId });
$("endTurnBtn").onclick = () => socket.emit("endTurn", { roomId: currentRoomId });

$("equipBtn").onclick = () => {
  const slot = $("equipSlot").value;
  const card = $("equipCard").value;
  if (!card || card === "(없음)") return;
  socket.emit("equip", { roomId: currentRoomId, slot, card });
};

$("equipSlot").onchange = () => {
  if (!lastState || !mySeat) return;
  updateEquipOptions(lastState);
};

function updateEquipOptions(state) {
  const slot = $("equipSlot").value;
  const hand = state.hands[mySeat] || [];
  let candidates = [];

  if (slot === "weapon") {
    candidates = hand.filter((c) => WEAPONS.includes(c) || ["a검","a마법봉","a활","b무기","c무기"].includes(c));
  } else {
    candidates = hand.filter((c) => ARMORS.includes(c) || ["a방패","a힐","a회피","b방어","c방어"].includes(c));
  }

  candidates = Array.from(new Set(candidates));
  setOptions($("equipCard"), candidates);
}

// upgrade (always attempt; server validates)
$("upType").onchange = () => updateUpgradeBases();
function updateUpgradeBases() {
  const type = $("upType").value;
  const baseList = type === "weapon" ? WEAPONS : ARMORS;
  setOptions($("upBase"), baseList);
}
$("upCBtn").onclick = () => socket.emit("upgrade", { roomId: currentRoomId, type: $("upType").value, tier: "c", base: $("upBase").value });
$("upBBtn").onclick = () => socket.emit("upgrade", { roomId: currentRoomId, type: $("upType").value, tier: "b", base: $("upBase").value });
$("upABtn").onclick = () => socket.emit("upgrade", { roomId: currentRoomId, type: $("upType").value, tier: "a", base: $("upBase").value });

// combat
$("startCombatBtn").onclick = () => socket.emit("startCombat", { roomId: currentRoomId });
$("submitCombatBtn").onclick = () => {
  const wColor = $("combatW").value;
  const aColor = $("combatA").value;
  socket.emit("submitCombat", { roomId: currentRoomId, wColor, aColor });
};

socket.on("state", (state) => {
  lastState = state;

  $("turn").textContent = state.turn;
  $("phase").textContent = `주사위:${state.turnPhase.rolled ? "완료" : "미완료"} / 카드:${state.turnPhase.drew}/2`;

  $("deckCount").textContent = state.deck.length;
  $("openText").textContent = state.open.join(", ");

  $("tokA").textContent = `${state.tokens.A.R}/${state.tokens.A.B}/${state.tokens.A.Y}`;
  $("tokB").textContent = `${state.tokens.B.R}/${state.tokens.B.B}/${state.tokens.B.Y}`;
  $("tokATotal").textContent = state.tokenTotal.A;
  $("tokBTotal").textContent = state.tokenTotal.B;

  $("hpA").textContent = state.hp.A;
  $("hpB").textContent = state.hp.B;

  $("eqAWeapon").textContent = `${state.equipped.A.weapon || "-"} (공 ${state.power.A.weapon})`;
  $("eqAArmor").textContent = `${state.equipped.A.armor || "-"} (방 ${state.power.A.armor})`;
  $("eqBWeapon").textContent = `${state.equipped.B.weapon || "-"} (공 ${state.power.B.weapon})`;
  $("eqBArmor").textContent = `${state.equipped.B.armor || "-"} (방 ${state.power.B.armor})`;

  $("handCountA").textContent = state.hands.A.length;
  $("handCountB").textContent = state.hands.B.length;
  renderHand($("handA"), state.hands.A);
  renderHand($("handB"), state.hands.B);

  $("log").textContent = state.log.slice(-120).join("\n");

  const myTurn = mySeat && state.turn === mySeat;

  $("rollBtn").disabled = !(myTurn && !state.turnPhase.rolled);
  $("takeDeckBtn").disabled = !(myTurn && state.turnPhase.rolled && state.turnPhase.drew >= 1 && state.turnPhase.drew < 2);
  $("endTurnBtn").disabled = !(myTurn && state.turnPhase.rolled && state.turnPhase.drew === 2 && !state.combat.active);

  // open buttons
  const openWrap = $("openButtons");
  openWrap.innerHTML = "";
  state.open.forEach((card, i) => {
    const btn = document.createElement("button");
    btn.textContent = card;
    btn.disabled = !(myTurn && state.turnPhase.rolled && state.turnPhase.drew < 2);
    btn.onclick = () => socket.emit("takeOpen", { roomId: currentRoomId, index: i });
    openWrap.appendChild(btn);
  });

  // equip/upgrade
  $("equipBtn").disabled = !myTurn;
  $("upCBtn").disabled = !myTurn;
  $("upBBtn").disabled = !myTurn;
  $("upABtn").disabled = !myTurn;

  if (mySeat) updateEquipOptions(state);
  updateUpgradeBases();

  // combat start condition
  const canStartCombat =
    myTurn &&
    state.turnPhase.rolled &&
    state.turnPhase.drew === 2 &&
    state.tokenTotal.A >= 3 &&
    state.tokenTotal.B >= 3 &&
    !state.combat.active;

  $("startCombatBtn").disabled = !canStartCombat;

  const panel = $("combatPanel");
  if (state.combat.active) {
    panel.style.display = "block";
    const sub = state.combat.submissions[mySeat];
    $("combatStatus").textContent = sub ? "내 선택 완료(상대 대기)" : "선택 대기중";
    $("submitCombatBtn").disabled = !!sub;
  } else {
    panel.style.display = "none";
  }
});