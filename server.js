const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Render/프록시 환경에서도 무난하게 동작하도록 CORS를 느슨하게
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
});

app.use(express.static("public"));

/**
 * 프로토타입용: 방/상태를 서버 메모리에만 저장
 * (서버 재시작하면 초기화됨)
 */
const rooms = {};

function createRoom(roomId) {
  rooms[roomId] = {
    players: [],
    state: {
      hp: { A: 20, B: 20 },
      turn: "A",
      open: ["검", "방패", "활"], // 프로토타입: 고정. (나중에 덱에서 뽑게 바꾸기)
      tokens: { A: { R: 0, B: 0, Y: 0 }, B: { R: 0, B: 0, Y: 0 } },
      handCount: { A: 0, B: 0 },
      log: ["방 생성됨. 2명 입장 대기..."],
    },
  };
}

function seatOf(room, socketId) {
  const idx = room.players.indexOf(socketId);
  return idx === 0 ? "A" : idx === 1 ? "B" : null;
}

function broadcast(roomId) {
  io.to(roomId).emit("state", rooms[roomId].state);
}

io.on("connection", (socket) => {
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

  // 프로토타입 액션: 주사위 굴리기(토큰 +1)
  socket.on("roll", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seat = seatOf(room, socket.id);
    if (!seat || room.state.turn !== seat) return;

    // 1~6: R,R,B,B,Y,Y
    const r = Math.floor(Math.random() * 6) + 1;
    const color = r <= 2 ? "R" : r <= 4 ? "B" : "Y";
    room.state.tokens[seat][color] += 1;
    room.state.log.push(`${seat} 주사위: ${color} +1`);
    broadcast(roomId);
  });

  // 프로토타입 액션: 카드 2장 획득(손패 카운트 +2)
  // (최소 구현이라 실제 카드 종류는 아직 안 추적)
  socket.on("take2", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seat = seatOf(room, socket.id);
    if (!seat || room.state.turn !== seat) return;

    room.state.handCount[seat] += 2;
    room.state.log.push(`${seat} 카드 2장 획득 (오픈≥1 조건은 UI에서 다음 단계에 반영)`);
    broadcast(roomId);
  });

  // 턴 종료
  socket.on("endTurn", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seat = seatOf(room, socket.id);
    if (!seat || room.state.turn !== seat) return;

    room.state.turn = seat === "A" ? "B" : "A";
    room.state.log.push(`${seat} 턴 종료 → ${room.state.turn} 턴`);
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