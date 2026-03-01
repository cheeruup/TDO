const socket = io();
let currentRoomId = null;
let mySeat = null;

const $ = (id) => document.getElementById(id);

$("joinBtn").onclick = () => {
  const roomId = $("roomId").value.trim();
  if (!roomId) return alert("room id 입력!");
  socket.emit("join", { roomId });
};

$("rollBtn").onclick = () => socket.emit("roll", { roomId: currentRoomId });
$("take2Btn").onclick = () => socket.emit("take2", { roomId: currentRoomId });
$("endTurnBtn").onclick = () => socket.emit("endTurn", { roomId: currentRoomId });

socket.on("joined", ({ roomId, seat }) => {
  currentRoomId = roomId;
  mySeat = seat;
  $("seat").textContent = seat;
  $("room").textContent = roomId;
});

socket.on("full", ({ message }) => alert(message));

socket.on("state", (state) => {
  $("turn").textContent = state.turn;
  $("hpA").textContent = state.hp.A;
  $("hpB").textContent = state.hp.B;
  $("open").textContent = state.open.join(", ");

  $("tokA").textContent = `${state.tokens.A.R}/${state.tokens.A.B}/${state.tokens.A.Y}`;
  $("tokB").textContent = `${state.tokens.B.R}/${state.tokens.B.B}/${state.tokens.B.Y}`;

  $("handA").textContent = state.handCount.A;
  $("handB").textContent = state.handCount.B;

  $("log").textContent = state.log.slice(-40).join("\n");

  const myTurn = mySeat && state.turn === mySeat;
  $("rollBtn").disabled = !myTurn;
  $("take2Btn").disabled = !myTurn;
  $("endTurnBtn").disabled = !myTurn;
});